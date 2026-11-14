import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { taskEvents, tasks } from "../db/schema.js";
import { R } from "../engine/reconcile-reasons.js";
import type { TaskListItem, TodayResponse, TriageItem } from "./api-types.js";
import {
  CLOSED_TAB_DAYS,
  closedBounceSql,
  earlierSql,
  eventViews,
  OPEN_SQL,
  PENDING_COUNT,
  snoozedSql,
  todayOf,
  toListItem,
  withContext,
  type QueryScope,
  type TaskRow,
} from "./queries.js";

/**
 * "Today" — the home screen: the product's three questions (What do I need to do? What did
 * I promise, and by when? What am I waiting for?) and what the AI needs confirmed. Scoped to the session user,
 * dates in the org timezone.
 *
 * - triage: pending AI suggestions on the user's open or recently closed tasks (newest first, one item per
 *   suggestion), then tasks flagged for review that have no pending suggestion: open ones, and recently closed ones
 *   whose closing mail bounced ("⚠️ Not delivered", queries.ts closedBounceSql). Bounces first, then latest activity.
 *   Review items leave out dormant tasks and the "Earlier" set, which has its own one-time triage. Capped.
 * - doNow / promised / waiting: open, not snoozed, not dormant, not a colleague's (INTERNAL), not "Earlier".
 *   Uncapped (counts equal the list lengths). A task may appear both in triage and in a section.
 * - counts.others: colleagues' open tasks that are not dormant (the "others" tab).
 */

export const TRIAGE_CAP = 10;

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1 };
const rankOf = (p: string) => PRIORITY_RANK[p] ?? 2;

interface Entry {
  row: TaskRow;
  item: TaskListItem;
}

/** Nulls last, then ascending ISO date. */
function byDateAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** Last resort: oldest first, then ref (fully deterministic). */
function byAge(a: Entry, b: Entry): number {
  const d = a.row.createdAt.getTime() - b.row.createdAt.getTime();
  return d !== 0 ? d : a.row.ref - b.row.ref;
}

/** Overdue (oldest due first) → due today → later due dates → undated; then URGENT/HIGH; then oldest. */
function compareDoNow(a: Entry, b: Entry): number {
  return byDateAsc(a.row.dueDate, b.row.dueDate) || rankOf(a.row.priority) - rankOf(b.row.priority) || byAge(a, b);
}

/** Earliest promised date first, undated last. */
function comparePromised(a: Entry, b: Entry): number {
  return byDateAsc(a.row.dueDate, b.row.dueDate) || rankOf(a.row.priority) - rankOf(b.row.priority) || byAge(a, b);
}

/**
 * Past the expected-reply date first (on or before today — the report's "Follow up" rule), then the longest
 * wait in business days.
 */
function compareWaiting(today: string) {
  const past = (e: Entry) => (e.row.expectReplyBy !== null && e.row.expectReplyBy <= today ? 0 : 1);
  return (a: Entry, b: Entry): number =>
    past(a) - past(b) || (b.item.businessDaysWaiting ?? -1) - (a.item.businessDaysWaiting ?? -1) || byDateAsc(a.row.expectReplyBy, b.row.expectReplyBy) || byAge(a, b);
}

