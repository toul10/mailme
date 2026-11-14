import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { buildDigestModel } from "../../../src/digest/build.js";
import { computeFreshness } from "../../../src/digest/freshness.js";
import { digestSubject } from "../../../src/digest/render.js";
import { addMessage, AT_0730, setup, TODAY, type Fixture } from "../../digest/helpers.js";
import { cliHarness } from "./cli-harness.js";

// Also covers the duplicate finding parked-messages-reported-forever (same bug: parked messages had no lifecycle).

let f: Fixture;
beforeEach(async () => {
  f = await setup(); // last sync 5 min ago: fresh
});
afterEach(() => f.t.close());

const notAnalyzed = (m: Awaited<ReturnType<typeof buildDigestModel>>) => m.problems.filter((p) => p.kind === "not_analyzed").map((p) => p.text);
const delivered = (localDate: string, at: Date) =>
  f.db.insert(s.digests).values({ userId: f.userId, localDate, status: "delivered", createdAt: at, deliveredAt: new Date(at.getTime() + 60_000) });

describe("permanent-failed-banner", () => {
  it("a message parked months ago does not flag every later report as incomplete", async () => {
    await addMessage(f, { state: "failed", subject: "Παλιό", sortTs: new Date("2026-06-01T08:00:00Z"), firstSeenAt: new Date("2026-06-01T08:00:00Z"), updatedAt: new Date("2026-06-01T08:10:00Z") });
    // It was already reported the next morning, and every business day since.
    await f.db.insert(s.digests).values({ userId: f.userId, localDate: "2026-09-23", status: "delivered", createdAt: new Date("2026-09-23T04:30:00Z"), deliveredAt: new Date("2026-09-23T04:30:00Z") });

    const model = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    // Precondition: nothing else is wrong today — no tasks, fresh sync, empty queue, no pause.
    expect(model.freshness.pendingCount).toBe(0);
    expect(model.freshness.paused).toBe(false);
    expect(model.freshness.staleMinutes).toBeLessThanOrEqual(60);
    for (const sec of Object.values(model.sections)) expect(sec.items).toHaveLength(0);

    // Implementation plan E: "Empty day → one line" — impossible forever once any message was parked.
    expect(model.isEmpty).toBe(true);
    expect(model.freshness.banner).toBeNull();
    expect(digestSubject(model)).not.toContain("analysis incomplete");
  });
});

