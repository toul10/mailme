import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { appState, extractions, mailboxes, messages, organizations } from "../db/schema.js";
import { BUDGET_PAUSE_REASONS, GLOBAL_PAUSE_KEY, type Clock, type ExtractionInput, type Extractor, type ExtractorResult, type HandleMap, type Logger } from "../domain/types.js";
import { STREAM_DEADLINE_ERROR } from "../ai/claude.js";
import { truncate } from "../lib/text.js";
import { closeAnsweredTasks } from "./answered.js";
import { ApplyError, applyExtraction, wakeUntilReplySnoozes, type ApplyResult } from "./apply.js";
import { ContextError, buildExtractionContext } from "./context.js";
import { isTransientDbError, localDayStart, pgErrorCode } from "./db-util.js";

export interface PipelineDeps {
  db: Db;
  /** Wired to withSessionLock(handle, key, fn) from src/db/client.ts. Key: "drain:" + mailboxId. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
  extractor: Extractor;
  clock: Clock;
  log: Logger;
  config: Pick<Config, "SETTLE_SEC" | "AI_DAILY_CALL_CAP" | "AI_DAILY_USD_CAP">;
}

export interface DrainReport {
  mailboxId: string;
  processed: number;
  extracted: number;
  applied: number;
  parked: number;
  transientBackoff: boolean;
  globalPause: boolean;
  budgetPaused: boolean;
  lockBusy: boolean;
  /** Tasks the owner's «answered» rule completed after the drain (src/engine/answered.ts); absent when none. */
  answered?: number;
  /** Requests the same sweep handed over to a colleague (the owner forwarded them); absent when none. */
  handedOver?: number;
}

export { GLOBAL_PAUSE_KEY, BUDGET_PAUSE_REASONS };

export interface GlobalPauseValue {
  reason: "extractor" | "internal_error" | string;
  at: string;
  mailboxId?: string;
  messageId?: string;
  error?: string;
}


/** Transient-error backoff: 30 s doubling per attempt, capped at 30 min. */
export function backoffSec(attempts: number): number {
  return Math.min(1800, 30 * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}

/** Seams for tests: context builder and apply (e.g. with a fake reconciler). */
export interface DrainInternals {
  buildContext(db: Db, messageId: string): Promise<{ input: ExtractionInput; handleMap: HandleMap }>;
  apply(db: Db, messageId: string, extractionId: string, clock: Clock): Promise<ApplyResult>;
}

/**
 * Advisory-locked drain of one mailbox's queue in (sort_ts, id) order, honouring the settle window,
 * reuse of existing extractions, error classes (transient/per-message/global) and the AI budget.
 * `fullCycleAt`: time of the last complete sync cycle — messages first seen after it are not yet eligible.
 */
export async function drainMailbox(deps: PipelineDeps, mailboxId: string, opts: { maxMessages?: number; fullCycleAt?: Date | null } = {}): Promise<DrainReport> {
  return drainMailboxWith(deps, mailboxId, opts, { buildContext: buildExtractionContext, apply: applyExtraction });
}

export async function drainMailboxWith(
  deps: PipelineDeps,
  mailboxId: string,
  opts: { maxMessages?: number; fullCycleAt?: Date | null },
  internals: DrainInternals,
): Promise<DrainReport> {
  const report: DrainReport = {
    mailboxId,
    processed: 0,
    extracted: 0,
    applied: 0,
    parked: 0,
    transientBackoff: false,
    globalPause: false,
    budgetPaused: false,
    lockBusy: false,
  };
  const res = await deps.withLock("drain:" + mailboxId, async () => {
    await drainLoop(deps, mailboxId, opts, internals, report);
    // The «answered» sweep, under the same lock as apply: after new mail, else at most every ANSWERED_SWEEP_MS.
    const last = lastAnsweredSweep.get(mailboxId);
    const now = deps.clock.now().getTime();
    if (report.applied > 0 || last === undefined || now - last >= ANSWERED_SWEEP_MS) {
      lastAnsweredSweep.set(mailboxId, now);
      const { closed, handedOver } = await closeAnsweredTasks(deps, mailboxId);
      if (closed) report.answered = closed;
      if (handedOver) report.handedOver = handedOver;
    }
  });
  if (!res.acquired) report.lockBusy = true;
  deps.log.debug({ ...report }, "drain finished");
  return report;
}

/** Per process: when each mailbox's «answered» sweep last ran (the first drain after a start always runs it). */
const lastAnsweredSweep = new Map<string, number>();
const ANSWERED_SWEEP_MS = 10 * 60_000;

const HEAD_COLUMNS = {
  id: messages.id,
  mailboxId: messages.mailboxId,
  state: messages.state,
  sortTs: messages.sortTs,
  firstSeenAt: messages.firstSeenAt,
  nextAttemptAt: messages.nextAttemptAt,
  attempts: messages.attempts,
  direction: messages.direction,
  threadId: messages.threadId,
  inReplyTo: messages.inReplyTo,
  backfill: messages.backfill,
};
type Head = Pick<typeof messages.$inferSelect, keyof typeof HEAD_COLUMNS>;
type MailboxRow = Pick<typeof mailboxes.$inferSelect, "id" | "orgId" | "status" | "aiPaused" | "aiPausedReason" | "aiDailyCallCap" | "aiDailyUsdCap" | "createdAt">;
type Step = "done" | "again" | "stop";

const DEFAULT_ZONE = "Europe/Athens";
/** Bound on the In-Reply-To walk from a queued reply up to its oldest still-queued ancestor. */
const MAX_REPLY_CHAIN_HOPS = 20;
/** A message whose extraction ran past the stream deadline this many times is parked as PER_MESSAGE. */
export const MAX_DEADLINE_ATTEMPTS = 3;

/**
 * «Inside a thread, reply-chain order wins»: when the queue head is a reply whose In-Reply-To parent
 * (same mailbox) is still queued (pending/extracted) — e.g. a Sent copy with a skewed Date or a late APPEND — the
 * parent (and its own queued parent…) is processed first, whatever their sort_ts. The returned head is then subject
 * to the usual settle/cycle/backoff checks, so the reply waits for its parent.
 */
async function replyChainHead(db: Db, mailboxId: string, head: Head): Promise<Head> {
  const seen = new Set<string>([head.id]);
  let cur = head;
  for (let hop = 0; hop < MAX_REPLY_CHAIN_HOPS && cur.inReplyTo; hop++) {
    const [parent] = await db
      .select(HEAD_COLUMNS)
      .from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, cur.inReplyTo), inArray(messages.state, ["pending", "extracted"])))
      .orderBy(asc(messages.sortTs), asc(messages.id))
      .limit(1);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}

