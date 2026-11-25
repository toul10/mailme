import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { mailboxes, messages, organizations, taskEvents, taskLinks, tasks, users } from "../db/schema.js";
import { PRIORITIES, SNOOZE_MODES, isOpenStatus, type Clock, type EventOp, type LockableField, type OpenStatus, type Priority, type SnoozeMode } from "../domain/types.js";
import { domainOf, foldForMatch, normalizeAddress } from "../lib/text.js";
import {
  diffSnapshots,
  expirePendingSuggestions,
  insertEvent,
  insertLink,
  priorOpenStatus,
  proposalToTaskValues,
  readSuggestionPayload,
  snapshot,
  type ProposedFields,
} from "./db-events.js";
import { clampText, companyDomainOf, defaultExpectReplyBy, isIsoDate, loadCompanyMap, lookupCompany, mergeItems, pgErrorCode } from "./db-util.js";
import { buildSearchText, insertTaskWithRef, type TaskRow } from "./tasks.js";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
/** Invalid input (bad date, empty title, unknown mode…) → HTTP 400 "invalid". */
export class ValidationError extends Error {}

export interface ActionCtx {
  db: Db;
  clock: Clock;
  userId: string;
  /** Optimistic concurrency: expected tasks.version (409 on mismatch). Omit for one-click links. */
  expectedVersion?: number;
  via: "web" | "link" | "cli";
}

export interface TaskEdit {
  title?: string;
  status?: OpenStatus;
  priority?: Priority;
  dueDate?: string | null;
  nextAction?: string | null;
  summary?: string | null;
  company?: string | null;
  counterpartyAddress?: string | null;
  counterpartyName?: string | null;
}

const LIMITS = { title: 140, nextAction: 200, summary: 600, company: 120, name: 120 } as const;

// ── Plumbing ─────────────────────────────────────────────────────────────────

interface Mutation {
  op: EventOp;
  patch: Partial<TaskRow>;
  lock?: LockableField[];
  payload?: Record<string, unknown>;
  evidence?: { source: string | null; quote: string | null; norm: string | null } | null;
  threadId?: string | null;
  reasons?: string[];
  /** Pending AI suggestions on the task become moot (close / reopen / merge). */
  expireSuggestions?: boolean;
}

/** Deadlock / serialization failure against a concurrent drain or action: retry the whole transaction once. */
async function inTx<T>(ctx: ActionCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ctx.db.transaction(fn);
    } catch (err) {
      const code = pgErrorCode(err);
      if (attempt === 0 && (code === "40P01" || code === "40001")) continue;
      throw err;
    }
  }
}

async function lockOwnedTask(tx: Tx, ctx: ActionCtx, taskId: string, checkVersion = true): Promise<TaskRow> {
  const [t] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, ctx.userId)))
    .for("update");
  if (!t) throw new NotFoundError("task not found");
  if (checkVersion && ctx.expectedVersion !== undefined && t.version !== ctx.expectedVersion) throw new ConflictError("task was changed meanwhile");
  return t;
}

/** Write the patch (+ locks, version, activity), then the user event with before/after of the tracked columns. */
async function commit(tx: Tx, ctx: ActionCtx, t: TaskRow, m: Mutation, now: Date): Promise<void> {
  const patch: Partial<TaskRow> = { ...m.patch };
  const newLocks = (m.lock ?? []).filter((f) => !t.lockedFields.includes(f));
  if (newLocks.length) patch.lockedFields = [...t.lockedFields, ...newLocks];
  const { before, after } = diffSnapshots(t, patch);
  if (["title", "nextAction", "summary", "items", "company", "counterpartyAddress", "counterpartyName"].some((k) => k in patch)) {
    patch.searchText = buildSearchText({ ...t, ...patch });
  }
  patch.version = t.version + 1;
  patch.updatedAt = now;
  patch.lastActivityAt = now;
  await tx.update(tasks).set(patch).where(eq(tasks.id, t.id));
  if (m.expireSuggestions) await expirePendingSuggestions(tx, t.id);
  await insertEvent(tx, {
    taskId: t.id,
    userId: ctx.userId,
    mailboxId: t.mailboxId,
    threadId: m.threadId ?? null,
    actor: "user",
    op: m.op,
    before,
    after,
    payload: { via: ctx.via, ...m.payload },
    evidenceSource: m.evidence?.source ?? null,
    evidenceQuote: m.evidence?.quote ?? null,
    evidenceNorm: m.evidence?.norm ?? null,
    applied: true,
    reasons: m.reasons ?? [],
    createdAt: now,
  });
  Object.assign(t, patch);
}

