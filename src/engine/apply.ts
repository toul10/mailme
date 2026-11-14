import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { ExtractionOutput, OUTPUT_LIMITS, type CreateOperation, type UpdateOperation } from "../ai/schema.js";
import type { Db, Tx } from "../db/client.js";
import { extractions, mailboxes, messages, organizations, taskEvents, taskLinks, tasks, threads, users } from "../db/schema.js";
import type { CcPolicy } from "../domain/preferences.js";
import { isOpenStatus, type Clock, type HandleMap, type LockableField, type TaskCardScope } from "../domain/types.js";
import { domainOf, foldForMatch, normalizeAddress, PUBLIC_MAIL_DOMAINS } from "../lib/text.js";
import {
  diffSnapshots,
  expirePendingSuggestions,
  insertEvent,
  insertLink,
  priorOpenStatus,
  proposalToTaskValues,
  snapshot,
  suggestionPayload,
  type LinkRole,
  type NewEventRow,
  type ProposedChange,
  type ProposedFields,
  type ProposedTask,
} from "./db-events.js";
import { recordStoredBouncesFor } from "./bounce.js";
import { clampText, companyDomainOf, defaultExpectReplyBy, isInternalDomain, loadCompanyMap, lookupCompany, maxDate, mergeItems, threadFamily, uniq } from "./db-util.js";
import { planOperations, type Plan, type PlannedOp, type ReconcileContext, type ReconcileTask } from "./reconcile.js";
import { buildSearchText, insertTaskWithRef, type TaskRow } from "./tasks.js";

export interface ApplyResult {
  applied: boolean;
  created: string[];
  updated: string[];
  completed: string[];
  suggestions: number;
  logged: number;
  messageReview: boolean;
}

/** The reconciler entry point (src/engine/reconcile.ts); injectable for tests. */
export type Planner = (output: ExtractionOutput, ctx: ReconcileContext) => Plan;
export interface ApplyDeps {
  planOperations: Planner;
}

/** The stored extraction can't be applied (missing, not ok, other message). The pipeline parks the message. */
export class ApplyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ApplyError";
  }
}

/** extractions.error of an output the reconciler rejected; one re-extraction, then the message is parked. */
export const INVALID_OUTPUT_ERROR = "invalid_output";

/** One transaction: claim (extracted→applied), lock tasks, re-check against current state, write, events. */
export async function applyExtraction(db: Db, messageId: string, extractionId: string, clock: Clock): Promise<ApplyResult> {
  return applyExtractionWith(db, messageId, extractionId, clock);
}

/** applyExtraction with an injectable planner (tests, eval). */
export async function applyExtractionWith(db: Db, messageId: string, extractionId: string, clock: Clock, deps: ApplyDeps = { planOperations }): Promise<ApplyResult> {
  const now = clock.now();
  return db.transaction((tx) => applyInTx(tx, messageId, extractionId, now, deps));
}

type MessageRow = typeof messages.$inferSelect;
type ExtractionRow = typeof extractions.$inferSelect;

interface Env {
  tx: Tx;
  now: Date;
  msg: MessageRow;
  ext: ExtractionRow;
  orgId: string;
  userId: string;
  mailboxId: string;
  mailboxAddress: string;
  zone: string;
  holySpirit: boolean;
  internalDomains: string[];
  /** The mailbox owner's rule for Cc-only requests (users.cc_policy). */
  ccPolicy: CcPolicy;
  companyMap: Map<string, string>;
  /** The organization's own names (see {@link ownCompanyKeys}): never stored as a task's company. */
  ownCompanies: Set<string>;
  family: string[];
  handleMap: HandleMap;
  /** Tasks locked FOR UPDATE (handle targets + merge survivors), kept in sync with writes. */
  locked: Map<string, TaskRow>;
  plan: Plan;
  output: ExtractionOutput;
  result: ApplyResult;
  /** Existing tasks an applied/suggested op touched (for message-level review). */
  touched: Set<string>;
}

function emptyResult(): ApplyResult {
  return { applied: false, created: [], updated: [], completed: [], suggestions: 0, logged: 0, messageReview: false };
}

