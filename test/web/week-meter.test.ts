import { describe, expect, it } from "vitest";
import type { TaskListItem } from "../../src/server/api-types.js";
import { weekLoad } from "../../web/src/ui/WeekMeter.js";

function task(over: Partial<TaskListItem>): TaskListItem {
  return {
    id: over.id ?? "t",
    ref: 1,
    title: "t",
    status: "WAITING_FOR_ME",
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
    lastActivityAt: "2026-09-20T09:00:00Z",
    version: 1,
    evidence: null,
    originEvidence: null,
    reviewCodes: [],
    ownerLabel: null,
    lastMessage: null,
    important: false,
    ...over,
  };
}

describe("weekLoad (the VU meter on Today)", () => {
  // Thursday 24 Sep 2026; the working week is Mon 21 – Fri 25.
  const today = "2026-09-24";

  it("counts late work once, under “Late”, not again on its weekday (the demo morning)", () => {
    const load = weekLoad(
      [
        task({ id: "epsilon", dueDate: "2026-09-22" }), // Tue, this week, late
        task({ id: "abc", dueDate: "2026-09-24" }), // today
        task({ id: "zeta", dueDate: "2026-09-25" }), // tomorrow
        task({ id: "delta", dueDate: "2026-09-26" }), // Saturday: outside Mon–Fri
        task({ id: "xyz", status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-30" }), // next week
      ],
      today,
    );
    expect(load.overdue).toBe(1);
    expect(load.days.map((d) => [d.label, d.count, d.isToday])).toEqual([
      ["Mon", 0, false],
      ["Tue", 0, false],
      ["Wed", 0, false],
      ["Thu", 1, true],
      ["Fri", 1, false],
    ]);
  });

  it("uses the reply-by date for work waiting on others, and ignores undated tasks", () => {
    const load = weekLoad([task({ status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-23" }), task({ status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-25" }), task({})], today);
    expect(load.overdue).toBe(1);
    expect(load.days.find((d) => d.label === "Fri")?.count).toBe(1);
  });

  it("shows next week on a Sunday", () => {
    const load = weekLoad([task({ dueDate: "2026-09-28" })], "2026-09-27");
    expect(load.days[0]).toMatchObject({ date: "2026-09-28", label: "Mon", count: 1 });
  });
});