/** Lock the user's task, check version and merge state, build the mutation, commit — one transaction. */
async function mutate(ctx: ActionCtx, taskId: string, build: (tx: Tx, t: TaskRow, now: Date) => Promise<Mutation | null> | Mutation | null): Promise<void> {
  const now = ctx.clock.now();
  await inTx(ctx, async (tx) => {
    const t = await lockOwnedTask(tx, ctx, taskId);
    if (t.mergedIntoId) throw new ConflictError("task was merged into another task");
    const m = await build(tx, t, now);
    if (m) await commit(tx, ctx, t, m, now);
  });
}

async function orgCalendar(tx: Tx, orgId: string): Promise<{ zone: string; holySpirit: boolean; internalDomains: string[] }> {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
  return { zone: org?.timezone || "Europe/Athens", holySpirit: org?.holySpiritHoliday ?? false, internalDomains: (org?.internalDomains ?? []).map((d) => d.toLowerCase()) };
}

function closePatch(status: "COMPLETED" | "DISMISSED", now: Date, closedAt: Date | null = null): Partial<TaskRow> {
  return { status, closedBy: "user", closedAt: closedAt ?? now, snoozedUntil: null, snoozeMode: null, needsReview: false, reviewReasons: [] };
}

/** Fields that change when a task (re-)enters an open status. */
async function openPatch(tx: Tx, t: TaskRow, status: OpenStatus, now: Date): Promise<Partial<TaskRow>> {
  const patch: Partial<TaskRow> = { status };
  if (!isOpenStatus(t.status)) Object.assign(patch, { closedBy: null, closedAt: null, autoClosedReportedAt: null, dormantAt: null, stillValidAskedAt: null });
  if (status !== "ACTION_REQUIRED" && (status !== t.status || !isOpenStatus(t.status))) patch.waitingSince = now;
  if (status === "WAITING_FOR_OTHER" && patch.waitingSince) {
    const cal = await orgCalendar(tx, t.orgId);
    patch.expectReplyBy = defaultExpectReplyBy(now, cal.zone, cal.holySpirit);
  }
  return patch;
}

/** The thread the task came from (origin/manual link first). */
async function originThread(tx: Tx, taskId: string): Promise<string | null> {
  const links = await tx
    .select({ threadId: taskLinks.threadId, role: taskLinks.role })
    .from(taskLinks)
    .where(and(eq(taskLinks.taskId, taskId), isNotNull(taskLinks.threadId)))
    .orderBy(asc(taskLinks.createdAt));
  return (links.find((l) => l.role === "origin" || l.role === "manual") ?? links[0])?.threadId ?? null;
}

function validDate(v: string | null | undefined, what: string): void {
  if (v !== null && v !== undefined && !isIsoDate(v)) throw new ValidationError(`${what} must be YYYY-MM-DD`);
}

function validAddress(v: string | null | undefined): string | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const a = normalizeAddress(v);
  if (!a) throw new ValidationError("counterpartyAddress is not an e-mail address");
  return a;
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** "Done". Idempotent on an already completed task. */
export async function completeTask(ctx: ActionCtx, taskId: string): Promise<void> {
  await mutate(ctx, taskId, (_tx, t, now) => (t.status === "COMPLETED" ? null : { op: "USER_COMPLETE", patch: closePatch("COMPLETED", now), lock: ["status"], expireSuggestions: true }));
}

