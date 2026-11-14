import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import { buildDigestModel, SECTION_ORDER } from "../../src/digest/build.js";
import type { DigestModel } from "../../src/digest/model.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { addMessage, addTask, AT_0730, linkMessage, setup, TODAY, type Fixture } from "./helpers.js";

let shared: TestDb;
beforeAll(async () => {
  shared = await createTestDb();
});
afterAll(() => shared.close());

const fresh = () => setup({ shared });
const YESTERDAY_10 = new Date("2026-09-23T07:00:00Z"); // Wed 23 Sep 10:00 local
const OLD = new Date("2026-09-01T08:00:00Z");

function sectionOf(model: DigestModel, taskId: string): string[] {
  return (Object.keys(model.sections) as Array<keyof DigestModel["sections"]>).filter((k) => model.sections[k].items.some((i) => i.taskId === taskId));
}

function ids(model: DigestModel, key: keyof DigestModel["sections"]): string[] {
  return model.sections[key].items.map((i) => i.taskId);
}

describe("buildDigestModel — section precedence", () => {
  let f: Fixture;
  let model: DigestModel;
  const t: Record<string, string> = {};

  beforeAll(async () => {
    f = await fresh();
    const add = async (name: string, o: Partial<typeof s.tasks.$inferInsert>) => {
      t[name] = (await addTask(f, { title: `Task ${name}`, ...o })).id;
    };
    await add("overdue", { dueDate: "2026-09-22" });
    await add("promiseToday", { status: "WAITING_FOR_ME", dueDate: TODAY });
    await add("promise3bd", { status: "WAITING_FOR_ME", dueDate: "2026-09-29" });
    await add("promise4bd", { status: "WAITING_FOR_ME", dueDate: "2026-09-30" });
    await add("followup", { status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-23", waitingSince: new Date("2026-09-17T08:00:00Z") });
    await add("followupFuture", { status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-25" });
    await add("new", { createdAt: YESTERDAY_10 });
    await add("newAndDue", { createdAt: YESTERDAY_10, dueDate: TODAY });
    await add("newAndFollowup", { createdAt: YESTERDAY_10, status: "WAITING_FOR_OTHER", expectReplyBy: TODAY });
    await add("autoClosed", { status: "COMPLETED", closedBy: "ai", closedAt: YESTERDAY_10 });
    await add("autoClosedNewDue", { status: "COMPLETED", closedBy: "ai", closedAt: YESTERDAY_10, createdAt: YESTERDAY_10, dueDate: "2026-09-20" });
    await add("userClosed", { status: "COMPLETED", closedBy: "user", closedAt: YESTERDAY_10 });
    await add("autoClosedReported", { status: "COMPLETED", closedBy: "ai", closedAt: OLD, autoClosedReportedAt: OLD });
    await add("stillValid", { stillValidAskedAt: new Date("2026-09-23T05:00:00Z"), lastActivityAt: new Date("2026-09-10T08:00:00Z") });
    await add("internal", { ownerKind: "INTERNAL", dueDate: TODAY });
    await add("merged", { dueDate: TODAY, mergedIntoId: t.overdue! });
    await add("dormant", { dueDate: "2026-09-01", dormantAt: new Date("2026-09-20T08:00:00Z") });
    await add("snoozedDate", { dueDate: "2026-09-22", snoozeMode: "until_date", snoozedUntil: "2026-09-30" });
    await add("snoozedReply", { dueDate: "2026-09-22", snoozeMode: "until_reply" });
    await add("manualNew", { origin: "manual", createdAt: YESTERDAY_10 });
    await add("backfillNew", { origin: "backfill", createdAt: YESTERDAY_10 });
    await add("plainOpen", {});
    model = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
  });

  it("puts every task in exactly one section, first match wins", () => {
    const expected: Record<string, string | null> = {
      overdue: "today",
      promiseToday: "today",
      promise3bd: "promises",
      promise4bd: null,
      followup: "followup",
      followupFuture: null,
      new: "new",
      newAndDue: "today",
      newAndFollowup: "followup",
      autoClosed: "autoClosed",
      autoClosedNewDue: "autoClosed",
      userClosed: null,
      autoClosedReported: null,
      stillValid: "stillValid",
      internal: null,
      merged: null,
      dormant: null,
      snoozedDate: null,
      snoozedReply: null,
      manualNew: null,
      backfillNew: null,
      plainOpen: null,
    };
    for (const [name, section] of Object.entries(expected)) {
      expect({ name, sections: sectionOf(model, t[name]!) }).toEqual({ name, sections: section ? [section] : [] });
    }
    const all = SECTION_ORDER.flatMap((k) => ids(model, k));
    expect(new Set(all).size).toBe(all.length);
  });

  it("tags promises due today “Promised for …” and follow-ups with the expected date", () => {
    const promise = model.sections.today.items.find((i) => i.taskId === t.promiseToday)!;
    expect(promise.tags).toContain("Promised for 24 Sep");
    const overdue = model.sections.today.items.find((i) => i.taskId === t.overdue)!;
    expect(overdue.tags.some((x) => x.startsWith("Promised"))).toBe(false);
    const fu = model.sections.followup.items.find((i) => i.taskId === t.followup)!;
    expect(fu.tags).toContain("Reply expected by 23 Sep");
    expect(fu.businessDaysWaiting).toBe(5);
  });

  it("fills header fields and counts", () => {
    expect(model.weekdayLabel).toBe("Thursday 24 Sep");
    expect(model.userName).toBe("Owner Person");
    expect(model.localDate).toBe(TODAY);
    expect(model.late).toBe(false);
    expect(model.counts.actionToday).toBe(3);
    expect(model.counts.overdue).toBe(1);
    expect(model.counts.waiting).toBe(3);
    // open, visible, not snoozed: overdue, promiseToday, promise3bd, promise4bd, followup, followupFuture, new, newAndDue,
    // newAndFollowup, stillValid, manualNew, backfillNew, plainOpen
    expect(model.counts.openTotal).toBe(13);
    expect(model.isEmpty).toBe(false);
    expect(model.freshness.banner).toBeNull();
  });
});

describe("buildDigestModel — caps and ordering", () => {
  it("caps each section and reports the rest as +N", async () => {
    const f = await fresh();
    for (let i = 0; i < 9; i++) await addTask(f, { dueDate: "2026-09-21" });
    for (let i = 0; i < 6; i++) await addTask(f, { status: "WAITING_FOR_ME", dueDate: "2026-09-28" });
    for (let i = 0; i < 6; i++) await addTask(f, { status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-20" });
    for (let i = 0; i < 8; i++) await addTask(f, { createdAt: YESTERDAY_10 });
    for (let i = 0; i < 6; i++) await addTask(f, { status: "COMPLETED", closedBy: "ai", closedAt: YESTERDAY_10 });
    for (let i = 0; i < 5; i++) await addTask(f, { stillValidAskedAt: YESTERDAY_10, lastActivityAt: OLD });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    const shape = Object.fromEntries(SECTION_ORDER.map((k) => [k, [m.sections[k].items.length, m.sections[k].more]]));
    expect(shape).toEqual({ today: [7, 2], promises: [5, 1], followup: [5, 1], new: [7, 1], autoClosed: [5, 1], stillValid: [3, 2] });
    expect(m.counts.actionToday).toBe(9);
  });

  it("sorts deterministically: overdue desc → due today → due date → URGENT/HIGH → waiting → age → ref", async () => {
    const f = await fresh();
    const mk = (title: string, o: Partial<typeof s.tasks.$inferInsert>) => addTask(f, { title, ...o });
    await mk("today-normal-newer", { dueDate: TODAY, createdAt: new Date("2026-09-15T08:00:00Z") });
    await mk("overdue-1", { dueDate: "2026-09-23" });
    await mk("today-high", { dueDate: TODAY, priority: "HIGH" });
    await mk("today-normal-older", { dueDate: TODAY, createdAt: new Date("2026-09-05T08:00:00Z") });
    await mk("overdue-5", { dueDate: "2026-09-19" });
    await mk("today-urgent", { dueDate: TODAY, priority: "URGENT" });
    const sameAge = new Date("2026-09-15T08:00:00Z");
    await mk("today-normal-tie-a", { dueDate: TODAY, createdAt: sameAge });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(m.sections.today.items.map((i) => i.title)).toEqual([
      "overdue-5",
      "overdue-1",
      "today-urgent",
      "today-high",
      "today-normal-older",
      "today-normal-newer",
      "today-normal-tie-a",
    ]);
    expect(m.sections.today.items.map((i) => i.overdueDays)).toEqual([5, 1, 0, 0, 0, 0, 0]);
  });

  it("orders promises by nearest date and follow-ups by business days waiting", async () => {
    const f = await fresh();
    await addTask(f, { title: "p-29", status: "WAITING_FOR_ME", dueDate: "2026-09-29" });
    await addTask(f, { title: "p-25", status: "WAITING_FOR_ME", dueDate: "2026-09-25" });
    await addTask(f, { title: "p-28-urgent", status: "WAITING_FOR_ME", dueDate: "2026-09-28", priority: "URGENT" });
    await addTask(f, { title: "w-2", status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-23", waitingSince: new Date("2026-09-22T08:00:00Z") });
    await addTask(f, { title: "w-10", status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-15", waitingSince: new Date("2026-09-10T08:00:00Z") });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(m.sections.promises.items.map((i) => i.title)).toEqual(["p-25", "p-28-urgent", "p-29"]);
    expect(m.sections.followup.items.map((i) => [i.title, i.businessDaysWaiting])).toEqual([
      ["w-10", 10],
      ["w-2", 2],
    ]);
  });
});

describe("buildDigestModel — item fields", () => {
  it("takes subject/sender/date from the latest linked message", async () => {
    const f = await fresh();
    const task = await addTask(f, { dueDate: TODAY, nextAction: "Στείλε https://evil.gr/x στο 6912345678" });
    const older = await addMessage(f, { subject: "Προσφορά ABC", sortTs: new Date("2026-09-20T07:00:00Z") });
    const newer = await addMessage(f, { subject: "ΑΠ: Προσφορά ABC", fromName: null, fromAddress: "maria@abc-gr.example", sortTs: new Date("2026-09-22T07:02:00Z") });
    await linkMessage(f, task.id, older.id);
    await linkMessage(f, task.id, newer.id);
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    const it0 = m.sections.today.items[0]!;
    expect(it0).toMatchObject({ subject: "ΑΠ: Προσφορά ABC", sender: "maria@abc-gr.example", lastMessageDate: "2026-09-22 10:02", company: "ABC" });
    expect(it0.nextAction).toBe("Στείλε [link] στο [phone]");
  });

  it("shows “You → …” when the latest message is outbound, and falls back to the linked thread", async () => {
    const f = await fresh();
    const th = (await f.db.insert(s.threads).values({ mailboxId: f.mailboxId }).returning())[0]!;
    const a = await addTask(f, { dueDate: TODAY });
    const out = await addMessage(f, { direction: "OUTBOUND", fromAddress: "owner@contoso.example", to: [{ address: "client@abc-gr.example", name: "Γιώργος" }], sortTs: new Date("2026-09-23T09:00:00Z") });
    await linkMessage(f, a.id, out.id);
    const b = await addTask(f, { dueDate: TODAY });
    await addMessage(f, { threadId: th.id, subject: "Thread first", sortTs: new Date("2026-09-20T07:00:00Z") });
    await addMessage(f, { threadId: th.id, subject: "Thread last", sortTs: new Date("2026-09-21T07:00:00Z") });
    await f.db.insert(s.taskLinks).values({ taskId: b.id, threadId: th.id, messageId: null, role: "reference" });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    const byId = new Map(m.sections.today.items.map((i) => [i.taskId, i]));
    expect(byId.get(a.id)!.sender).toBe("You → Γιώργος");
    expect(byId.get(b.id)!.subject).toBe("Thread last");
  });

  it("strips links and contacts from AI-written titles", async () => {
    const f = await fresh();
    await addTask(f, { dueDate: TODAY, title: "Πληρωμή στο www.evil.gr ή pay@evil.gr <script>" });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(m.sections.today.items[0]!.title).toBe("Πληρωμή στο [link] ή [email] <script>");
  });
});

describe("buildDigestModel — “New” window and first report", () => {
  it("without a previous digest, “new” starts at local yesterday 00:00", async () => {
    const f = await fresh();
    const inside = await addTask(f, { createdAt: new Date("2026-09-22T21:30:00Z") }); // 23/09 00:30 local
    const outside = await addTask(f, { createdAt: new Date("2026-09-22T20:30:00Z") }); // 22/09 23:30 local
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(m, "new")).toEqual([inside.id]);
    expect(sectionOf(m, outside.id)).toEqual([]);
  });

  it("with a previous delivered digest, “new” starts at that digest", async () => {
    const f = await fresh();
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered", createdAt: new Date("2026-09-23T04:30:00Z"), deliveredAt: new Date("2026-09-23T04:30:05Z") });
    const before = await addTask(f, { createdAt: new Date("2026-09-23T03:00:00Z") });
    const after = await addTask(f, { createdAt: new Date("2026-09-23T05:00:00Z") });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(m, "new")).toEqual([after.id]);
    expect(sectionOf(m, before.id)).toEqual([]);
  });

  it("a failed or skipped previous digest does not move the window", async () => {
    const f = await fresh();
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "failed", createdAt: new Date("2026-09-23T04:30:00Z") });
    const early = await addTask(f, { createdAt: new Date("2026-09-23T03:00:00Z") });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(m, "new")).toEqual([early.id]);
  });

  it("stale backfill tasks stay in the “Earlier” triage (out of every report) until the user acts on them", async () => {
    const f = await fresh();
    const stale = await addTask(f, { origin: "backfill", dueDate: "2026-09-15", lastActivityAt: new Date("2026-09-10T08:00:00Z") });
    const recent = await addTask(f, { origin: "backfill", dueDate: "2026-09-15", lastActivityAt: new Date("2026-09-22T08:00:00Z") });
    const first = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(first, "today")).toEqual([recent.id]);
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered", createdAt: new Date("2026-09-23T04:30:00Z"), deliveredAt: new Date("2026-09-23T04:30:00Z") });
    const later = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(later, "today")).toEqual([recent.id]);
    // Confirming it in the triage tab brings it into the normal flow.
    await f.db.insert(s.taskEvents).values({ taskId: stale.id, userId: f.userId, actor: "user", op: "USER_CONFIRM", applied: true });
    const triaged = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(triaged, "today").sort()).toEqual([stale.id, recent.id].sort());
  });

  it("handles the DST change: “new” since local midnight on the Sunday the clocks go back", async () => {
    const f = await fresh();
    const monday = "2026-10-26";
    const now = new Date("2026-10-26T05:30:00Z"); // 07:30 EET
    const inside = await addTask(f, { createdAt: new Date("2026-10-24T21:30:00Z") }); // Sun 25 Oct 00:30 EEST
    await addTask(f, { createdAt: new Date("2026-10-24T20:30:00Z") }); // Sat 24 Oct 23:30 EEST
    const due = await addTask(f, { dueDate: "2026-10-23" });
    const m = await buildDigestModel(f.db, f.userId, monday, now);
    expect(m.weekdayLabel).toBe("Monday 26 Oct");
    expect(ids(m, "new")).toEqual([inside.id]);
    expect(m.sections.today.items.find((i) => i.taskId === due.id)!.overdueDays).toBe(3);
  });
});

describe("buildDigestModel — “Still valid?” and snoozes", () => {
  it("shows an unanswered question once, and tags it in other sections", async () => {
    const f = await fresh();
    const askedAt = new Date("2026-09-23T05:00:00Z");
    const shownBefore = await addTask(f, { stillValidAskedAt: askedAt, lastActivityAt: OLD });
    const notShown = await addTask(f, { stillValidAskedAt: askedAt, lastActivityAt: OLD });
    const answeredByEvent = await addTask(f, { stillValidAskedAt: askedAt, lastActivityAt: OLD });
    const answeredByActivity = await addTask(f, { stillValidAskedAt: askedAt, lastActivityAt: new Date("2026-09-23T09:00:00Z") });
    const overdueAsked = await addTask(f, { dueDate: "2026-09-10", stillValidAskedAt: askedAt, lastActivityAt: OLD });
    await f.db.insert(s.taskEvents).values({ taskId: answeredByEvent.id, userId: f.userId, actor: "user", op: "USER_STILL_VALID", createdAt: new Date("2026-09-23T10:00:00Z") });
    await f.db.insert(s.digests).values({
      userId: f.userId,
      localDate: "2026-09-23",
      status: "delivered",
      createdAt: new Date("2026-09-23T04:30:00Z"),
      deliveredAt: new Date("2026-09-23T06:00:00Z"),
      sections: { stillValid: [shownBefore.id] },
    });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(m, "stillValid")).toEqual([notShown.id]);
    for (const x of [shownBefore, answeredByEvent, answeredByActivity]) expect(sectionOf(m, x.id)).toEqual([]);
    const tagged = m.sections.today.items.find((i) => i.taskId === overdueAsked.id)!;
    expect(tagged.tags).toContain("Still valid?");
  });

  it("brings back tasks whose until_date snooze ended (not yet cleared, or cleared by aging since the last digest)", async () => {
    const f = await fresh();
    const expired = await addTask(f, { snoozeMode: "until_date", snoozedUntil: TODAY });
    const cleared = await addTask(f, {});
    await f.db.insert(s.taskEvents).values({ taskId: cleared.id, userId: f.userId, actor: "system", op: "SYSTEM_UNSNOOZE", createdAt: new Date("2026-09-24T01:00:00Z") });
    const future = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-25", dueDate: "2026-09-20" });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(ids(m, "today").sort()).toEqual([expired.id, cleared.id].sort());
    expect(m.sections.today.items.every((i) => i.tags.includes("Back from snooze"))).toBe(true);
    expect(sectionOf(m, future.id)).toEqual([]);
  });
});

describe("buildDigestModel — problems", () => {
  it("lists not-analysed messages (capped) and bounced tasks", async () => {
    const f = await fresh();
    for (let i = 0; i < 6; i++) {
      await addMessage(f, { state: "failed", subject: `Παραγγελία ${i}`, fromName: "Πελάτης", sortTs: new Date(`2026-09-2${i % 3}T07:0${i}:00Z`) });
    }
    const bounced = await addTask(f, { status: "COMPLETED", closedBy: "ai", closedAt: YESTERDAY_10, autoClosedReportedAt: YESTERDAY_10, title: "ABC — Αποστολή προσφοράς" });
    await f.db.insert(s.taskEvents).values({ taskId: bounced.id, userId: f.userId, actor: "system", op: "SYSTEM_BOUNCE", payload: { recipient: "client@abc-gr.example" }, createdAt: new Date("2026-09-23T12:00:00Z") });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    const notAnalyzed = m.problems.filter((p) => p.kind === "not_analyzed");
    expect(notAnalyzed).toHaveLength(6);
    expect(notAnalyzed[0]!.text).toMatch(/^Not analysed: “Παραγγελία \d” — Πελάτης · (Mon|Tue|Wed) \d\d Sep \d\d:\d\d$/);
    expect(notAnalyzed[5]!.text).toBe("… and 1 more message not analysed");
    expect(ids(m, "problems")).toEqual([bounced.id]);
    expect(m.sections.problems.items[0]!.tags).toContain("⚠️ Not delivered to client@abc-gr.example");
    expect(m.problems.find((p) => p.kind === "bounce")!.text).toBe(`Not delivered to client@abc-gr.example: #${bounced.ref} ABC — Αποστολή προσφοράς`);
    expect(m.freshness.failedCount).toBe(6);
    expect(m.freshness.banner).toBe("6 messages not analysed");
    expect(m.isEmpty).toBe(false);
  });

  it("an empty day is empty", async () => {
    const f = await fresh();
    await addTask(f, { status: "WAITING_FOR_ME", dueDate: "2026-10-15" });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(m.isEmpty).toBe(true);
    expect(m.counts.openTotal).toBe(1);
  });

  it("sets the late flag", async () => {
    const f = await fresh();
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730, { late: true });
    expect(m.late).toBe(true);
  });
});