async function drainLoop(deps: PipelineDeps, mailboxId: string, opts: { maxMessages?: number; fullCycleAt?: Date | null }, internals: DrainInternals, report: DrainReport): Promise<void> {
  const { db } = deps;
  const max = opts.maxMessages ?? Number.POSITIVE_INFINITY;
  const reextracted = new Set<string>();
  while (report.processed < max) {
    const now = deps.clock.now();
    if (await isGloballyPaused(db)) {
      report.globalPause = true;
      return;
    }
    const [mb] = await db
      .select({
        id: mailboxes.id,
        orgId: mailboxes.orgId,
        status: mailboxes.status,
        aiPaused: mailboxes.aiPaused,
        aiPausedReason: mailboxes.aiPausedReason,
        aiDailyCallCap: mailboxes.aiDailyCallCap,
        aiDailyUsdCap: mailboxes.aiDailyUsdCap,
        createdAt: mailboxes.createdAt,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId));
    if (!mb || mb.status === "disabled" || mb.status === "paused") return;
    const [first] = await db
      .select(HEAD_COLUMNS)
      .from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), inArray(messages.state, ["pending", "extracted"])))
      .orderBy(asc(messages.sortTs), asc(messages.id))
      .limit(1);
    if (mb.aiPaused) {
      // A daily-budget pause ends when the org-local day rolls over (whatever zone the worker's reset job uses), or
      // when the budget of the mail now at the head of the queue (early mail has its own) is no longer used up.
      const [org] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, mb.orgId));
      const which = first ? budgetOf(await replyChainHead(db, mailboxId, first), mb) : "both";
      if (!(await isBudgetPauseExpired(mb, org?.timezone || DEFAULT_ZONE, now, { db, config: deps.config }, which))) {
        report.budgetPaused = isBudgetPause(mb.aiPausedReason);
        return;
      }
      const cleared = await db
        .update(mailboxes)
        .set({ aiPaused: false, aiPausedReason: null })
        .where(and(eq(mailboxes.id, mb.id), eq(mailboxes.aiPaused, true), eq(mailboxes.aiPausedReason, mb.aiPausedReason!)))
        .returning({ id: mailboxes.id });
      // Nothing cleared: the pause changed concurrently (e.g. a manual pause) — leave it to the next drain.
      if (!cleared.length) return;
      deps.log.info({ mailboxId: mb.id }, "AI daily budget pause expired (new local day or higher cap); mailbox AI resumed");
      continue;
    }
    if (!first) return;
    // Inside a thread, reply-chain order wins over sort_ts: a reply waits for its queued parent.
    const head = await replyChainHead(db, mailboxId, first);
    // Head-of-line: an earlier message that is still settling, not yet covered by a full sync cycle,
    // or backing off blocks the queue — later messages never overtake it.
    const blocked = headBlocked(head, now, deps.config.SETTLE_SEC, opts.fullCycleAt ?? null);
    if (blocked) {
      if (blocked === "backoff") report.transientBackoff = true;
      return;
    }
    let step: Step;
    try {
      step = await processHead(deps, internals, mb, head, now, report, reextracted);
    } catch (err) {
      step = await handleThrown(deps, head, err, now, report);
    }
    if (step === "stop") return;
  }
}