/** "Not a task" / "Someone else has it" / other dismissal. not_a_task stores the origin evidence as a negative example for the thread. */
export async function dismissTask(ctx: ActionCtx, taskId: string, kind: "not_a_task" | "handled_by_other" | "other"): Promise<void> {
  const op = ({ not_a_task: "USER_NOT_A_TASK", handled_by_other: "USER_HANDLED_BY_OTHER", other: "USER_DISMISS" } as const)[kind];
  if (!op) throw new ValidationError("unknown dismiss kind");
  await mutate(ctx, taskId, async (tx, t, now) => {
    if (t.status === "DISMISSED") return null;
    let evidence: Mutation["evidence"] = null;
    let threadId = await originThread(tx, t.id);
    if (kind === "not_a_task") {
      const [origin] = await tx
        .select({ source: taskEvents.evidenceSource, quote: taskEvents.evidenceQuote, norm: taskEvents.evidenceNorm, threadId: taskEvents.threadId })
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, t.id), eq(taskEvents.op, "CREATE"), isNotNull(taskEvents.evidenceQuote)))
        .orderBy(asc(taskEvents.createdAt))
        .limit(1);
      if (origin?.quote) evidence = { source: origin.source, quote: origin.quote, norm: origin.norm ?? foldForMatch(origin.quote) };
      threadId = origin?.threadId ?? threadId;
    }
    return { op, patch: closePatch("DISMISSED", now), lock: ["status"], expireSuggestions: true, evidence, threadId, payload: { kind } };
  });
}

/** "Not done — reopen it": back to the open status it had before closing. */
export async function reopenTask(ctx: ActionCtx, taskId: string): Promise<void> {
  await mutate(ctx, taskId, async (tx, t, now) => {
    if (isOpenStatus(t.status)) return null;
    const status = await priorOpenStatus(tx, t.id);
    // A pending "Reopen it?" (or "Close it?") is moot once the user reopened it by hand.
    return { op: "USER_REOPEN", patch: await openPatch(tx, t, status, now), lock: ["status"], expireSuggestions: true };
  });
}

/** "Snooze": until a date, or until the other side replies (optionally with a date as a fallback). */
export async function snoozeTask(ctx: ActionCtx, taskId: string, mode: SnoozeMode, until: string | null): Promise<void> {
  if (!(SNOOZE_MODES as readonly string[]).includes(mode)) throw new ValidationError("unknown snooze mode");
  validDate(until, "until");
  if (mode === "until_date" && !until) throw new ValidationError("until_date needs a date");
  await mutate(ctx, taskId, (_tx, t) => {
    if (!isOpenStatus(t.status)) throw new ConflictError("task is closed");
    const patch: Partial<TaskRow> = { snoozedUntil: until, snoozeMode: mode };
    // The user's date is the follow-up threshold of a waiting task.
    if (mode === "until_date" && t.status === "WAITING_FOR_OTHER") patch.expectReplyBy = until;
    return { op: "USER_SNOOZE", patch, payload: { mode, until } };
  });
}

export async function unsnoozeTask(ctx: ActionCtx, taskId: string): Promise<void> {
  await mutate(ctx, taskId, (_tx, t) => (t.snoozeMode || t.snoozedUntil ? { op: "USER_UNSNOOZE", patch: { snoozedUntil: null, snoozeMode: null } } : null));
}

