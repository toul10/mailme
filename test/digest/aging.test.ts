import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import { runAging } from "../../src/digest/aging.js";
import { buildDigestModel, sectionTaskIds } from "../../src/digest/build.js";
import { addTask, setup, type Fixture } from "./helpers.js";

const ZONE = "Europe/Athens";
const NOW = new Date("2026-09-24T01:00:00Z"); // Thu 24 Sep 04:00 local
const local = (isoDate: string, hh = "10:00") => new Date(`${isoDate}T${hh}:00+03:00`);

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.t.close());

const task = async (id: string) => (await f.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;
const events = async (id: string) => f.db.select().from(s.taskEvents).where(eq(s.taskEvents.taskId, id));

describe("runAging — snoozes", () => {
  it("unsnoozes until_date snoozes that are due, once", async () => {
    const due = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-24", version: 3, lastActivityAt: local("2026-09-01") });
    const past = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-20" });
    const future = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-25" });
    const reply = await addTask(f, { snoozeMode: "until_reply" });
    const closed = await addTask(f, { status: "COMPLETED", closedBy: "user", snoozeMode: "until_date", snoozedUntil: "2026-09-20" });

    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 2, asked: 0, dormant: 0 });
    const d = await task(due.id);
    expect(d).toMatchObject({ snoozedUntil: null, snoozeMode: null, version: 4 });
    expect(d.lastActivityAt).toEqual(NOW);
    const [ev] = await events(due.id);
    expect(ev).toMatchObject({ actor: "system", op: "SYSTEM_UNSNOOZE", applied: true, before: { snoozedUntil: "2026-09-24", snoozeMode: "until_date" }, after: { snoozedUntil: null, snoozeMode: null } });
    expect((await task(past.id)).snoozedUntil).toBeNull();
    expect((await task(future.id)).snoozedUntil).toBe("2026-09-25");
    expect((await task(reply.id)).snoozeMode).toBe("until_reply");
    expect((await task(closed.id)).snoozedUntil).toBe("2026-09-20");

    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 0 });
    expect(await events(due.id)).toHaveLength(1);
  });

  it("unsnoozes by the local date, not the UTC date", async () => {
    const t = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-25" });
    // 25/09 00:30 local = 24/09 21:30 UTC
    expect((await runAging(f.db, new Date("2026-09-24T21:30:00Z"), ZONE)).unsnoozed).toBe(1);
    expect((await task(t.id)).snoozedUntil).toBeNull();
  });
});

describe("runAging — “Still valid?”", () => {
  it("asks after 7 idle business days, once", async () => {
    const idle7 = await addTask(f, { lastActivityAt: local("2026-09-15") });
    const idle6 = await addTask(f, { lastActivityAt: local("2026-09-16") });
    const overdue = await addTask(f, { dueDate: "2026-09-10", lastActivityAt: local("2026-09-01") });

    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 2, dormant: 0 });
    expect((await task(idle7.id)).stillValidAskedAt).toEqual(NOW);
    expect((await task(overdue.id)).stillValidAskedAt).toEqual(NOW);
    expect((await task(idle6.id)).stillValidAskedAt).toBeNull();
    expect((await events(idle7.id)).map((e) => e.op)).toEqual(["SYSTEM_STILL_VALID_ASKED"]);

    expect(await runAging(f.db, new Date("2026-09-24T09:00:00Z"), ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 0 });
  });

  it("leaves alone tasks that are not reported or have a future deadline", async () => {
    const old = local("2026-08-01");
    // A colleague's task idle 9 business days: never asked, not dormant yet (see “colleagues' tasks”).
    await addTask(f, { ownerKind: "INTERNAL", lastActivityAt: local("2026-09-11") });
    await addTask(f, { mergedIntoId: (await addTask(f, { lastActivityAt: NOW })).id, lastActivityAt: old });
    await addTask(f, { dormantAt: local("2026-09-01"), lastActivityAt: old });
    await addTask(f, { status: "COMPLETED", closedBy: "user", lastActivityAt: old });
    await addTask(f, { dueDate: "2026-09-24", lastActivityAt: old });
    await addTask(f, { dueDate: "2026-10-15", lastActivityAt: old });
    await addTask(f, { status: "WAITING_FOR_OTHER", expectReplyBy: "2026-09-28", lastActivityAt: old });
    await addTask(f, { snoozeMode: "until_reply", lastActivityAt: old });
    await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-10-01", lastActivityAt: old });
    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 0 });
  });

  it("counts business days around Greek holidays (28 October)", async () => {
    const now = new Date("2026-10-30T07:00:00Z"); // Fri 30 Oct
    const seven = await addTask(f, { lastActivityAt: local("2026-10-20") });
    const six = await addTask(f, { lastActivityAt: local("2026-10-21") });
    expect((await runAging(f.db, now, ZONE)).asked).toBe(1);
    expect((await task(seven.id)).stillValidAskedAt).toEqual(now);
    expect((await task(six.id)).stillValidAskedAt).toBeNull();
  });
});