async function applyInTx(tx: Tx, messageId: string, extractionId: string, now: Date, deps: ApplyDeps): Promise<ApplyResult> {
  const [msg] = await tx
    .update(messages)
    .set({ state: "applied", appliedExtractionId: extractionId, lastError: null, updatedAt: now })
    .where(and(eq(messages.id, messageId), eq(messages.state, "extracted")))
    .returning();
  if (!msg) return emptyResult();
  const [ext] = await tx.select().from(extractions).where(eq(extractions.id, extractionId));
  if (!ext || ext.messageId !== messageId || ext.status !== "ok") throw new ApplyError("extraction_unusable");
  // Already applied once (the message state was reset by hand): never apply the same extraction twice.
  const [prior] = await tx.select({ id: taskEvents.id }).from(taskEvents).where(eq(taskEvents.extractionId, extractionId)).limit(1);
  if (prior) return emptyResult();

  const [mb] = await tx.select().from(mailboxes).where(eq(mailboxes.id, msg.mailboxId));
  if (!mb) throw new ApplyError("mailbox_missing");
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, mb.orgId));
  const [owner] = await tx.select({ ccPolicy: users.ccPolicy }).from(users).where(eq(users.id, mb.userId));
  const handleMap: HandleMap = ext.handleMap ?? { tasks: {}, participants: {} };
  const internalDomains = (org?.internalDomains ?? []).map((d) => d.toLowerCase());
  const companyMap = await loadCompanyMap(tx, mb.orgId);
  const base = {
    tx,
    now,
    msg,
    ext,
    orgId: mb.orgId,
    userId: mb.userId,
    mailboxId: mb.id,
    mailboxAddress: mb.address,
    zone: org?.timezone || "Europe/Athens",
    holySpirit: org?.holySpiritHoliday ?? false,
    internalDomains,
    ccPolicy: owner?.ccPolicy ?? "ask",
    companyMap,
    ownCompanies: ownCompanyKeys(org?.name ?? null, internalDomains, companyMap),
    family: await threadFamily(tx, msg.threadId),
    handleMap,
  };

  const parsed = ExtractionOutput.safeParse(ext.output);
  if (!parsed.success) return invalidOutput(base, null, ["output_schema"]);
  const output = parsed.data;

  // One id-ordered lock batch: op targets plus, for an inbound reply, the thread's until_reply snoozes it may wake.
  const wakeable = msg.direction === "INBOUND" ? await untilReplyCandidates(tx, base.family, mb.userId) : [];
  const locked = await lockTasks(tx, uniq([...Object.values(handleMap.tasks).filter((x): x is string => !!x), ...wakeable]), mb.userId);
  const ctx = await buildReconcileContext({ ...base, locked });
  const plan = deps.planOperations(output, ctx);
  if (!plan.valid) return invalidOutput(base, output, plan.reasons.length ? plan.reasons : ["plan_invalid"]);

  const env: Env = { ...base, locked, plan, output, result: emptyResult(), touched: new Set() };
  const seen = new Set<number>();
  for (const po of [...plan.ops].sort((a, b) => a.opIndex - b.opIndex)) {
    if (seen.has(po.opIndex)) continue;
    seen.add(po.opIndex);
    await writeOp(env, po);
  }
  // Every proposed op leaves an event, even one the reconciler did not return.
  for (const [i, op] of output.operations.entries()) {
    if (seen.has(i)) continue;
    const po: PlannedOp = { opIndex: i, op, taskId: null, tier: "logged", disposition: "log", reasons: ["not_planned"], grounding: { status: "missing", foundIn: null, score: 0 }, due: null, expectReply: null };
    await insertEvent(tx, baseEvent(env, po));
    env.result.logged++;
  }
  if (plan.messageReview) await flagTouchedForReview(env);
  if (msg.direction === "INBOUND") await wakeUntilReplySnoozes(tx, msg.threadId, msg.sortTs, now, { messageId: msg.id, locked });
  await tx.update(messages).set({ classification: output.message_class }).where(eq(messages.id, msg.id));
  // Last: DSNs stored before this message was applied flag the tasks it just linked. It writes with SQL
  // on the current rows, so it must follow every write that uses the in-memory `locked` copies.
  await recordStoredBouncesFor(tx, { mailboxId: msg.mailboxId, messageIdHeader: msg.messageIdHeader }, now);

  env.result.applied = true;
  env.result.messageReview = plan.messageReview;
  env.result.updated = uniq(env.result.updated);
  return env.result;
}

// ── Reconcile context ────────────────────────────────────────────────────────

async function lockTasks(tx: Tx, ids: string[], userId: string): Promise<Map<string, TaskRow>> {
  const out = new Map<string, TaskRow>();
  let want = ids;
  for (let i = 0; i < 5 && want.length; i++) {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, want), eq(tasks.userId, userId)))
      .orderBy(asc(tasks.id))
      .for("update");
    for (const r of rows) out.set(r.id, r);
    want = uniq(rows.map((r) => r.mergedIntoId).filter((x): x is string => !!x && !out.has(x)));
  }
  return out;
}

/** Card scope per task id as offered to the model (stored ExtractionInput), when available. */
function offeredScopes(request: unknown, handleMap: HandleMap): Map<string, TaskCardScope> {
  const out = new Map<string, TaskCardScope>();
  const cards = (request as { taskCards?: unknown } | null)?.taskCards;
  if (!Array.isArray(cards)) return out;
  for (const c of cards as Array<{ handle?: unknown; scope?: unknown }>) {
    const id = typeof c.handle === "string" ? handleMap.tasks[c.handle as keyof HandleMap["tasks"]] : undefined;
    if (id && (c.scope === "THREAD_OPEN" || c.scope === "THREAD_CLOSED" || c.scope === "RELATED_OPEN")) out.set(id, c.scope);
  }
  return out;
}

/**
 * The user's latest dismissal of the (outer) task was not «someone else handles it»: USER_HANDLED_BY_OTHER, or an
 * accepted hand-over SUGGEST_DISMISS (user-actions.ts marks both payload.kind = 'handled_by_other'). Such a task says
 * nothing against the counterparty, so later requests from them are not held back (counterparty_dismissed).
 */
const NOT_HANDED_OVER = sql`coalesce((
  select te.payload ->> 'kind' from task_events te
  where te.task_id = ${sql.raw(`"tasks"."id"`)} and te.actor = 'user' and te.after ->> 'status' = 'DISMISSED'
  order by te.created_at desc, te.id desc limit 1
), '') <> 'handled_by_other'`;