/** Edit; every field whose value actually changes is locked against later AI changes. */
export async function editTask(ctx: ActionCtx, taskId: string, edit: TaskEdit): Promise<void> {
  if (edit.status !== undefined && !isOpenStatus(edit.status)) throw new ValidationError("status must be an open status");
  if (edit.priority !== undefined && !(PRIORITIES as readonly string[]).includes(edit.priority)) throw new ValidationError("unknown priority");
  validDate(edit.dueDate, "dueDate");
  const counterparty = edit.counterpartyAddress === undefined ? undefined : validAddress(edit.counterpartyAddress);
  await mutate(ctx, taskId, async (tx, t, now) => {
    const patch: Partial<TaskRow> = {};
    const lock: LockableField[] = [];
    if (edit.title !== undefined) {
      const title = clampText(edit.title, LIMITS.title);
      if (!title) throw new ValidationError("title is required");
      if (title !== t.title) patch.title = title;
    }
    if (edit.status !== undefined && edit.status !== t.status) {
      Object.assign(patch, await openPatch(tx, t, edit.status, now));
      lock.push("status");
    }
    if (edit.priority !== undefined && edit.priority !== t.priority) {
      patch.priority = edit.priority;
      lock.push("priority");
    }
    if (edit.dueDate !== undefined && edit.dueDate !== t.dueDate) {
      Object.assign(patch, { dueDate: edit.dueDate, duePhrase: null, dueKind: null });
      lock.push("dueDate");
    }
    const text = (v: string | null | undefined, max: number) => (v === undefined ? undefined : clampText(v, max));
    const nextAction = text(edit.nextAction, LIMITS.nextAction);
    if (nextAction !== undefined && nextAction !== t.nextAction) {
      patch.nextAction = nextAction;
      lock.push("nextAction");
    }
    const summary = text(edit.summary, LIMITS.summary);
    if (summary !== undefined && summary !== t.summary) {
      patch.summary = summary;
      lock.push("summary");
    }
    const company = text(edit.company, LIMITS.company);
    if (company !== undefined && company !== t.company) {
      patch.company = company;
      lock.push("company");
    }
    if (counterparty !== undefined && counterparty !== t.counterpartyAddress) {
      patch.counterpartyAddress = counterparty;
      patch.companyDomain = companyDomainOf(counterparty, (await orgCalendar(tx, t.orgId)).internalDomains);
    }
    const cpName = text(edit.counterpartyName, LIMITS.name);
    if (cpName !== undefined && cpName !== t.counterpartyName) patch.counterpartyName = cpName;
    if (Object.keys(patch).length === 0) return null;
    return { op: "USER_EDIT", patch, lock, payload: { fields: Object.keys(patch) } };
  });
}

/** Merge `mergedId` into `survivorId`: links move, blanks are filled, the merged task is DISMISSED with mergedIntoId. */
export async function mergeTasks(ctx: ActionCtx, survivorId: string, mergedId: string): Promise<void> {
  if (survivorId === mergedId) throw new ValidationError("cannot merge a task into itself");
  const now = ctx.clock.now();
  await inTx(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(inArray(tasks.id, [survivorId, mergedId]), eq(tasks.userId, ctx.userId)))
      .orderBy(asc(tasks.id))
      .for("update");
    const survivor = rows.find((r) => r.id === survivorId);
    const merged = rows.find((r) => r.id === mergedId);
    if (!survivor || !merged) throw new NotFoundError("task not found");
    if (ctx.expectedVersion !== undefined && survivor.version !== ctx.expectedVersion) throw new ConflictError("task was changed meanwhile");
    if (survivor.mergedIntoId || merged.mergedIntoId) throw new ConflictError("task was already merged");

    const links = await tx.select().from(taskLinks).where(eq(taskLinks.taskId, merged.id));
    for (const l of links) await insertLink(tx, { taskId: survivor.id, threadId: l.threadId, messageId: l.messageId, role: l.role, createdAt: l.createdAt });
    await tx.delete(taskLinks).where(eq(taskLinks.taskId, merged.id));
    // Tasks merged into the merged one earlier now point at the survivor.
    await tx.update(tasks).set({ mergedIntoId: survivor.id, updatedAt: now }).where(eq(tasks.mergedIntoId, merged.id));

    const fill: Partial<TaskRow> = {};
    const items = mergeItems(survivor.items, merged.items);
    if (items.length !== survivor.items.length) fill.items = items;
    if (!survivor.dueDate && merged.dueDate) Object.assign(fill, { dueDate: merged.dueDate, duePhrase: merged.duePhrase, dueKind: merged.dueKind });
    for (const k of ["nextAction", "summary", "company", "companyDomain", "counterpartyAddress", "counterpartyName", "expectReplyBy"] as const) {
      if (!survivor[k] && merged[k]) Object.assign(fill, { [k]: merged[k] });
    }
    await commit(tx, ctx, survivor, { op: "USER_MERGE", patch: fill, payload: { role: "survivor", mergedId: merged.id, mergedRef: merged.ref } }, now);
    await commit(
      tx,
      ctx,
      merged,
      {
        op: "USER_MERGE",
        patch: { ...closePatch("DISMISSED", now, isOpenStatus(merged.status) ? null : merged.closedAt), mergedIntoId: survivor.id },
        payload: { role: "merged", survivorId: survivor.id, survivorRef: survivor.ref },
        reasons: ["merged"],
        expireSuggestions: true,
      },
      now,
    );
  });
}