function headBlocked(head: Head, now: Date, settleSec: number, fullCycleAt: Date | null): "settle" | "cycle" | "backoff" | null {
  if (head.firstSeenAt.getTime() > now.getTime() - settleSec * 1000) return "settle";
  if (fullCycleAt && head.firstSeenAt.getTime() > fullCycleAt.getTime()) return "cycle";
  if (head.nextAttemptAt && head.nextAttemptAt.getTime() > now.getTime()) return "backoff";
  return null;
}

async function processHead(deps: PipelineDeps, internals: DrainInternals, mb: MailboxRow, head: Head, now: Date, report: DrainReport, reextracted: Set<string>): Promise<Step> {
  const { db, extractor, clock } = deps;
  let extractionId: string | null;
  if (head.state === "extracted") {
    extractionId = (await latestOkExtraction(db, head.id, extractor.pipelineVersion)) ?? (await latestOkExtraction(db, head.id, null));
    if (!extractionId) {
      await db.update(messages).set({ state: "pending", updatedAt: now }).where(and(eq(messages.id, head.id), eq(messages.state, "extracted")));
      return "again";
    }
  } else {
    // Never pay twice: an ok extraction for this pipeline version (e.g. crash before apply) is reused.
    extractionId = await latestOkExtraction(db, head.id, extractor.pipelineVersion);
    if (extractionId) {
      await db.update(messages).set({ state: "extracted", updatedAt: now }).where(and(eq(messages.id, head.id), eq(messages.state, "pending")));
    } else {
      const over = await budgetExceeded(db, mb, now, deps.config, budgetOf(head, mb));
      if (over) {
        await db.update(mailboxes).set({ aiPaused: true, aiPausedReason: over }).where(eq(mailboxes.id, mb.id));
        report.budgetPaused = true;
        deps.log.warn({ mailboxId: mb.id, reason: over }, "AI daily budget reached; mailbox AI paused");
        return "stop";
      }
      const { input, handleMap } = await internals.buildContext(db, head.id);
      const result = await extractor.extract(input);
      const stored = await storeExtraction(db, head, result, input, handleMap, extractor.pipelineVersion, clock.now());
      if (!result.ok) return handleExtractorError(deps, head, result, report);
      report.extracted++;
      extractionId = stored;
    }
  }

  await internals.apply(db, head.id, extractionId, clock);
  const [after] = await db.select({ state: messages.state }).from(messages).where(eq(messages.id, head.id));
  switch (after?.state) {
    case "applied":
      report.processed++;
      report.applied++;
      return "done";
    case "failed":
      report.processed++;
      report.parked++;
      return "done";
    case "pending":
      // The reconciler rejected the output: one re-extraction (apply marked the extraction unusable).
      if (reextracted.has(head.id)) return "stop";
      reextracted.add(head.id);
      return "again";
    default:
      return "stop";
  }
}

async function latestOkExtraction(db: Db, messageId: string, pipelineVersion: string | null): Promise<string | null> {
  const [row] = await db
    .select({ id: extractions.id })
    .from(extractions)
    .where(and(eq(extractions.messageId, messageId), eq(extractions.status, "ok"), pipelineVersion ? eq(extractions.pipelineVersion, pipelineVersion) : undefined))
    .orderBy(desc(extractions.createdAt), desc(extractions.attempt))
    .limit(1);
  return row?.id ?? null;
}

