/**
 * “All” list model: a quick action updates its row in place (so pages loaded with “More” stay), and the row
 * leaves the list only when it no longer belongs to the filter. The membership rules mirror tabSql in
 * src/server/queries.ts; “Snoozed” is a web-only view of the open list. Pure (tested in node).
 */
import type { TaskListItem, TaskTab } from "../../src/server/api-types.js";
import { isOpen, type ListFilter } from "./labels.js";
import { isSnoozed } from "./present.js";

const LIST_KEYS = [
  "id",
  "ref",
  "title",
  "status",
  "priority",
  "company",
  "counterpartyName",
  "counterpartyAddress",
  "nextAction",
  "dueDate",
  "duePhrase",
  "overdue",
  "daysOpen",
  "businessDaysWaiting",
  "expectReplyBy",
  "snoozedUntil",
  "snoozeMode",
  "needsReview",
  "pendingSuggestions",
  "ownerKind",
  "origin",
  "lastActivityAt",
  "version",
  "evidence",
  "originEvidence",
  "reviewCodes",
  "ownerLabel",
  "lastMessage",
  "important",
  "mailboxId",
  "supplier",
] as const satisfies ReadonlyArray<keyof TaskListItem>;

// Fails the typecheck when TaskListItem gains a field this list does not copy.
type Uncopied = Exclude<keyof TaskListItem, (typeof LIST_KEYS)[number]>;
const everyKeyCopied: [Uncopied] extends [never] ? true : never = true;
void everyKeyCopied;

/** The list shape of a TaskDetail (an action's response), without the thread, events and suggestions. */
export function toListItem(item: TaskListItem): TaskListItem {
  const out: Record<string, unknown> = {};
  for (const k of LIST_KEYS) out[k] = item[k];
  return out as unknown as TaskListItem;
}

/** The API tab behind a filter (“Snoozed” is the open list, filtered here). */
export function apiTab(filter: ListFilter): TaskTab {
  return filter === "snoozed" ? "all" : filter;
}

/** Whether a row still belongs to the filter after the user acted on it. */
export function stillListed(item: TaskListItem, filter: ListFilter, today: string): boolean {
  const open = isOpen(item.status);
  const snoozed = isSnoozed(item, today);
  switch (filter) {
    case "all":
      return open;
    case "todo":
      return (item.status === "ACTION_REQUIRED" || item.status === "WAITING_FOR_ME") && (item.ownerKind === "ME" || item.ownerKind === "UNKNOWN") && !snoozed;
    case "waiting":
      return item.status === "WAITING_FOR_OTHER" && !snoozed;
    case "others":
      return item.ownerKind === "INTERNAL" && open;
    case "review":
      return (open && item.needsReview) || item.pendingSuggestions > 0;
    case "closed":
      return item.status === "COMPLETED" || item.status === "DISMISSED";
    case "earlier":
      // “Earlier” = backfill the user never acted on: any action takes it out.
      return false;
    case "snoozed":
      return open && snoozed;
  }
}

/** Rows of “Snoozed” out of the open list. */
export function snoozedOnly(items: TaskListItem[], today: string): TaskListItem[] {
  return items.filter((i) => isOpen(i.status) && isSnoozed(i, today));
}

/**
 * Puts an updated task where it belongs: replaced in place, removed (with its old index, so an undo can put it
 * back), or re-inserted at `insertAt` when it belongs again.
 */
export function placeUpdated(
  items: TaskListItem[],
  updated: TaskListItem,
  filter: ListFilter,
  today: string,
  insertAt?: number,
): { items: TaskListItem[]; removedAt: number | null } {
  const item = toListItem(updated);
  const i = items.findIndex((x) => x.id === item.id);
  const keep = stillListed(item, filter, today);
  if (i >= 0) {
    if (!keep) return { items: items.filter((_, j) => j !== i), removedAt: i };
    const next = items.slice();
    next[i] = item;
    return { items: next, removedAt: null };
  }
  if (!keep) return { items, removedAt: null };
  const at = Math.max(0, Math.min(items.length, insertAt ?? 0));
  return { items: [...items.slice(0, at), item, ...items.slice(at)], removedAt: null };
}