/** «✔» on a new task: the user confirms it is real (clears the review flag). */
export async function confirmTask(ctx: ActionCtx, taskId: string): Promise<void> {
  await mutate(ctx, taskId, (_tx, t) => ({ op: "USER_CONFIRM", patch: t.needsReview || t.reviewReasons.length ? { needsReview: false, reviewReasons: [] } : {} }));
}

/** "Still valid": answer to the aging question; the task is active again. */
export async function markStillValid(ctx: ActionCtx, taskId: string): Promise<void> {
  await mutate(ctx, taskId, (_tx, t) => {
    if (!isOpenStatus(t.status)) throw new ConflictError("task is closed");
    return { op: "USER_STILL_VALID", patch: { stillValidAskedAt: null, dormantAt: null } };
  });
}

/** "I'd have missed this": adoption signal only. */
export async function markWouldHaveMissed(ctx: ActionCtx, taskId: string): Promise<void> {
  await mutate(ctx, taskId, () => ({ op: "USER_WOULD_HAVE_MISSED", patch: {} }));
}

/**
 * A SUGGEST_DISMISS written with a hand-over: the same extraction created (or proposed) a task owned by a colleague
 * (prompt «Hand-over to a colleague»: CREATE owner = colleague + SUGGEST_DISMISS of P1's card).
 */
async function isHandOverSuggestion(tx: Tx, ev: typeof taskEvents.$inferSelect): Promise<boolean> {
  if (ev.op !== "SUGGEST_DISMISS" || !ev.extractionId) return false;
  const [row] = await tx
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .leftJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(
      and(
        eq(taskEvents.extractionId, ev.extractionId),
        eq(taskEvents.op, "CREATE"),
        or(eq(tasks.ownerKind, "INTERNAL"), sql`${taskEvents.payload} -> 'proposed' -> 'task' ->> 'ownerKind' = 'INTERNAL'`),
      ),
    )
    .limit(1);
  return !!row;
}