/** Stores the call (ok or error) and, when ok, moves the message to `extracted` in the same transaction. */
async function storeExtraction(db: Db, head: Head, result: ExtractorResult, input: ExtractionInput, handleMap: HandleMap, pipelineVersion: string, at: Date): Promise<string> {
  return db.transaction(async (tx) => {
    const [prev] = await tx
      .select({ n: sql<number>`coalesce(max(${extractions.attempt}), 0)::int` })
      .from(extractions)
      .where(and(eq(extractions.messageId, head.id), eq(extractions.pipelineVersion, pipelineVersion)));
    const usage = result.usage;
    const [row] = await tx
      .insert(extractions)
      .values({
        messageId: head.id,
        mailboxId: head.mailboxId,
        pipelineVersion,
        attempt: Number(prev?.n ?? 0) + 1,
        status: result.ok ? "ok" : "error",
        errorClass: result.ok ? null : result.errorClass,
        error: result.ok ? null : truncate(result.error, 500).text,
        requestedModel: requestedModel(result.request),
        model: result.model,
        stopReason: result.stopReason,
        request: input,
        handleMap,
        output: result.ok ? result.output : null,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
        costUsd: result.costUsd,
        latencyMs: Math.round(result.latencyMs),
        createdAt: at,
      })
      .returning({ id: extractions.id });
    if (result.ok) {
      await tx.update(messages).set({ state: "extracted", lastError: null, updatedAt: at }).where(and(eq(messages.id, head.id), eq(messages.state, "pending")));
    }
    return row!.id;
  });
}

function requestedModel(request: unknown): string | null {
  const m = (request as { model?: unknown } | null)?.model;
  return typeof m === "string" ? m : null;
}

async function handleExtractorError(deps: PipelineDeps, head: Head, result: Extract<ExtractorResult, { ok: false }>, report: DrainReport): Promise<Step> {
  const { db, log } = deps;
  const now = deps.clock.now();
  const lastError = `${result.errorClass}: ${truncate(result.error, 200).text}`;
  const ids = { mailboxId: head.mailboxId, messageId: head.id, errorClass: result.errorClass };
  switch (result.errorClass) {
    case "TRANSIENT": {
      const attempts = head.attempts + 1;
      // The stream ran past its deadline again (a runaway response, not an outage): park instead of looping.
      if (result.error === STREAM_DEADLINE_ERROR && (await deadlineErrors(db, head.id)) >= MAX_DEADLINE_ATTEMPTS) {
        await parkHead(db, head, { attempts, nextAttemptAt: null, lastError: `PER_MESSAGE: ${STREAM_DEADLINE_ERROR}_repeated` }, now);
        report.processed++;
        report.parked++;
        log.warn({ ...ids, attempts }, "extraction repeatedly ran past its deadline; parked");
        return "done";
      }
      const delaySec = Math.max(backoffSec(attempts), result.retryAfterSec ?? 0);
      await db
        .update(messages)
        .set({ attempts, nextAttemptAt: new Date(now.getTime() + delaySec * 1000), lastError, updatedAt: now })
        .where(eq(messages.id, head.id));
      report.transientBackoff = true;
      log.warn({ ...ids, attempts, delaySec }, "transient extraction error; head of queue backs off");
      return "stop";
    }
    case "PER_MESSAGE":
      await parkHead(db, head, { attempts: head.attempts + 1, nextAttemptAt: null, lastError }, now);
      report.processed++;
      report.parked++;
      log.warn(ids, "extraction failed for this message; parked");
      return "done";
    case "GLOBAL":
      await setGlobalPause(db, { reason: "extractor", at: now.toISOString(), mailboxId: head.mailboxId, messageId: head.id, error: truncate(result.error, 200).text }, now);
      await db.update(messages).set({ lastError, updatedAt: now }).where(eq(messages.id, head.id));
      report.globalPause = true;
      log.error(ids, "global extraction error; AI paused for all mailboxes");
      return "stop";
  }
}

/**
 * Anything thrown outside the extractor's classified results: a data problem with this message parks it;
 * a transient DB error (deadlock, serialization, connection) stops the drain for a retry; anything else is
 * treated as a code bug → global pause without consuming the message.
 */