async function buildReconcileContext(e: Omit<Env, "plan" | "output" | "result" | "touched">): Promise<ReconcileContext> {
  const { tx, msg, family, handleMap, locked } = e;
  const handleIds = uniq(Object.values(handleMap.tasks).filter((x): x is string => !!x && locked.has(x)));
  // Tasks merged after the extraction: their merge chains (locked by lockTasks) are in context too, so the reconciler
  // can redirect an op to the survivor (→ review, reason task_merged) instead of logging it.
  const reachedFrom = new Map<string, string>();
  for (const id of handleIds) {
    let t = locked.get(id)!;
    for (let i = 0; t.mergedIntoId && i < 10; i++) {
      const next = locked.get(t.mergedIntoId);
      if (!next) break;
      if (!handleIds.includes(next.id) && !reachedFrom.has(next.id)) reachedFrom.set(next.id, id);
      t = next;
    }
  }
  const ctxIds = [...handleIds, ...reachedFrom.keys()];
  const scopes = offeredScopes(e.ext.request, handleMap);
  const linked = new Set(
    family.length && ctxIds.length
      ? (await tx.selectDistinct({ taskId: taskLinks.taskId }).from(taskLinks).where(and(inArray(taskLinks.threadId, family), inArray(taskLinks.taskId, ctxIds)))).map((r) => r.taskId)
      : [],
  );
  const originIds = ctxIds.map((id) => locked.get(id)!.originMessageId).filter((x): x is string => !!x);
  const originTs = new Map(
    (originIds.length ? await tx.select({ id: messages.id, sortTs: messages.sortTs }).from(messages).where(inArray(messages.id, originIds)) : []).map((r) => [r.id, r.sortTs]),
  );
  // Owner replies in this thread up to this message (a later reply is processed on its own).
  const outbound = family.length
    ? await tx
        .select({ sortTs: messages.sortTs })
        .from(messages)
        .where(and(inArray(messages.threadId, family), eq(messages.direction, "OUTBOUND"), ne(messages.id, msg.id), ne(messages.state, "own_mail"), lte(messages.sortTs, msg.sortTs)))
    : [];

  const threadScope = (t: TaskRow): TaskCardScope => (isOpenStatus(t.status) ? "THREAD_OPEN" : "THREAD_CLOSED");
  /** Handle targets: the scope they were offered with. Survivors: thread scope if linked to the thread family, else that of the handle that led to them. */
  const scopeOf = (id: string): TaskCardScope => {
    const t = locked.get(id)!;
    if (!reachedFrom.has(id)) return scopes.get(id) ?? (linked.has(id) ? threadScope(t) : "RELATED_OPEN");
    return linked.has(id) ? threadScope(t) : scopeOf(reachedFrom.get(id)!);
  };
  const taskMap = new Map<string, ReconcileTask>();
  for (const id of ctxIds) {
    const t = locked.get(id)!;
    const since = (t.originMessageId && originTs.get(t.originMessageId)) || t.createdAt;
    taskMap.set(id, {
      id,
      status: t.status,
      lockedFields: t.lockedFields,
      mergedIntoId: t.mergedIntoId,
      closedBy: t.closedBy,
      createdAt: t.createdAt,
      scope: scopeOf(id),
      ownerRepliedInThreadAfterCreate: outbound.some((o) => o.sortTs.getTime() > since.getTime()),
    });
  }

  const negatives = family.length
    ? await tx
        .select({ norm: taskEvents.evidenceNorm })
        .from(taskEvents)
        .where(
          and(
            inArray(taskEvents.threadId, family),
            isNotNull(taskEvents.evidenceNorm),
            or(eq(taskEvents.op, "USER_NOT_A_TASK"), and(eq(taskEvents.op, "USER_REJECT_SUGGESTION"), sql`${taskEvents.payload}->>'proposedType' = 'create'`)),
          ),
        )
    : [];
  const dismissed = family.length
    ? await tx
        .selectDistinct({ address: tasks.counterpartyAddress })
        .from(tasks)
        .innerJoin(taskLinks, eq(taskLinks.taskId, tasks.id))
        .where(
          and(
            inArray(taskLinks.threadId, family),
            eq(tasks.userId, e.userId),
            eq(tasks.status, "DISMISSED"),
            eq(tasks.closedBy, "user"),
            isNull(tasks.mergedIntoId),
            NOT_HANDED_OVER,
          ),
        )
    : [];
  const dismissedCounterparties = new Set<string>();
  for (const d of dismissed) {
    const a = normalizeAddress(d.address);
    if (!a) continue;
    dismissedCounterparties.add(a);
    // Also by participant handle, so a CREATE's `counterparty` handle can be checked directly.
    for (const [h, p] of Object.entries(handleMap.participants)) if (p && normalizeAddress(p.address) === a) dismissedCounterparties.add(h);
  }

  const [thread] = msg.threadId ? await tx.select({ linkConfidence: threads.linkConfidence }).from(threads).where(eq(threads.id, msg.threadId)) : [];
  return {
    direction: msg.direction,
    claimsOwnerSender: msg.claimsOwnerSender,
    late: msg.late,
    lowLinkConfidence: thread?.linkConfidence === "LOW",
    messageSortTs: msg.sortTs,
    zone: e.zone,
    holySpirit: e.holySpirit,
    handleMap,
    tasks: taskMap,
    segments: msg.segments,
    attachments: msg.attachments,
    subject: msg.subject,
    calendar: msg.calendar ?? null,
    negativeEvidence: new Set(negatives.map((n) => n.norm).filter((x): x is string => !!x)),
    userDismissedCounterparties: dismissedCounterparties,
    ccPolicy: e.ccPolicy,
  };
}

