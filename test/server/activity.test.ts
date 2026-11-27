import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock, withSessionLock } from "../../src/db/client.js";
import * as s from "../../src/db/schema.js";
import { pgLockProbe, type LockProbe } from "../../src/server/activity.js";
import type { HealthSummary, MailboxActivity } from "../../src/server/api-types.js";
import { addUser, api, makeHarness, sessionFor, type Harness } from "./helpers.js";

/** The sync bar's data (HealthSummary.activity): pass running, mailbox being analysed, progress, pauses. */
describe("GET /api/health — activity", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  let seq = 0;
  async function message(mailboxId: string, state: (typeof s.messages.$inferInsert)["state"] = "pending") {
    const [m] = await h.t.db
      .insert(s.messages)
      .values({ mailboxId, messageKey: `a${++seq}@x`, direction: "INBOUND", fromAddress: "maria@abc-gr.example", subject: `Subject ${seq}`, sortTs: new Date("2026-09-15T05:00:00Z"), state })
      .returning();
    return m!;
  }
  async function analysed(m: { id: string; mailboxId: string }, at: string) {
    await h.t.db.insert(s.extractions).values({ messageId: m.id, mailboxId: m.mailboxId, pipelineVersion: "p1", attempt: ++seq, status: "ok", costUsd: 0.01, createdAt: new Date(at) });
  }
  async function activity(probe: LockProbe | null): Promise<HealthSummary["activity"]> {
    h = await makeHarness(probe ? { lockProbe: probe } : {});
    return (await load()).activity;
  }
  async function load(): Promise<HealthSummary> {
    const me = await sessionFor(h, h.seed.user.id);
    const res = await api(h, me, "GET", "/api/health");
    expect(res.statusCode).toBe(200);
    return res.json() as HealthSummary;
  }
  const own = (a: HealthSummary["activity"]): MailboxActivity => {
    expect(a.mailboxes).toHaveLength(1);
    return a.mailboxes[0]!;
  };

  it("no pass running: the queue, today's and the last 10 minutes' analyses, own mailboxes only", async () => {
    h = await makeHarness({ lockProbe: async () => new Map() });
    const mb = h.seed.mailbox.id;
    await message(mb);
    await message(mb);
    await message(mb, "extracted");
    const done = await message(mb, "applied");
    const older = await message(mb, "applied");
    const yesterday = await message(mb, "applied");
    // The clock is 2026-09-15T07:00Z (10:00 Athens): 06:55 is recent, 06:00 only today, 20:00Z yesterday (23:00).
    await analysed(done, "2026-09-15T06:55:00Z");
    await analysed(older, "2026-09-15T06:00:00Z");
    await analysed(yesterday, "2026-09-14T20:00:00Z");
    const colleague = await addUser(h, { email: "colleague@contoso.example" });
    const [theirs] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: colleague.id, address: "colleague@contoso.example", status: "active" }).returning();
    await analysed(await message(theirs!.id, "applied"), "2026-09-15T06:58:00Z");

    const a = (await load()).activity;
    expect(a).toMatchObject({ running: false, runningSince: null, globalPaused: false });
    expect(own(a)).toEqual({
      id: mb,
      address: h.seed.mailbox.address,
      provider: "imap",
      status: "active",
      lastSyncAt: null,
      analysing: false,
      queued: 3,
      done: 1,
      doneToday: 2,
      lastAnalysedAt: "2026-09-15T06:55:00.000Z",
      paused: null,
      resumesAt: null,
    } satisfies MailboxActivity);
  });

  it("a pass running: counted from its start, with the mailbox the AI is reading", async () => {
    let seen: string[] = [];
    h = await makeHarness({
      lockProbe: async (keys) => {
        seen = keys;
        return new Map([
          ["tick", new Date("2026-09-15T06:58:00Z")],
          [`drain:${h.seed.mailbox.id}`, null],
        ]);
      },
    });
    const mb = h.seed.mailbox.id;
    await message(mb);
    await analysed(await message(mb, "applied"), "2026-09-15T06:59:00Z");
    await analysed(await message(mb, "applied"), "2026-09-15T06:57:00Z");
    const a = (await load()).activity;
    expect(seen).toEqual(["tick", `drain:${mb}`]);
    expect(a).toMatchObject({ running: true, runningSince: "2026-09-15T06:58:00.000Z" });
    expect(own(a)).toMatchObject({ analysing: true, queued: 1, done: 1, doneToday: 2 });
  });

  it("a long-running worker has no pass: its drain still shows, counted over the last 10 minutes", async () => {
    h = await makeHarness({ lockProbe: async () => new Map([[`drain:${h.seed.mailbox.id}`, null]]) });
    const mb = h.seed.mailbox.id;
    await message(mb);
    await analysed(await message(mb, "applied"), "2026-09-15T06:55:00Z");
    await analysed(await message(mb, "applied"), "2026-09-15T06:40:00Z");
    const a = (await load()).activity;
    expect(a).toMatchObject({ running: false, runningSince: null });
    expect(own(a)).toMatchObject({ analysing: true, queued: 1, done: 1, doneToday: 2 });
  });

  it("locks that cannot be read: running unknown, nothing shown as being analysed", async () => {
    const a = await activity(async () => null);
    expect(a.running).toBeNull();
    expect(own(a).analysing).toBe(false);
  });

  it("a daily-budget pause ends at the next local midnight; another pause has no end", async () => {
    h = await makeHarness({ lockProbe: async () => new Map() });
    await h.t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, h.seed.mailbox.id));
    // 10:00 Athens on 15/09 (UTC+3): the day ends at 21:00Z.
    expect(own((await load()).activity)).toMatchObject({ paused: "budget:usd", resumesAt: "2026-09-15T21:00:00.000Z" });
    await h.t.db.update(s.mailboxes).set({ aiPausedReason: "manual" }).where(eq(s.mailboxes.id, h.seed.mailbox.id));
    expect(own((await load()).activity)).toMatchObject({ paused: "manual", resumesAt: null });
  });

  it("the default probe answers on any database, and on real Postgres it sees another session's lock", async () => {
    h = await makeHarness();
    const probe = pgLockProbe(h.t.db);
    const idle = await probe(["worker"]);
    expect(idle === null || idle.size === 0).toBe(true);
    if (h.t.kind !== "pg") return; // PGlite emulates the locks in-process (src/db/client.ts): nothing in pg_locks
    await withSessionLock(h.t, "worker", async () => {
      const held = await probe(["worker", `drain:${h.seed.mailbox.id}`]);
      expect(held?.has("worker")).toBe(true);
      expect(held?.get("worker")).toBeInstanceOf(Date);
      expect(held?.has(`drain:${h.seed.mailbox.id}`)).toBe(false);
    });
  });

  it("on real Postgres: the \"worker\" lock alone (a long-running worker) is no pass; the tick's own lock is", async () => {
    h = await makeHarness();
    if (h.t.kind !== "pg") return;
    // Taken as src/worker/main.ts and src/worker/tick.ts take them.
    const release = await acquireProcessLock(h.t, "worker", () => undefined);
    expect(release).not.toBeNull();
    try {
      expect((await load()).activity).toMatchObject({ running: false, runningSince: null });
      await withSessionLock(h.t, "tick", async () => {
        const a = (await load()).activity;
        expect(a.running).toBe(true);
        expect(a.runningSince).not.toBeNull();
      });
    } finally {
      await release!();
    }
    expect((await load()).activity.running).toBe(false);
  });
});