async function handleThrown(deps: PipelineDeps, head: Head, err: unknown, now: Date, report: DrainReport): Promise<Step> {
  const { db, log } = deps;
  const ids = { mailboxId: head.mailboxId, messageId: head.id, err: err instanceof Error ? err.name : typeof err, code: pgErrorCode(err) };
  if (err instanceof ApplyError || err instanceof ContextError) {
    const code = err instanceof ApplyError ? err.code : "context";
    await parkHead(db, head, { lastError: `apply: ${code}` }, now);
    report.processed++;
    report.parked++;
    log.warn(ids, "message cannot be applied; parked");
    return "done";
  }
  if (isTransientDbError(err)) {
    report.transientBackoff = true;
    log.warn(ids, "transient database error during drain");
    return "stop";
  }
  await setGlobalPause(db, { reason: "internal_error", at: now.toISOString(), mailboxId: head.mailboxId, messageId: head.id, error: ids.err }, now);
  report.globalPause = true;
  log.error(ids, "internal error during drain; AI paused for all mailboxes");
  return "stop";
}

/** Park the head for good (`failed`) and, for an inbound message, wake its thread's «until they reply» snoozes. */
async function parkHead(db: Db, head: Head, set: { attempts?: number; nextAttemptAt?: Date | null; lastError: string }, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(messages)
      .set({ state: "failed", ...set, updatedAt: now })
      .where(eq(messages.id, head.id));
    if (head.direction === "INBOUND") await wakeUntilReplySnoozes(tx, head.threadId, head.sortTs, now, { messageId: head.id });
  });
}

/** Stored extractor errors of this message that were stream-deadline overruns. */
async function deadlineErrors(db: Db, messageId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(extractions)
    .where(and(eq(extractions.messageId, messageId), eq(extractions.status, "error"), eq(extractions.error, STREAM_DEADLINE_ERROR)));
  return Number(row?.n ?? 0);
}

function isBudgetPause(reason: string | null): boolean {
  return reason === BUDGET_PAUSE_REASONS.calls || reason === BUDGET_PAUSE_REASONS.usd;
}

export type BudgetCaps = Pick<Config, "AI_DAILY_CALL_CAP" | "AI_DAILY_USD_CAP">;
export type BudgetMailbox = Pick<typeof mailboxes.$inferSelect, "id" | "aiPaused" | "aiPausedReason" | "aiDailyCallCap" | "aiDailyUsdCap" | "createdAt">;

/**
 * Early mail: messages that were in the mailbox before it was added (first seen in the backfill and dated before
 * the mailbox was created). They have a daily budget of their own, this many times the mailbox caps, counted apart
 * from the rest: the first sync of a mailbox can bring hundreds of old messages, and they are then analysed in a
 * day or two without using up the budget of the mail that arrives meanwhile. The rest keeps the caps as they are.
 */
export const EARLY_MAIL_BUDGET_FACTOR = 5;

/** Which daily budget a message spends: "early" mail (see {@link EARLY_MAIL_BUDGET_FACTOR}) or "live" mail. */
export type BudgetKind = "live" | "early";

export interface BudgetUse {
  calls: number;
  /** At the price table's rates (src/ai/pricing.ts), rounded to 1e-6. */
  usd: number;
}

/** What one mailbox spent on AI since local midnight, live and early mail apart (every call counts, errors too). */
export interface DailyBudgetUse {
  live: BudgetUse;
  early: BudgetUse;
}

export function isEarlyMail(message: { backfill: boolean; sortTs: Date }, mailbox: { createdAt: Date }): boolean {
  return message.backfill && message.sortTs.getTime() < mailbox.createdAt.getTime();
}

const budgetOf = (head: Head, mb: Pick<MailboxRow, "createdAt">): BudgetKind => (isEarlyMail(head, mb) ? "early" : "live");

/** The mailbox's own caps, else the config's. Early mail gets {@link EARLY_MAIL_BUDGET_FACTOR} times these. */
export function dailyCaps(mb: Pick<BudgetMailbox, "aiDailyCallCap" | "aiDailyUsdCap">, config: BudgetCaps): BudgetUse {
  return { calls: mb.aiDailyCallCap ?? config.AI_DAILY_CALL_CAP, usd: mb.aiDailyUsdCap ?? config.AI_DAILY_USD_CAP };
}