/** Accept or reject a pending AI suggestion; accepting applies the proposed change to the task's current state. */
export async function resolveSuggestion(ctx: ActionCtx, eventId: string, decision: "accept" | "reject"): Promise<void> {
  if (decision !== "accept" && decision !== "reject") throw new ValidationError("decision must be accept or reject");
  const now = ctx.clock.now();
  await inTx(ctx, async (tx) => {
    const [ev] = await tx.select().from(taskEvents).where(eq(taskEvents.id, eventId)).for("update");
    if (!ev) throw new NotFoundError("suggestion not found");
    const task = ev.taskId ? ((await tx.select().from(tasks).where(eq(tasks.id, ev.taskId)).for("update"))[0] ?? null) : null;
    if ((task?.userId ?? ev.userId) !== ctx.userId) throw new NotFoundError("suggestion not found");
    if (ev.suggestionState !== "pending") throw new ConflictError("suggestion was already resolved");
    const sp = readSuggestionPayload(ev.payload);
    if (!sp) throw new ConflictError("event is not a suggestion");
    if (task && ctx.expectedVersion !== undefined && task.version !== ctx.expectedVersion) throw new ConflictError("task was changed meanwhile");
    if (task?.mergedIntoId) throw new ConflictError("task was merged into another task");
    const payload = { eventId: ev.id, proposedType: sp.proposedType };

    if (decision === "reject") {
      await tx.update(taskEvents).set({ suggestionState: "rejected" }).where(eq(taskEvents.id, ev.id));
      if (task) {
        await commit(tx, ctx, task, { op: "USER_REJECT_SUGGESTION", patch: {}, payload, threadId: ev.threadId }, now);
      } else {
        // A rejected "new task?" is a negative example for the thread, like "Not a task".
        await insertEvent(tx, {
          taskId: null,
          userId: ctx.userId,
          mailboxId: ev.mailboxId,
          messageId: ev.messageId,
          threadId: ev.threadId,
          actor: "user",
          op: "USER_REJECT_SUGGESTION",
          payload: { via: ctx.via, ...payload },
          evidenceSource: ev.evidenceSource,
          evidenceQuote: ev.evidenceQuote,
          evidenceNorm: ev.evidenceNorm ?? (ev.evidenceQuote ? foldForMatch(ev.evidenceQuote) : null),
          applied: true,
          createdAt: now,
        });
      }
      return;
    }

    const proposed = sp.proposed;
    if (proposed.type === "create") {
      if (task) throw new ConflictError("suggestion already has a task");
      const [user] = await tx.select({ orgId: users.orgId }).from(users).where(eq(users.id, ctx.userId));
      if (!user) throw new NotFoundError("user not found");
      const row = await insertTaskWithRef(tx, { ...proposalToTaskValues(proposed.task, { orgId: user.orgId, userId: ctx.userId }, now), lastActivityAt: now });
      if (proposed.task.originMessageId || proposed.task.threadId) {
        await insertLink(tx, { taskId: row.id, threadId: proposed.task.threadId, messageId: proposed.task.originMessageId, role: "origin", createdAt: now });
      }
      await tx.update(taskEvents).set({ suggestionState: "accepted", taskId: row.id }).where(eq(taskEvents.id, ev.id));
      await insertEvent(tx, {
        taskId: row.id,
        userId: ctx.userId,
        mailboxId: row.mailboxId,
        messageId: ev.messageId,
        threadId: ev.threadId,
        actor: "user",
        op: "USER_ACCEPT_SUGGESTION",
        after: snapshot(row),
        payload: { via: ctx.via, ...payload },
        applied: true,
        createdAt: now,
      });
      return;
    }

    if (!task) throw new ConflictError("the suggested task no longer exists");
    const open = isOpenStatus(task.status);
    let m: Mutation;
    switch (proposed.type) {
      case "update": {
        const f: ProposedFields = proposed.fields;
        if (!open && !f.status) throw new ConflictError("task is closed");
        const patch: Partial<TaskRow> = {};
        const lock: LockableField[] = [];
        if (f.status && (f.status !== task.status || !open)) {
          Object.assign(patch, await openPatch(tx, task, f.status, now));
          lock.push("status");
        }
        if ("dueDate" in f && f.dueDate !== task.dueDate) Object.assign(patch, { dueDate: f.dueDate ?? null, duePhrase: f.duePhrase ?? null, dueKind: f.dueKind ?? null });
        else if (!("dueDate" in f) && "duePhrase" in f && !task.dueDate) Object.assign(patch, { duePhrase: f.duePhrase ?? null, dueKind: f.dueKind ?? null });
        if ("expectReplyBy" in f && f.expectReplyBy) patch.expectReplyBy = f.expectReplyBy;
        if (f.priority && f.priority !== task.priority) patch.priority = f.priority;
        if ("nextAction" in f && f.nextAction !== task.nextAction) patch.nextAction = f.nextAction ?? null;
        if ("summary" in f && f.summary !== task.summary) patch.summary = f.summary ?? null;
        if (f.addItems?.length) {
          const items = mergeItems(task.items, f.addItems);
          if (items.length !== task.items.length) patch.items = items;
        }
        m = { op: "USER_ACCEPT_SUGGESTION", patch, lock, payload };
        break;
      }
      case "complete":
        if (!open) throw new ConflictError("task is already closed");
        m = { op: "USER_ACCEPT_SUGGESTION", patch: closePatch("COMPLETED", now), lock: ["status"], payload, expireSuggestions: true };
        break;
      case "dismiss": {
        if (!open) throw new ConflictError("task is already closed");
        // A hand-over ("Maria, can you take this on?") is "Someone else has it", not a verdict on the counterparty.
        const kind = (await isHandOverSuggestion(tx, ev)) ? { kind: "handled_by_other" } : {};
        m = { op: "USER_ACCEPT_SUGGESTION", patch: closePatch("DISMISSED", now), lock: ["status"], payload: { ...payload, ...kind }, expireSuggestions: true };
        break;
      }
      case "reopen": {
        if (open) throw new ConflictError("task is already open");
        m = { op: "USER_ACCEPT_SUGGESTION", patch: await openPatch(tx, task, await priorOpenStatus(tx, task.id), now), lock: ["status"], payload };
        break;
      }
    }
    // Mark accepted first: closing the task expires the *other* pending suggestions.
    await tx.update(taskEvents).set({ suggestionState: "accepted" }).where(eq(taskEvents.id, ev.id));
    await commit(tx, ctx, task, { ...m, threadId: ev.threadId }, now);
  });
}