// ── Invalid output: one re-extraction, then park ─────────────────────────────

async function invalidOutput(e: Pick<Env, "tx" | "now" | "msg" | "ext" | "userId" | "mailboxId">, output: ExtractionOutput | null, reasons: string[]): Promise<ApplyResult> {
  const { tx, msg, ext, now } = e;
  if (output) {
    // Keep the rejected candidates for the audit (no task attached).
    for (const [i, op] of output.operations.entries()) {
      const quote = clampText(op.evidence.quote, OUTPUT_LIMITS.maxQuote);
      await insertEvent(tx, {
        taskId: null,
        userId: e.userId,
        mailboxId: e.mailboxId,
        messageId: msg.id,
        threadId: msg.threadId,
        extractionId: ext.id,
        opIndex: i,
        actor: "ai",
        op: op.op,
        payload: op,
        evidenceSource: op.evidence.source,
        evidenceQuote: quote,
        evidenceNorm: quote ? foldForMatch(quote) : null,
        tier: "logged",
        applied: false,
        reasons: uniq([...reasons, INVALID_OUTPUT_ERROR]),
        createdAt: now,
      });
    }
  }
  const [prev] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(extractions)
    .where(and(eq(extractions.messageId, msg.id), eq(extractions.pipelineVersion, ext.pipelineVersion), eq(extractions.error, INVALID_OUTPUT_ERROR)));
  await tx.update(extractions).set({ status: "error", errorClass: "PER_MESSAGE", error: INVALID_OUTPUT_ERROR }).where(eq(extractions.id, ext.id));
  const retry = Number(prev?.n ?? 0) === 0;
  await tx
    .update(messages)
    .set(
      retry
        ? { state: "pending", appliedExtractionId: null, lastError: INVALID_OUTPUT_ERROR, updatedAt: now }
        : { state: "failed", lastError: INVALID_OUTPUT_ERROR, classification: output?.message_class ?? null, updatedAt: now },
    )
    .where(eq(messages.id, msg.id));
  // Parked for good: the reply still arrived, so «until they reply» snoozes wake as for an applied message.
  if (!retry && msg.direction === "INBOUND") await wakeUntilReplySnoozes(tx, msg.threadId, msg.sortTs, now, { messageId: msg.id });
  return { ...emptyResult(), messageReview: true };
}

// ── Per-op writers ───────────────────────────────────────────────────────────

function baseEvent(e: Env, po: PlannedOp): NewEventRow {
  const op = po.op;
  const quote = clampText(op.evidence.quote, OUTPUT_LIMITS.maxQuote);
  return {
    taskId: null,
    userId: e.userId,
    mailboxId: e.mailboxId,
    messageId: e.msg.id,
    threadId: e.msg.threadId,
    extractionId: e.ext.id,
    opIndex: po.opIndex,
    actor: "ai",
    op: op.op,
    payload: op,
    evidenceSource: op.evidence.source,
    evidenceQuote: quote,
    evidenceNorm: quote ? foldForMatch(quote) : null,
    features: {
      certainty: op.certainty,
      confidence: op.confidence,
      addressee: op.op === "CREATE" ? op.addressee : null,
      segmentId: op.evidence.segment_id,
      disposition: po.disposition,
      grounding: po.grounding,
      due: po.due,
      expectReply: po.expectReply,
      direction: e.msg.direction,
      late: e.msg.late,
      messageClass: e.output.message_class,
      suspiciousInstructions: e.output.suspicious_instructions,
      messageReview: e.plan.messageReview,
    },
    tier: po.tier,
    applied: false,
    suggestionState: null,
    reasons: uniq([...po.reasons, ...(e.plan.messageReview ? e.plan.reasons : [])]),
    createdAt: e.now,
  };
}

/** Follow merges to the surviving task (all survivors were locked with the targets). */
function resolveTarget(e: Env, id: string): { task: TaskRow; redirected: boolean } | null {
  let t = e.locked.get(id);
  let redirected = false;
  for (let i = 0; t?.mergedIntoId && i < 10; i++) {
    const next = e.locked.get(t.mergedIntoId);
    if (!next) break;
    t = next;
    redirected = true;
  }
  return t && !t.mergedIntoId ? { task: t, redirected } : null;
}