/** AI calls and their cost since local midnight in `zone`: the numbers the daily budget compares with its caps. */
export async function dailyBudgetUse(db: Db, mb: Pick<BudgetMailbox, "id" | "createdAt">, zone: string, now: Date): Promise<DailyBudgetUse> {
  const since = localDayStart(now, zone);
  const early = sql`(${messages.backfill} and ${messages.sortTs} < ${mb.createdAt.toISOString()}::timestamptz)`;
  const [used] = await db
    .select({
      calls: sql<number>`count(*) filter (where not ${early})::int`,
      usd: sql<number>`coalesce(sum(${extractions.costUsd}) filter (where not ${early}), 0)::float8`,
      earlyCalls: sql<number>`count(*) filter (where ${early})::int`,
      earlyUsd: sql<number>`coalesce(sum(${extractions.costUsd}) filter (where ${early}), 0)::float8`,
    })
    .from(extractions)
    .innerJoin(messages, eq(messages.id, extractions.messageId))
    .where(and(eq(extractions.mailboxId, mb.id), gte(extractions.createdAt, since)));
  // cost_usd is float4: round the sum so 0.01 + … is not 0.0099999998.
  const usd = (v: unknown) => Math.round(Number(v ?? 0) * 1e6) / 1e6;
  return {
    live: { calls: Number(used?.calls ?? 0), usd: usd(used?.usd) },
    early: { calls: Number(used?.earlyCalls ?? 0), usd: usd(used?.earlyUsd) },
  };
}

/** The pause reason when `use` reached `caps` × `factor`, else null. */
function overCaps(use: BudgetUse, caps: BudgetUse, factor: number): string | null {
  if (use.calls >= caps.calls * factor) return BUDGET_PAUSE_REASONS.calls;
  if (use.usd >= caps.usd * factor) return BUDGET_PAUSE_REASONS.usd;
  return null;
}

/**
 * True when the mailbox is paused for its daily AI budget and that budget is no longer exceeded for the current
 * day in `orgZone` (the org-local day rolled over since the pause, or the cap was raised). `which`: the budget of
 * the message at the head of the queue; "both" (no head known) asks that neither is used up. The pipeline clears
 * such a pause itself on the next drain; the worker's daily reset may call this to clear it per mailbox and zone.
 * False for manual or other pauses.
 */
export async function isBudgetPauseExpired(
  mailbox: BudgetMailbox,
  orgZone: string,
  now: Date,
  deps: { db: Db; config: BudgetCaps },
  which: BudgetKind | "both" = "both",
): Promise<boolean> {
  if (!mailbox.aiPaused || !isBudgetPause(mailbox.aiPausedReason)) return false;
  return (await budgetExceededInZone(deps.db, mailbox, orgZone, now, deps.config, which)) === null;
}

/** Daily calls/$ of the mailbox since local midnight (org zone) against the mailbox caps, else the config caps. */
async function budgetExceeded(db: Db, mb: MailboxRow, now: Date, config: PipelineDeps["config"], which: BudgetKind): Promise<string | null> {
  const [org] = await db.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, mb.orgId));
  return budgetExceededInZone(db, mb, org?.timezone || DEFAULT_ZONE, now, config, which);
}

async function budgetExceededInZone(
  db: Db,
  mb: Pick<BudgetMailbox, "id" | "aiDailyCallCap" | "aiDailyUsdCap" | "createdAt">,
  zone: string,
  now: Date,
  config: BudgetCaps,
  which: BudgetKind | "both",
): Promise<string | null> {
  const use = await dailyBudgetUse(db, mb, zone, now);
  const caps = dailyCaps(mb, config);
  const live = which === "early" ? null : overCaps(use.live, caps, 1);
  const early = which === "live" ? null : overCaps(use.early, caps, EARLY_MAIL_BUDGET_FACTOR);
  return live ?? early;
}

/** A stored `null` or `{ paused: false }` means "not paused". */
export function isGlobalPauseValue(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  return !(typeof v === "object" && (v as { paused?: unknown }).paused === false);
}

export async function isGloballyPaused(db: Db): Promise<boolean> {
  const [row] = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, GLOBAL_PAUSE_KEY));
  return !!row && isGlobalPauseValue(row.value);
}

export async function setGlobalPause(db: Db, value: GlobalPauseValue, now: Date): Promise<void> {
  await db
    .insert(appState)
    .values({ key: GLOBAL_PAUSE_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: now } });
}