describe("runAging — colleagues' tasks (hand-overs)", () => {
  it("never asks “Still valid?”, goes dormant silently after 10 idle business days", async () => {
    const ten = await addTask(f, { ownerKind: "INTERNAL", lastActivityAt: local("2026-09-10") });
    const nine = await addTask(f, { ownerKind: "INTERNAL", lastActivityAt: local("2026-09-11") });
    const ancient = await addTask(f, { ownerKind: "INTERNAL", status: "WAITING_FOR_OTHER", lastActivityAt: local("2026-08-01") });
    const futureDue = await addTask(f, { ownerKind: "INTERNAL", dueDate: "2026-10-01", lastActivityAt: local("2026-08-01") });
    const userTouched = await addTask(f, { ownerKind: "INTERNAL", lastActivityAt: local("2026-08-01") });
    await f.db.insert(s.taskEvents).values({ taskId: userTouched.id, userId: f.userId, actor: "user", op: "USER_EDIT", createdAt: local("2026-09-21") });

    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 2 });
    for (const t of [ten, ancient]) {
      const row = await task(t.id);
      expect(row.dormantAt).toEqual(NOW);
      expect(row.stillValidAskedAt).toBeNull();
      expect((await events(t.id)).map((e) => e.op)).toEqual(["SYSTEM_DORMANT"]);
    }
    for (const t of [nine, futureDue, userTouched]) expect(await task(t.id)).toMatchObject({ dormantAt: null, stillValidAskedAt: null });
    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 0 });
  });
});

describe("runAging — dormant", () => {
  const delivered = (localDate: string, sections: Record<string, string[]>) =>
    f.db.insert(s.digests).values({ userId: f.userId, localDate, status: "delivered", deliveredAt: local(localDate, "07:30"), sections });

  it("goes dormant 7 business days after the question was shown in a delivered report, unanswered", async () => {
    const unanswered = await addTask(f, { lastActivityAt: local("2026-09-01"), stillValidAskedAt: local("2026-09-15", "04:30") });
    const tooSoon = await addTask(f, { lastActivityAt: local("2026-09-01"), stillValidAskedAt: local("2026-09-16", "04:30") });
    const answeredByActivity = await addTask(f, { lastActivityAt: local("2026-09-17"), stillValidAskedAt: local("2026-09-15", "04:30") });
    const answeredByUser = await addTask(f, { lastActivityAt: local("2026-09-01"), stillValidAskedAt: local("2026-09-15", "04:30") });
    // Asked on the same day, but never in a delivered report (section cap, no report that day …).
    const neverShown = await addTask(f, { lastActivityAt: local("2026-09-01"), stillValidAskedAt: local("2026-09-15", "04:30") });
    await f.db.insert(s.taskEvents).values({ taskId: answeredByUser.id, userId: f.userId, actor: "user", op: "USER_STILL_VALID", createdAt: local("2026-09-16") });
    await delivered("2026-09-15", { stillValid: [unanswered.id, answeredByActivity.id, answeredByUser.id] });
    await delivered("2026-09-16", { stillValid: [tooSoon.id] });

    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 1 });
    const d = await task(unanswered.id);
    expect(d.dormantAt).toEqual(NOW);
    expect(d.status).toBe("ACTION_REQUIRED");
    expect((await events(unanswered.id)).map((e) => e.op)).toEqual(["SYSTEM_DORMANT"]);
    for (const t of [tooSoon, answeredByActivity, answeredByUser, neverShown]) expect((await task(t.id)).dormantAt).toBeNull();
    expect(await runAging(f.db, NOW, ZONE)).toEqual({ unsnoozed: 0, asked: 0, dormant: 0 });
  });

  it("the question tagged on an item of another section counts as shown", async () => {
    const overdue = await addTask(f, { dueDate: "2026-09-01", lastActivityAt: local("2026-09-01"), stillValidAskedAt: local("2026-09-15", "04:30") });
    await delivered("2026-09-15", { today: [overdue.id], stillValid: [] });
    expect((await runAging(f.db, NOW, ZONE)).dormant).toBe(1);
  });

  it("re-asks a task that was answered and then went idle again", async () => {
    const t = await addTask(f, { lastActivityAt: local("2026-09-14"), stillValidAskedAt: local("2026-09-02") });
    expect((await runAging(f.db, NOW, ZONE)).asked).toBe(1);
    expect((await task(t.id)).stillValidAskedAt).toEqual(NOW);
  });

  it("lifecycle: asked → shown → dormant → no longer reported", async () => {
    const t = await addTask(f, { dueDate: "2026-09-01", lastActivityAt: local("2026-08-20") });
    await runAging(f.db, NOW, ZONE);
    let model = await buildDigestModel(f.db, f.userId, "2026-09-24", new Date("2026-09-24T04:30:00Z"));
    expect(model.sections.today.items.find((i) => i.taskId === t.id)!.tags).toContain("Still valid?");
    // Not shown yet (no report delivered): no dormancy clock.
    expect((await runAging(f.db, new Date("2026-10-05T01:00:00Z"), ZONE)).dormant).toBe(0);
    await delivered("2026-09-24", sectionTaskIds(model)); // the 24/09 report went out

    const later = new Date("2026-10-05T01:00:00Z"); // 7 business days after 24/09
    expect((await runAging(f.db, later, ZONE)).dormant).toBe(1);
    model = await buildDigestModel(f.db, f.userId, "2026-10-05", new Date("2026-10-05T04:30:00Z"));
    expect(model.sections.today.items.some((i) => i.taskId === t.id)).toBe(false);
  });
});