async function writeOp(e: Env, po: PlannedOp): Promise<void> {
  const op = po.op;
  const ev = baseEvent(e, po);
  if (op.op === "CREATE") return writeCreate(e, po, op, ev);

  const rawId = po.taskId ?? e.handleMap.tasks[op.task] ?? null;
  const target = rawId ? resolveTarget(e, rawId) : null;
  if (target?.redirected) ev.reasons = uniq([...(ev.reasons ?? []), "merged_into_survivor"]);
  if (po.disposition === "log" || !target) {
    if (!target && po.disposition !== "log") ev.reasons = uniq([...(ev.reasons ?? []), "task_missing"]);
    await insertEvent(e.tx, { ...ev, taskId: target?.task.id ?? null });
    e.result.logged++;
    return;
  }
  const t = target.task;
  const open = isOpenStatus(t.status);

  switch (op.op) {
    case "UPDATE":
      return writeUpdate(e, po, op, ev, t);
    case "COMPLETE": {
      if (!open) return logNoop(e, ev, t, "already_closed");
      if (po.disposition === "suggest") return suggest(e, ev, t, { type: "complete" });
      if (t.lockedFields.includes("status")) return suggest(e, ev, t, { type: "complete" }, ["locked:status"]);
      await expirePendingSuggestions(e.tx, t.id);
      await patchTask(e, po, ev, t, { status: "COMPLETED", closedBy: "ai", closedAt: e.msg.sortTs, autoClosedReportedAt: null, snoozedUntil: null, snoozeMode: null }, "completion");
      e.result.completed.push(t.id);
      return;
    }
    case "REOPEN": {
      if (open) return logNoop(e, ev, t, "already_open");
      if (po.disposition === "suggest") return suggest(e, ev, t, { type: "reopen" });
      if (t.lockedFields.includes("status")) return suggest(e, ev, t, { type: "reopen" }, ["locked:status"]);
      if (t.closedBy === "user") return suggest(e, ev, t, { type: "reopen" }, ["user_closed"]);
      const status = await priorOpenStatus(e.tx, t.id);
      const patch: Partial<TaskRow> = { status, closedBy: null, closedAt: null, autoClosedReportedAt: null, dormantAt: null, stillValidAskedAt: null };
      if (status !== "ACTION_REQUIRED") patch.waitingSince = e.msg.sortTs;
      // A new waiting period gets a fresh follow-up threshold.
      if (status === "WAITING_FOR_OTHER") patch.expectReplyBy = defaultExpectReplyBy(e.msg.sortTs, e.zone, e.holySpirit);
      await patchTask(e, po, ev, t, patch, "reopen");
      e.result.updated.push(t.id);
      return;
    }
    case "SUGGEST_DISMISS":
      if (!open) return logNoop(e, ev, t, "already_closed");
      return suggest(e, ev, t, { type: "dismiss" });
  }
}

async function logNoop(e: Env, ev: NewEventRow, t: TaskRow, reason: string): Promise<void> {
  await insertEvent(e.tx, { ...ev, taskId: t.id, reasons: uniq([...(ev.reasons ?? []), reason]) });
  e.result.logged++;
}

async function suggest(e: Env, ev: NewEventRow, t: TaskRow | null, proposed: ProposedChange, reasons: string[] = []): Promise<void> {
  await insertEvent(e.tx, {
    ...ev,
    taskId: t?.id ?? null,
    suggestionState: "pending",
    payload: suggestionPayload(proposed, ev.payload),
    reasons: uniq([...(ev.reasons ?? []), ...reasons]),
  });
  if (t) e.touched.add(t.id);
  e.result.suggestions++;
}

/** Write only the touched columns (+ bookkeeping), the event and the message link. */
async function patchTask(e: Env, po: PlannedOp, ev: NewEventRow, t: TaskRow, changes: Partial<TaskRow>, role: LinkRole, extra: { proposed?: ProposedFields; reasons?: string[] } = {}): Promise<void> {
  const review = po.tier === "review";
  const patch: Partial<TaskRow> = { ...changes };
  if (review) {
    patch.needsReview = true;
    patch.reviewReasons = uniq([...t.reviewReasons, ...po.reasons]);
  }
  if (["nextAction", "summary", "items", "company", "counterpartyAddress", "counterpartyName"].some((k) => k in changes)) {
    patch.searchText = buildSearchText({ ...t, ...changes });
  }
  patch.version = t.version + 1;
  patch.updatedAt = e.now;
  patch.lastActivityAt = maxDate(t.lastActivityAt, e.msg.sortTs);
  // New mail on the topic answers "Still valid?" and wakes a dormant task.
  patch.dormantAt = null;
  const { before, after } = diffSnapshots(t, changes);
  await e.tx.update(tasks).set(patch).where(eq(tasks.id, t.id));
  Object.assign(t, patch);
  await insertLink(e.tx, { taskId: t.id, threadId: e.msg.threadId, messageId: e.msg.id, role, createdAt: e.now });
  const hasProposal = !!extra.proposed && Object.keys(extra.proposed).length > 0;
  await insertEvent(e.tx, {
    ...ev,
    taskId: t.id,
    applied: true,
    before,
    after,
    suggestionState: hasProposal ? "pending" : null,
    payload: hasProposal ? suggestionPayload({ type: "update", fields: extra.proposed! }, ev.payload) : ev.payload,
    reasons: uniq([...(ev.reasons ?? []), ...(extra.reasons ?? [])]),
  });
  if (hasProposal) e.result.suggestions++;
  e.touched.add(t.id);
}

const LOCK_OF: Record<string, LockableField> = { status: "status", due: "dueDate", priority: "priority", next_action: "nextAction", summary: "summary" };