describe("parked-messages-reported-forever", () => {
  beforeEach(async () => {
    // Reports were delivered every business day since the message was parked (last one yesterday).
    for (const d of ["2026-08-26", "2026-09-10", "2026-09-23"]) await delivered(d, new Date(`${d}T04:30:00Z`));
  });

  it("control: a message parked since the previous report is listed and bannered", async () => {
    await addMessage(f, { state: "failed", subject: "Παραγγελία νέα", sortTs: new Date("2026-09-23T09:00:00Z"), updatedAt: new Date("2026-09-23T09:05:00Z") });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(notAnalyzed(m).join("\n")).toContain("Παραγγελία νέα");
    expect(m.freshness.banner).toBe("1 message not analysed");
  });

  it("a message parked a month ago (already reported) is not reported again nor keeps the banner on", async () => {
    await addMessage(f, { state: "failed", subject: "Παραγγελία παλιά", sortTs: new Date("2026-08-25T09:00:00Z"), updatedAt: new Date("2026-08-25T09:05:00Z") });
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(notAnalyzed(m)).toEqual([]);
    expect(m.freshness.banner ?? null).toBeNull();
  });

  it("an acknowledged parked message is neither listed nor bannered, even when parked since the last report", async () => {
    const msg = await addMessage(f, { state: "failed", subject: "Γνωστό πρόβλημα", sortTs: new Date("2026-09-23T09:00:00Z"), updatedAt: new Date("2026-09-23T09:05:00Z") });
    await f.db.update(s.messages).set({ failureAcknowledgedAt: new Date("2026-09-23T10:00:00Z") }).where(eq(s.messages.id, msg.id));
    const m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(notAnalyzed(m)).toEqual([]);
    expect(m.freshness.banner).toBeNull();
  });

  it("CLI lifecycle: messages:parked lists ids/dates/codes, messages:ack stops reporting, messages:retry re-queues", async () => {
    const now = new Date("2026-09-24T09:00:00Z");
    const h = await cliHarness(f.t, now);
    const a = await addMessage(f, { state: "failed", subject: "Απόρρητο θέμα Α", fromAddress: "secret@client-gr.example", sortTs: new Date("2026-09-23T09:00:00Z"), updatedAt: new Date("2026-09-23T09:05:00Z"), lastError: "PER_MESSAGE: 400 prompt too long for «Απόρρητο»", attempts: 1 });
    const b = await addMessage(f, { state: "failed", subject: "Απόρρητο θέμα Β", sortTs: new Date("2026-09-23T10:00:00Z"), updatedAt: new Date("2026-09-23T10:05:00Z"), lastError: "apply: merge_target", textPlain: "κείμενο" });
    const gone = await addMessage(f, { state: "failed", sortTs: new Date("2026-05-01T10:00:00Z"), bodyPurgedAt: new Date("2026-08-01T00:00:00Z") });

    expect(await h.run("messages:parked", "--user", "owner@contoso.example")).toBe(0);
    const listing = h.out.join("\n");
    for (const m of [a, b, gone]) expect(listing).toContain(m.id);
    expect(listing).toMatch(/error PER_MESSAGE$/m);
    expect(listing).toContain("error apply:merge_target");
    expect(listing).toContain("text purged");
    expect(listing).not.toMatch(/Απόρρητο|secret@client|prompt too long/);

    // Acknowledge A: no longer reported (nor listed without --all).
    expect(await h.run("messages:ack", a.id)).toBe(0);
    let m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(notAnalyzed(m).join("\n")).not.toContain("θέμα Α");
    expect(notAnalyzed(m).join("\n")).toContain("θέμα Β");
    h.out.length = 0;
    await h.run("messages:parked");
    expect(h.out.join("\n")).not.toContain(a.id);

    // Retry --all: B goes back to the queue (fresh attempt); the purged one cannot be retried; A's acknowledgement is cleared.
    h.answers.push("y");
    expect(await h.run("messages:retry", "--all", "--mailbox", "owner@contoso.example")).toBe(0);
    const rows = new Map((await f.db.select().from(s.messages)).map((r) => [r.id, r]));
    for (const id of [a.id, b.id]) {
      expect(rows.get(id)).toMatchObject({ state: "pending", attempts: 0, nextAttemptAt: null, lastError: null, failureAcknowledgedAt: null });
      expect(rows.get(id)!.updatedAt).toEqual(now);
    }
    expect(rows.get(gone.id)!.state).toBe("failed");
    expect(h.out.at(-1)).toContain("1 skipped");
    m = await buildDigestModel(f.db, f.userId, TODAY, AT_0730);
    expect(m.freshness.pendingCount).toBe(2);

    expect(await h.run("messages:retry")).toBe(2); // an id or --all is required
    expect(await h.run("messages:ack", "--all", "--yes")).toBe(0);
    expect((await f.db.select().from(s.messages).where(eq(s.messages.id, gone.id)))[0]!.failureAcknowledgedAt).toEqual(now);
  });

  it("the web health banner counts only unacknowledged messages parked in the last 24 h", async () => {
    await addMessage(f, { state: "failed", sortTs: new Date("2026-09-22T09:00:00Z"), updatedAt: new Date("2026-09-22T09:05:00Z") }); // > 24 h
    await addMessage(f, { state: "failed", sortTs: new Date("2026-09-23T09:00:00Z"), updatedAt: new Date("2026-09-23T09:05:00Z") }); // < 24 h
    const fr = await computeFreshness(f.db, f.userId, AT_0730);
    expect(fr.failedCount).toBe(1);
    expect(fr.banner).toBe("1 message not analysed");
  });
});