/**
 * "+ New task" (optionally from a message the AI missed). The task's mailbox: the message's when it comes from
 * one; else `mailboxId` when given (one of the user's own); else the user's only mailbox; else none.
 */
export async function createManualTask(
  ctx: ActionCtx,
  input: TaskEdit & { title: string; status: OpenStatus; fromMessageId?: string | null; mailboxId?: string | null },
): Promise<{ id: string; ref: number }> {
  const title = clampText(input.title, LIMITS.title);
  if (!title) throw new ValidationError("title is required");
  if (!isOpenStatus(input.status)) throw new ValidationError("status must be an open status");
  if (input.priority !== undefined && !(PRIORITIES as readonly string[]).includes(input.priority)) throw new ValidationError("unknown priority");
  validDate(input.dueDate, "dueDate");
  const counterparty = validAddress(input.counterpartyAddress);
  const now = ctx.clock.now();
  return inTx(ctx, async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, ctx.userId));
    if (!user) throw new NotFoundError("user not found");
    let msg: { id: string; mailboxId: string; threadId: string | null; address: string } | null = null;
    if (input.fromMessageId) {
      const [row] = await tx
        .select({ id: messages.id, mailboxId: messages.mailboxId, threadId: messages.threadId, address: mailboxes.address })
        .from(messages)
        .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
        .where(and(eq(messages.id, input.fromMessageId), eq(mailboxes.userId, ctx.userId)));
      if (!row) throw new NotFoundError("message not found");
      msg = row;
    }
    const own = msg ? [] : await tx.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.userId, ctx.userId));
    const chosen = !msg && input.mailboxId ? own.find((m) => m.id === input.mailboxId) : undefined;
    if (!msg && input.mailboxId && !chosen) throw new NotFoundError("mailbox not found");
    const mailbox = msg ? { id: msg.mailboxId, address: msg.address } : (chosen ?? (own.length === 1 ? own[0]! : null));
    const cal = await orgCalendar(tx, user.orgId);
    const company = clampText(input.company, LIMITS.company) ?? lookupCompany(await loadCompanyMap(tx, user.orgId), domainOf(counterparty));
    const fields = {
      title,
      company,
      counterpartyAddress: counterparty,
      counterpartyName: clampText(input.counterpartyName, LIMITS.name),
      nextAction: clampText(input.nextAction, LIMITS.nextAction),
      summary: clampText(input.summary, LIMITS.summary),
      items: [] as string[],
    };
    const row = await insertTaskWithRef(tx, {
      orgId: user.orgId,
      userId: ctx.userId,
      mailboxId: mailbox?.id ?? null,
      ownerKind: "ME",
      ownerAddress: mailbox?.address ?? user.email.toLowerCase(),
      ...fields,
      status: input.status,
      priority: input.priority ?? "NORMAL",
      companyDomain: companyDomainOf(counterparty, cal.internalDomains),
      dueDate: input.dueDate ?? null,
      waitingSince: input.status === "ACTION_REQUIRED" ? null : now,
      expectReplyBy: input.status === "WAITING_FOR_OTHER" ? defaultExpectReplyBy(now, cal.zone, cal.holySpirit) : null,
      origin: "manual",
      originMessageId: msg?.id ?? null,
      lastActivityAt: now,
      searchText: buildSearchText(fields),
      createdAt: now,
      updatedAt: now,
    });
    if (msg) await insertLink(tx, { taskId: row.id, threadId: msg.threadId, messageId: msg.id, role: "manual", createdAt: now });
    await insertEvent(tx, {
      taskId: row.id,
      userId: ctx.userId,
      mailboxId: row.mailboxId,
      messageId: msg?.id ?? null,
      threadId: msg?.threadId ?? null,
      actor: "user",
      op: "USER_CREATE",
      after: snapshot(row),
      payload: { via: ctx.via, fromMessageId: msg?.id ?? null },
      applied: true,
      createdAt: now,
    });
    return { id: row.id, ref: row.ref };
  });
}