/** Split an UPDATE into columns to write now and changes that stay a suggestion (locked fields, closed task). */
function planUpdate(e: Env, po: PlannedOp, op: UpdateOperation, t: TaskRow): { patch: Partial<TaskRow>; proposed: ProposedFields; reasons: string[] } {
  const c = op.changes;
  const patch: Partial<TaskRow> = {};
  const proposed: ProposedFields = {};
  const reasons: string[] = [];
  const locked = (key: keyof typeof LOCK_OF) => {
    const hit = t.lockedFields.includes(LOCK_OF[key]!);
    if (hit) reasons.push(`locked:${LOCK_OF[key]}`);
    return hit;
  };

  if (c.status && c.status !== t.status) {
    if (locked("status")) proposed.status = c.status;
    else {
      patch.status = c.status;
      if (c.status !== "ACTION_REQUIRED") patch.waitingSince = e.msg.sortTs;
      if (c.status === "WAITING_FOR_OTHER" && !po.expectReply?.date) patch.expectReplyBy = defaultExpectReplyBy(e.msg.sortTs, e.zone, e.holySpirit);
    }
  }
  if (c.due) {
    const date = po.due?.date ?? null;
    const phrase = clampText(c.due.phrase, 200);
    const fields = date
      ? date !== t.dueDate
        ? { dueDate: date, duePhrase: phrase, dueKind: c.due.kind }
        : null
      : // A vague phrase never replaces a concrete date.
        !t.dueDate && c.due.kind === "VAGUE" && phrase && phrase !== t.duePhrase
        ? { dueDate: null, duePhrase: phrase, dueKind: c.due.kind }
        : null;
    if (fields) {
      if (locked("due")) Object.assign(proposed, fields);
      else Object.assign(patch, fields);
    }
  }
  if (c.expect_reply) {
    const d = po.expectReply?.date ?? null;
    if (d && d !== t.expectReplyBy) patch.expectReplyBy = d;
  }
  if (c.priority && c.priority !== t.priority) {
    if (locked("priority")) proposed.priority = c.priority;
    else patch.priority = c.priority;
  }
  const nextAction = clampText(c.next_action, OUTPUT_LIMITS.maxNextAction);
  if (nextAction && nextAction !== t.nextAction) {
    if (locked("next_action")) proposed.nextAction = nextAction;
    else patch.nextAction = nextAction;
  }
  const summary = clampText(c.summary, OUTPUT_LIMITS.maxSummary);
  if (summary && summary !== t.summary) {
    if (locked("summary")) proposed.summary = summary;
    else patch.summary = summary;
  }
  const items = mergeItems(t.items, c.add_items);
  if (items.length !== t.items.length) patch.items = items;
  return { patch, proposed, reasons };
}

async function writeUpdate(e: Env, po: PlannedOp, op: UpdateOperation, ev: NewEventRow, t: TaskRow): Promise<void> {
  const { patch, proposed, reasons } = planUpdate(e, po, op, t);
  if (!isOpenStatus(t.status)) {
    // Precondition changed: the task is closed. A status change is still meaningful (accepting reopens it).
    const all = { ...proposed, ...updateFieldsFromPatch(patch) };
    if (all.status) return suggest(e, ev, t, { type: "update", fields: all }, ["task_closed"]);
    return logNoop(e, ev, t, "task_closed");
  }
  if (po.disposition === "suggest") {
    const all = { ...proposed, ...updateFieldsFromPatch(patch) };
    if (Object.keys(all).length === 0) return logNoop(e, ev, t, "no_change");
    return suggest(e, ev, t, { type: "update", fields: all }, reasons);
  }
  if (Object.keys(patch).length === 0) {
    if (Object.keys(proposed).length > 0) return suggest(e, ev, t, { type: "update", fields: proposed }, reasons);
    return logNoop(e, ev, t, "no_change");
  }
  await patchTask(e, po, ev, t, patch, "update", { proposed, reasons });
  e.result.updated.push(t.id);
}

function updateFieldsFromPatch(p: Partial<TaskRow>): ProposedFields {
  const f: ProposedFields = {};
  if (p.status && isOpenStatus(p.status)) f.status = p.status;
  if ("dueDate" in p) f.dueDate = p.dueDate ?? null;
  if ("duePhrase" in p) f.duePhrase = p.duePhrase ?? null;
  if ("dueKind" in p) f.dueKind = p.dueKind ?? null;
  if ("expectReplyBy" in p) f.expectReplyBy = p.expectReplyBy ?? null;
  if (p.priority) f.priority = p.priority;
  if ("nextAction" in p) f.nextAction = p.nextAction ?? null;
  if ("summary" in p) f.summary = p.summary ?? null;
  if (p.items) f.addItems = p.items;
  return f;
}

// ── Company and title of a new task ──────────────────────────────────────────

const LEGAL_SUFFIX = /\s+(α\.?ε\.?|ε\.?π\.?ε\.?|ο\.?ε\.?|ι\.?κ\.?ε\.?|ε\.?ε\.?|ltd\.?|s\.?a\.?|gmbh|inc\.?|llc)$/u;

/** Folded company/person label without a legal-form suffix ("ABC Α.Ε.", the Greek "ABC S.A." → "abc"). */
function labelKey(label: string | null | undefined): string | null {
  if (!label) return null;
  const k = foldForMatch(label).replace(LEGAL_SUFFIX, "").trim();
  return k || null;
}

/** Free-mail brands: a model label such as «Gmail» is the mailbox provider, never the customer's company. */
const WEBMAIL_LABELS = new Set(["gmail", "googlemail", "hotmail", "yahoo", "outlook", "icloud", "aol", "protonmail", "gmx", "yandex", "windowslive", "otenet", "freemail", "cosmotemail"]);

/** Keys of the organization's own names: its name, its internal domains (and their first label), and company_domains names mapped from them. */
export function ownCompanyKeys(orgName: string | null, internalDomains: readonly string[], companyMap: Map<string, string>): Set<string> {
  const keys = new Set<string>();
  const add = (v: string | null | undefined) => {
    const k = labelKey(v);
    if (k) keys.add(k);
  };
  add(orgName);
  for (const d of internalDomains) {
    add(d);
    add(d.split(".")[0]);
  }
  for (const [domain, company] of companyMap) if (isInternalDomain(domain, internalDomains)) add(company);
  return keys;
}

