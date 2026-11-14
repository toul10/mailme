import { describe, expect, it } from "vitest";
import type { TaskDetail, TaskListItem } from "../../src/server/api-types.js";
import { apiTab, placeUpdated, snoozedOnly, stillListed, toListItem } from "../../web/src/list-model.js";

const TODAY = "2026-09-24";

const item = (id: string, o: Partial<TaskListItem> = {}): TaskListItem => ({
  id,
  ref: 1,
  title: `Task ${id}`,
  status: "ACTION_REQUIRED",
  priority: "NORMAL",
  company: null,
  counterpartyName: null,
  counterpartyAddress: null,
  nextAction: null,
  dueDate: null,
  duePhrase: null,
  overdue: false,
  daysOpen: 0,
  businessDaysWaiting: null,
  expectReplyBy: null,
  snoozedUntil: null,
  snoozeMode: null,
  needsReview: false,
  pendingSuggestions: 0,
  ownerKind: "ME",
  origin: "ai",
  lastActivityAt: "2026-09-24T08:00:00Z",
  version: 1,
  evidence: null,
  originEvidence: null,
  reviewCodes: [],
  ownerLabel: null,
  lastMessage: null,
  important: false,
  ...o,
});

describe("list membership after a quick action (mirrors tabSql)", () => {
  it("keeps snoozed rows in “Open”, drops them from “Waiting” and “To do or promised”", () => {
    const snoozed = item("a", { status: "WAITING_FOR_OTHER", snoozedUntil: "2026-09-30", snoozeMode: "until_date" });
    expect(stillListed(snoozed, "all", TODAY)).toBe(true);
    expect(stillListed(snoozed, "waiting", TODAY)).toBe(false);
    expect(stillListed(snoozed, "snoozed", TODAY)).toBe(true);
    expect(stillListed(item("b", { status: "WAITING_FOR_ME", snoozeMode: "until_reply" }), "todo", TODAY)).toBe(false);
    expect(stillListed(item("c", { status: "WAITING_FOR_ME", ownerKind: "INTERNAL" }), "todo", TODAY)).toBe(false);
    expect(stillListed(item("d", { status: "WAITING_FOR_OTHER", ownerKind: "INTERNAL" }), "waiting", TODAY)).toBe(true);
  });

  it("moves closed rows to “Closed” and takes any acted-on row out of “Earlier”", () => {
    const done = item("a", { status: "COMPLETED" });
    expect(stillListed(done, "all", TODAY)).toBe(false);
    expect(stillListed(done, "closed", TODAY)).toBe(true);
    expect(stillListed(item("b"), "earlier", TODAY)).toBe(false);
    expect(stillListed(item("c", { needsReview: true }), "review", TODAY)).toBe(true);
    expect(stillListed(item("d", { status: "COMPLETED", pendingSuggestions: 1 }), "review", TODAY)).toBe(true);
    expect(stillListed(item("e", { ownerKind: "INTERNAL" }), "others", TODAY)).toBe(true);
  });

  it("reads “Snoozed” from the open list", () => {
    expect(apiTab("snoozed")).toBe("all");
    expect(apiTab("waiting")).toBe("waiting");
    const rows = [item("a"), item("b", { snoozedUntil: "2026-09-30", snoozeMode: "until_date" }), item("c", { snoozedUntil: "2026-09-20", snoozeMode: "until_date" })];
    expect(snoozedOnly(rows, TODAY).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("placing an updated row", () => {
  const rows = [item("a"), item("b"), item("c")];

  it("updates in place and keeps every loaded page", () => {
    const r = placeUpdated(rows, item("b", { version: 2, snoozedUntil: "2026-09-30", snoozeMode: "until_date" }), "all", TODAY);
    expect(r.items.map((i) => [i.id, i.version])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 1],
    ]);
    expect(r.removedAt).toBeNull();
  });

  it("removes a row that no longer belongs, and puts it back where it was on undo", () => {
    const r = placeUpdated(rows, item("b", { status: "COMPLETED", version: 2 }), "all", TODAY);
    expect(r.items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(r.removedAt).toBe(1);
    const back = placeUpdated(r.items, item("b", { version: 3 }), "all", TODAY, r.removedAt ?? undefined);
    expect(back.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("stores the list shape of a task detail", () => {
    const detail = { ...item("b", { version: 2 }), messages: [{}], events: [{}], suggestions: [], summary: "s" } as unknown as TaskDetail;
    const r = placeUpdated(rows, detail, "all", TODAY);
    expect(Object.keys(r.items[1]!)).not.toContain("messages");
    expect(toListItem(detail)).toEqual(item("b", { version: 2 }));
  });
});
