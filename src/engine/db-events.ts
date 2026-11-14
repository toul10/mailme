import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { taskEvents, taskLinks } from "../db/schema.js";
import { OPEN_STATUSES, type OpenStatus, type Priority, type TaskOrigin, type TaskStatus, isOpenStatus } from "../domain/types.js";
import { sqlList } from "./db-util.js";
import { buildSearchText, type NewTaskRow, type TaskRow } from "./tasks.js";

/**
 * task_events / task_links writers and the suggestion payload format shared by apply (AI suggestions)
 * and user actions (resolveSuggestion).
 */

export type NewEventRow = typeof taskEvents.$inferInsert;
export type EventRow = typeof taskEvents.$inferSelect;
export type LinkRole = (typeof taskLinks.$inferInsert)["role"];

/** Insert one event; ON CONFLICT (extraction_id, op_index) DO NOTHING. Returns the id, or null on conflict. */
export async function insertEvent(db: DbOrTx, ev: NewEventRow): Promise<string | null> {
  const rows = await db.insert(taskEvents).values(ev).onConflictDoNothing().returning({ id: taskEvents.id });
  return rows[0]?.id ?? null;
}

export async function insertLink(db: DbOrTx, link: { taskId: string; threadId: string | null; messageId: string | null; role: LinkRole; createdAt?: Date }): Promise<void> {
  await db.insert(taskLinks).values(link).onConflictDoNothing();
}

/** Columns recorded in before/after snapshots (JSON-safe values). */
const SNAPSHOT_FIELDS = [
  "title",
  "status",
  "priority",
  "ownerKind",
  "counterpartyAddress",
  "counterpartyName",
  "company",
  "items",
  "dueDate",
  "duePhrase",
  "dueKind",
  "expectReplyBy",
  "waitingSince",
  "snoozedUntil",
  "snoozeMode",
  "nextAction",
  "summary",
  "needsReview",
  "lockedFields",
  "mergedIntoId",
  "closedBy",
  "closedAt",
] as const satisfies ReadonlyArray<keyof TaskRow>;
type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

function jsonValue(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

/** Full snapshot of the tracked columns of a task. */
export function snapshot(t: Partial<TaskRow>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of SNAPSHOT_FIELDS) if (f in t) out[f] = jsonValue(t[f]);
  return out;
}

/** before/after pair limited to the tracked columns a patch touches. */
export function diffSnapshots(before: TaskRow, patch: Partial<TaskRow>): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const f of SNAPSHOT_FIELDS as readonly SnapshotField[]) {
    if (!(f in patch)) continue;
    b[f] = jsonValue(before[f]);
    a[f] = jsonValue(patch[f]);
  }
  return { before: b, after: a };
}

/**
 * The open status a task had before it was last closed (from the closing event's before/after),
 * falling back to ACTION_REQUIRED. Used by AI and user REOPEN.
 */
export async function priorOpenStatus(db: DbOrTx, taskId: string): Promise<OpenStatus> {
  const [row] = await db
    .select({ status: sql<string | null>`${taskEvents.before}->>'status'` })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        sql`${taskEvents.before}->>'status' in (${sqlList(OPEN_STATUSES)})`,
        sql`${taskEvents.after}->>'status' in ('COMPLETED','DISMISSED')`,
      ),
    )
    .orderBy(desc(taskEvents.createdAt))
    .limit(1);
  const s = row?.status;
  return s && isOpenStatus(s) ? s : "ACTION_REQUIRED";
}

/** Pending suggestions become moot when a task is closed or merged. */
export async function expirePendingSuggestions(db: DbOrTx, taskId: string): Promise<void> {
  await db
    .update(taskEvents)
    .set({ suggestionState: "expired" })
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.suggestionState, "pending")));
}

// ── Suggestions ──────────────────────────────────────────────────────────────

/** Field changes an AI UPDATE proposes (only the ones that were not applied). */
export interface ProposedFields {
  status?: OpenStatus;
  dueDate?: string | null;
  duePhrase?: string | null;
  dueKind?: string | null;
  expectReplyBy?: string | null;
  priority?: Priority;
  nextAction?: string | null;
  summary?: string | null;
  addItems?: string[];
}

/** A task an AI CREATE proposes (suggestion instead of creation). JSON-safe. */
export interface ProposedTask {
  title: string;
  status: OpenStatus;
  priority: Priority;
  ownerKind: TaskRow["ownerKind"];
  ownerAddress: string | null;
  ownerName: string | null;
  counterpartyAddress: string | null;
  counterpartyName: string | null;
  company: string | null;
  companyDomain: string | null;
  items: string[];
  dueDate: string | null;
  duePhrase: string | null;
  dueKind: string | null;
  expectReplyBy: string | null;
  waitingSince: string | null;
  nextAction: string | null;
  summary: string | null;
  origin: TaskOrigin;
  mailboxId: string | null;
  originMessageId: string | null;
  threadId: string | null;
  lastActivityAt: string;
}

export type ProposedChange =
  | { type: "create"; task: ProposedTask }
  | { type: "update"; fields: ProposedFields }
  | { type: "complete" }
  | { type: "reopen" }
  | { type: "dismiss" };

/** task_events.payload of a pending AI suggestion. `proposedType` is duplicated at top level for SQL filters. */
export interface SuggestionPayload {
  kind: "suggestion";
  proposedType: ProposedChange["type"];
  proposed: ProposedChange;
  /** The raw AI operation. */
  op: unknown;
}

export function suggestionPayload(proposed: ProposedChange, op: unknown): SuggestionPayload {
  return { kind: "suggestion", proposedType: proposed.type, proposed, op };
}

export function readSuggestionPayload(payload: unknown): SuggestionPayload | null {
  const p = payload as Partial<SuggestionPayload> | null;
  if (!p || p.kind !== "suggestion" || !p.proposed || typeof p.proposed !== "object") return null;
  const t = (p.proposed as { type?: unknown }).type;
  if (t !== "create" && t !== "update" && t !== "complete" && t !== "reopen" && t !== "dismiss") return null;
  return p as SuggestionPayload;
}

export const CLOSED_STATUSES: readonly TaskStatus[] = ["COMPLETED", "DISMISSED"];

/** Insert values (without ref) for a proposed task. */
export function proposalToTaskValues(p: ProposedTask, ids: { orgId: string; userId: string }, now: Date): Omit<NewTaskRow, "ref"> {
  return {
    orgId: ids.orgId,
    userId: ids.userId,
    mailboxId: p.mailboxId,
    ownerKind: p.ownerKind,
    ownerAddress: p.ownerAddress,
    ownerName: p.ownerName,
    title: p.title,
    status: p.status,
    priority: p.priority,
    counterpartyAddress: p.counterpartyAddress,
    counterpartyName: p.counterpartyName,
    company: p.company,
    companyDomain: p.companyDomain,
    items: p.items,
    dueDate: p.dueDate,
    duePhrase: p.duePhrase,
    dueKind: p.dueKind,
    expectReplyBy: p.expectReplyBy,
    waitingSince: p.waitingSince ? new Date(p.waitingSince) : null,
    nextAction: p.nextAction,
    summary: p.summary,
    origin: p.origin,
    originMessageId: p.originMessageId,
    lastActivityAt: new Date(p.lastActivityAt),
    searchText: buildSearchText(p),
    createdAt: now,
    updatedAt: now,
  };
}