/** `domain` written as a whole domain in `text` («info@gmail.com», «gmail.com»), not inside another one («Supernova.gr» is not nova.gr). */
function mentionsDomain(text: string, domain: string): boolean {
  for (let i = text.indexOf(domain); i >= 0; i = text.indexOf(domain, i + 1)) {
    const before = text.slice(0, i);
    const after = text.slice(i + domain.length);
    if (!/[\p{L}\p{N}-]$/u.test(before) && !/^([\p{L}\p{N}-]|\.[\p{L}\p{N}])/u.test(after)) return true;
  }
  return false;
}

/**
 * The company stored on a new task; null makes the UI show the person instead.
 * - A colleague (or P1) as counterparty has no company: never the organization's own.
 * - company_domains wins for the counterparty's domain (as before), unless the domain is internal.
 * - Otherwise the model's label, unless it names the organization itself, an internal or a free-mail domain.
 */
export function taskCompany(opCompany: string | null, counterparty: { address: string | null; isInternal: boolean } | null, org: { internalDomains: readonly string[]; companyMap: Map<string, string>; ownCompanies: Set<string> }): string | null {
  if (counterparty?.isInternal) return null;
  const domain = domainOf(counterparty?.address);
  const mapped = domain && !isInternalDomain(domain, org.internalDomains) ? lookupCompany(org.companyMap, domain) : null;
  if (mapped) return mapped;
  const label = clampText(opCompany, 120);
  const key = labelKey(label);
  if (!label || !key) return null;
  const folded = foldForMatch(label);
  if ([...org.internalDomains, ...PUBLIC_MAIL_DOMAINS].some((d) => mentionsDomain(folded, d))) return null;
  if (org.ownCompanies.has(key) || WEBMAIL_LABELS.has(key)) return null;
  // «Contoso Hellas»: the internal domain's name as a word of the label.
  const words = key.split(/\s+/);
  if (org.internalDomains.some((d) => (d.split(".")[0] ?? "").length >= 4 && words.includes(d.split(".")[0]!))) return null;
  return label;
}

const OLD_STYLE_SEPARATOR = /\s+[—–]\s+/u;

/**
 * "ABC — Offer for …" (the old "<Company> — …" title style): drop the leading label when it names the task's
 * company or person, since the UI shows them next to the title. Only at CREATE; the title never changes afterwards.
 */
export function stripCompanyPrefix(title: string, labels: Array<string | null | undefined>): string {
  const m = OLD_STYLE_SEPARATOR.exec(title);
  if (!m || m.index === 0) return title;
  const prefix = labelKey(title.slice(0, m.index));
  const rest = title.slice(m.index + m[0].length).trim();
  if (!prefix || !/[\p{L}\p{N}]/u.test(rest)) return title;
  const named = labels.some((l) => {
    const k = labelKey(l);
    return !!k && (k === prefix || k.startsWith(`${prefix} `) || prefix.startsWith(`${k} `));
  });
  return named ? rest[0]!.toLocaleUpperCase("el") + rest.slice(1) : title;
}

function proposedTask(e: Env, po: PlannedOp, op: CreateOperation): ProposedTask {
  const hm = e.handleMap.participants;
  const owner = op.owner ? hm[op.owner] : undefined;
  const ownerKind: ProposedTask["ownerKind"] = op.owner === "P1" || owner?.isOwner ? "ME" : owner ? (owner.isInternal ? "INTERNAL" : "EXTERNAL") : "UNKNOWN";
  const cpRef = op.counterparty ? hm[op.counterparty] : undefined;
  const cp = cpRef && !cpRef.isOwner ? cpRef : undefined;
  const cpAddress = normalizeAddress(cp?.address);
  const expectReplyBy = po.expectReply?.date ?? (op.status === "WAITING_FOR_OTHER" ? defaultExpectReplyBy(e.msg.sortTs, e.zone, e.holySpirit) : null);
  const company = taskCompany(op.company, cp ? { address: cpAddress, isInternal: cp.isInternal } : null, e);
  const cpDomain = domainOf(cpAddress);
  const title = stripCompanyPrefix(op.title, [op.company, company, lookupCompany(e.companyMap, cpDomain), cp?.name, cpDomain?.split(".")[0], ownerKind === "ME" ? null : owner?.name]);
  return {
    title: clampText(title, OUTPUT_LIMITS.maxTitle) ?? "—",
    status: op.status,
    priority: op.priority,
    ownerKind,
    ownerAddress: ownerKind === "ME" ? e.mailboxAddress : (normalizeAddress(owner?.address) ?? null),
    ownerName: ownerKind === "ME" ? null : (owner?.name ?? null),
    counterpartyAddress: cpAddress,
    counterpartyName: cp?.name ?? null,
    company,
    companyDomain: companyDomainOf(cpAddress, e.internalDomains),
    items: mergeItems([], op.items),
    dueDate: po.due?.date ?? null,
    duePhrase: op.due ? clampText(op.due.phrase, 200) : null,
    dueKind: op.due?.kind ?? null,
    expectReplyBy,
    waitingSince: op.status === "ACTION_REQUIRED" ? null : e.msg.sortTs.toISOString(),
    nextAction: clampText(op.next_action, OUTPUT_LIMITS.maxNextAction),
    summary: clampText(op.summary, OUTPUT_LIMITS.maxSummary),
    origin: e.msg.backfill ? "backfill" : "ai",
    mailboxId: e.mailboxId,
    originMessageId: e.msg.id,
    threadId: e.msg.threadId,
    lastActivityAt: e.msg.sortTs.toISOString(),
  };
}