export async function getToday(db: Db, scope: QueryScope): Promise<TodayResponse> {
  const today = todayOf(scope);
  const closedSince = new Date(scope.now.getTime() - CLOSED_TAB_DAYS * 86_400_000);

  // Every open task of the user, with the flags the sections need (same snoozed/"Earlier" rules as the tabs).
  const openRows = await db
    .select({ task: tasks, pending: PENDING_COUNT, snoozed: sql<boolean>`${snoozedSql(today)}`, earlier: sql<boolean>`${earlierSql(scope.now)}` })
    .from(tasks)
    .where(and(eq(tasks.userId, scope.userId), isNull(tasks.mergedIntoId), OPEN_SQL));

  // Pending suggestions on open or recently closed tasks (a REOPEN suggestion targets a closed one).
  const pendingRows = await db
    .select({ event: taskEvents, task: tasks, pending: PENDING_COUNT })
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(
      and(
        eq(tasks.userId, scope.userId),
        isNull(tasks.mergedIntoId),
        eq(taskEvents.suggestionState, "pending"),
        or(OPEN_SQL, sql`${tasks.closedAt} >= ${closedSince.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(desc(taskEvents.createdAt), desc(taskEvents.id));

  // Recently closed tasks whose closing mail bounced: still something to look at.
  const bouncedRows = await db
    .select({ task: tasks, pending: PENDING_COUNT })
    .from(tasks)
    .where(and(eq(tasks.userId, scope.userId), isNull(tasks.mergedIntoId), closedBounceSql(scope.now)));

  // One list item per task, shared by triage and sections.
  const entries = new Map<string, Entry>();
  const entryOf = (row: TaskRow, pending: number): Entry => {
    let e = entries.get(row.id);
    if (!e) entries.set(row.id, (e = { row, item: toListItem(row, pending, scope) }));
    return e;
  };

  // Triage.
  const bounced = (t: TaskRow) => (t.reviewReasons.includes(R.BOUNCE) ? 0 : 1);
  const reviewRows = [...openRows.filter((r) => r.task.needsReview && r.task.dormantAt === null && !r.earlier), ...bouncedRows]
    .filter((r) => Number(r.pending) === 0)
    .sort((a, b) => bounced(a.task) - bounced(b.task) || b.task.lastActivityAt.getTime() - a.task.lastActivityAt.getTime() || (a.task.id < b.task.id ? -1 : 1));
  const shownSuggestions = pendingRows.slice(0, TRIAGE_CAP);
  const shownReviews = reviewRows.slice(0, TRIAGE_CAP - shownSuggestions.length);
  const suggestionViews = await eventViews(db, scope.userId, shownSuggestions.map((r) => r.event));
  const triage: TriageItem[] = [
    ...shownSuggestions.map((r, i): TriageItem => ({ kind: "suggestion", task: entryOf(r.task, Number(r.pending)).item, suggestion: suggestionViews[i]! })),
    ...shownReviews.map((r): TriageItem => ({ kind: "review", task: entryOf(r.task, Number(r.pending)).item, suggestion: null })),
  ];

  // Sections.
  const eligible = openRows.filter(
    (r) =>
      r.task.ownerKind !== "INTERNAL" &&
      r.task.dormantAt === null &&
      !r.earlier &&
      (r.task.status !== "ACTION_REQUIRED" || r.task.ownerKind === "ME" || r.task.ownerKind === "UNKNOWN"),
  );
  const active = eligible.filter((r) => !r.snoozed).map((r) => entryOf(r.task, Number(r.pending)));
  const doNow = active.filter((e) => e.row.status === "ACTION_REQUIRED").sort(compareDoNow);
  const promised = active.filter((e) => e.row.status === "WAITING_FOR_ME").sort(comparePromised);
  const waiting = active.filter((e) => e.row.status === "WAITING_FOR_OTHER").sort(compareWaiting(today));

  await withContext(db, scope.userId, [...entries.values()].map((e) => e.item));
  // "Important" first in every section; each part keeps the section's own order.
  const importantFirst = (list: Entry[]) => [...list.filter((e) => e.item.important), ...list.filter((e) => !e.item.important)].map((e) => e.item);

  return {
    date: today,
    triage,
    doNow: importantFirst(doNow),
    promised: importantFirst(promised),
    waiting: importantFirst(waiting),
    counts: {
      triage: pendingRows.length + reviewRows.length,
      doNow: doNow.length,
      promised: promised.length,
      waiting: waiting.length,
      snoozed: eligible.filter((r) => r.snoozed).length,
      others: openRows.filter((r) => r.task.ownerKind === "INTERNAL" && r.task.dormantAt === null).length,
      earlier: openRows.filter((r) => r.earlier).length,
    },
  };
}