async function writeCreate(e: Env, po: PlannedOp, op: CreateOperation, ev: NewEventRow): Promise<void> {
  if (po.disposition === "log") {
    await insertEvent(e.tx, ev);
    e.result.logged++;
    return;
  }
  const proposal = proposedTask(e, po, op);
  if (po.disposition === "suggest") return suggest(e, ev, null, { type: "create", task: proposal });
  const review = po.tier === "review" || e.plan.messageReview;
  const row = await insertTaskWithRef(e.tx, {
    ...proposalToTaskValues(proposal, { orgId: e.orgId, userId: e.userId }, e.now),
    needsReview: review,
    reviewReasons: review ? uniq([...po.reasons, ...(e.plan.messageReview ? [...e.plan.reasons, "message_review"] : [])]) : [],
  });
  await insertLink(e.tx, { taskId: row.id, threadId: e.msg.threadId, messageId: e.msg.id, role: "origin", createdAt: e.now });
  await insertEvent(e.tx, { ...ev, taskId: row.id, applied: true, before: null, after: snapshot(row) });
  e.result.created.push(row.id);
}

// ── Message-level effects ────────────────────────────────────────────────────

/** Whole message went to review: flag every existing task it touched. */
async function flagTouchedForReview(e: Env): Promise<void> {
  const reasons = uniq([...e.plan.reasons, "message_review"]);
  for (const id of [...e.touched].sort()) {
    const t = e.locked.get(id);
    if (!t) continue;
    const reviewReasons = uniq([...t.reviewReasons, ...reasons]);
    if (t.needsReview && reviewReasons.length === t.reviewReasons.length) continue;
    const patch = { needsReview: true, reviewReasons, version: t.version + 1, updatedAt: e.now };
    await e.tx.update(tasks).set(patch).where(eq(tasks.id, id));
    Object.assign(t, patch);
  }
}

/** Thread tasks snoozed «until they reply» (ids only, not locked). */
async function untilReplyCandidates(tx: Tx, family: string[], userId: string): Promise<string[]> {
  if (!family.length) return [];
  const rows = await tx
    .selectDistinct({ id: tasks.id })
    .from(tasks)
    .innerJoin(taskLinks, eq(taskLinks.taskId, tasks.id))
    .where(and(inArray(taskLinks.threadId, family), eq(tasks.userId, userId), eq(tasks.snoozeMode, "until_reply"), isNull(tasks.mergedIntoId)));
  return rows.map((r) => r.id);
}

/**
 * An INBOUND message of the thread reached a terminal state in the pipeline — applied, or parked (`failed`:
 * extractor PER_MESSAGE error, invalid output twice, unappliable): the reply did arrive, so the thread family's
 * «until they reply» snoozes set before it (sort_ts after the last USER_SNOOZE) are woken with a SYSTEM_UNSNOOZE
 * event. Filtered messages (auto-replies, bulk, own mail…) never call this. Run inside the transaction that moves
 * the message to its terminal state. `locked`: in-memory task rows to keep in sync (apply). Returns the woken ids.
 */
export async function wakeUntilReplySnoozes(
  tx: Tx,
  threadId: string | null,
  messageSortTs: Date,
  now: Date,
  opts: { messageId?: string | null; locked?: Map<string, TaskRow> } = {},
): Promise<string[]> {
  if (!threadId) return [];
  const [owner] = await tx
    .select({ mailboxId: threads.mailboxId, userId: mailboxes.userId })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(eq(threads.id, threadId));
  if (!owner) return [];
  const ids = await untilReplyCandidates(tx, await threadFamily(tx, threadId), owner.userId);
  if (!ids.length) return [];
  // In apply these are already locked with the op targets (same id order); re-read for the current values.
  const snoozed = await tx
    .select()
    .from(tasks)
    .where(and(inArray(tasks.id, ids), eq(tasks.snoozeMode, "until_reply")))
    .orderBy(asc(tasks.id))
    .for("update");
  const woken: string[] = [];
  for (const t of snoozed) {
    if (!isOpenStatus(t.status)) continue;
    const [last] = await tx
      .select({ at: taskEvents.createdAt })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, t.id), eq(taskEvents.op, "USER_SNOOZE")))
      .orderBy(desc(taskEvents.createdAt))
      .limit(1);
    if (last && messageSortTs.getTime() <= last.at.getTime()) continue;
    const patch = { snoozedUntil: null, snoozeMode: null, version: t.version + 1, updatedAt: now, lastActivityAt: maxDate(t.lastActivityAt, messageSortTs) };
    await tx.update(tasks).set(patch).where(eq(tasks.id, t.id));
    const inMemory = opts.locked?.get(t.id);
    if (inMemory) Object.assign(inMemory, patch);
    await insertEvent(tx, {
      taskId: t.id,
      userId: owner.userId,
      mailboxId: owner.mailboxId,
      messageId: opts.messageId ?? null,
      threadId,
      actor: "system",
      op: "SYSTEM_UNSNOOZE",
      before: { snoozedUntil: t.snoozedUntil, snoozeMode: t.snoozeMode },
      after: { snoozedUntil: null, snoozeMode: null },
      payload: { reason: "reply" },
      applied: true,
      createdAt: now,
    });
    woken.push(t.id);
  }
  return woken;
}

