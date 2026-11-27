import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../src/config.js";
import * as s from "../../src/db/schema.js";
import type { DrainReport, PipelineDeps } from "../../src/engine/pipeline.js";
import { nullLogger } from "../../src/lib/log.js";
import type { SyncDeps, SyncReport } from "../../src/mail/imap/sync.js";
import { withSessionLock } from "../../src/db/client.js";
import { runWorkerTick, TICK_LOCK, type TickFns } from "../../src/worker/tick.js";
import type { WorkerRuntime } from "../../src/worker/worker.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

const report = (mailboxId: string, over: Partial<DrainReport> = {}): DrainReport => ({
  mailboxId,
  processed: 0,
  extracted: 0,
  applied: 0,
  parked: 0,
  transientBackoff: false,
  globalPause: false,
  budgetPaused: false,
  lockBusy: false,
  ...over,
});

const cycle = (mailboxId: string, over: Partial<SyncReport> = {}): SyncReport => ({
  mailboxId,
  ok: true,
  errorKind: null,
  foldersSynced: 4,
  newMessages: 1,
  duplicates: 0,
  fullCycle: true,
  startedAt: new Date("2026-09-24T07:58:00Z"),
  finishedAt: new Date("2026-09-24T07:58:05Z"),
  ...over,
});

/** Every step faked and recorded in call order; override per test. */
function fakeFns(calls: string[], over: Partial<TickFns> = {}): Partial<TickFns> {
  return {
    syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string) => (calls.push(`sync:${id}`), cycle(id))),
    drainMailbox: vi.fn(async (_d: PipelineDeps, id: string) => (calls.push(`drain:${id}`), report(id))),
    dispatchDueDigests: vi.fn(async () => (calls.push("digest"), { considered: 0, delivered: 0, failed: 0, skipped: 0 })),
    runAging: vi.fn(async () => (calls.push("aging"), { unsnoozed: 0, asked: 0, dormant: 0 })),
    runRetention: vi.fn(async () => (calls.push("retention"), {}) as never),
    runHealthChecks: vi.fn(async () => (calls.push("health"), { results: [], alerted: [], resolved: [], reminded: [] })) as unknown as TickFns["runHealthChecks"],
    ...over,
  };
}

describe("worker tick (one pass, src/worker/tick.ts)", () => {
  let t: TestDb;
  let now: Date;
  let rt: WorkerRuntime;
  beforeEach(async () => {
    t = await createTestDb();
    now = new Date("2026-09-24T08:00:00Z"); // 11:00 Athens; today's 03:30 retention slot has passed
    rt = {
      db: t.db,
      log: nullLogger,
      clock: { now: () => now },
      config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
      syncDeps: {} as SyncDeps,
      pipelineDeps: {} as PipelineDeps,
      digestDeps: {} as WorkerRuntime["digestDeps"],
    };
  });
  afterEach(async () => {
    await t.close();
  });

  it("syncs each active IMAP mailbox once, drains up to the start of that complete cycle, then runs the jobs in order", async () => {
    const { mailbox: imap } = await seedOrgUserMailbox(t.db, { address: "a@contoso.example" });
    const { mailbox: ingest } = await seedOrgUserMailbox(t.db, { address: "b@contoso.example" });
    const { mailbox: paused } = await seedOrgUserMailbox(t.db, { address: "c@contoso.example" });
    await t.db.update(s.mailboxes).set({ provider: "ingest" }).where(eq(s.mailboxes.id, ingest.id));
    await t.db.update(s.mailboxes).set({ status: "paused" }).where(eq(s.mailboxes.id, paused.id));
    const calls: string[] = [];
    const drains: Array<{ id: string; at: Date }> = [];
    const pings: string[] = [];
    const fns = fakeFns(calls, {
      drainMailbox: vi.fn(async (_d: PipelineDeps, id: string, o: { fullCycleAt?: Date | null } = {}) => {
        calls.push(`drain:${id}`);
        drains.push({ id, at: o.fullCycleAt! });
        return report(id);
      }),
    });

    const r = await runWorkerTick(rt, { fns, pinger: { ping: async (k) => (pings.push(k), true) }, ops: { dataDir: "/data", backupMarkerFile: null } });

    expect(fns.syncMailboxOnce).toHaveBeenCalledTimes(1); // the ingest and the paused mailbox do not sync
    // The watermark is the cycle's START, the ingest mailbox drains up to now, the paused one not at all.
    expect(drains).toEqual(expect.arrayContaining([{ id: imap.id, at: cycle(imap.id).startedAt }, { id: ingest.id, at: now }]));
    expect(drains).toHaveLength(2);
    expect(pings).toEqual(["cycle"]);
    const steps = calls.filter((c) => !c.includes(":"));
    expect(steps).toEqual(["digest", "aging", "retention", "health"]);
    expect(calls.indexOf(`drain:${imap.id}`)).toBeLessThan(calls.indexOf("digest"));
    expect(vi.mocked(fns.runHealthChecks!).mock.calls[0]![0]).toMatchObject({ dataDir: "/data", backupMarkerFile: null });
    expect(r).toMatchObject({ mailboxes: 2, synced: 1, syncFailed: 0, retention: true, failed: false, failures: [] });
  });

  it("a failed or partial cycle drains only up to the previous complete one, and a mailbox without one does not drain", async () => {
    const { mailbox: seen } = await seedOrgUserMailbox(t.db, { address: "a@contoso.example" });
    await seedOrgUserMailbox(t.db, { address: "b@contoso.example" }); // never completed a cycle
    const t0 = new Date("2026-09-24T07:50:00Z");
    await t.db.update(s.mailboxes).set({ lastSyncAt: t0 }).where(eq(s.mailboxes.id, seen.id));
    const drains: Array<{ id: string; at: Date }> = [];
    const pings: string[] = [];
    const fns = fakeFns([], {
      syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string) => cycle(id, { ok: false, errorKind: "network", fullCycle: false })),
      drainMailbox: vi.fn(async (_d: PipelineDeps, id: string, o: { fullCycleAt?: Date | null } = {}) => (drains.push({ id, at: o.fullCycleAt! }), report(id))),
    });

    const r = await runWorkerTick(rt, { fns, pinger: { ping: async (k) => (pings.push(k), true) } });

    expect(drains).toEqual([{ id: seen.id, at: t0 }]);
    expect(pings).toEqual([]);
    // An IMAP failure is the mailbox's state (recorded by the sync, alerted by health), not a failed tick.
    expect(r).toMatchObject({ synced: 0, syncFailed: 2, failed: false });
  });

  it("drains every batch of the queue, and counts what was processed", async () => {
    await seedOrgUserMailbox(t.db);
    let left = 3;
    const fns = fakeFns([], { drainMailbox: vi.fn(async (_d: PipelineDeps, id: string) => report(id, { processed: left-- > 0 ? 1 : 0 })) });
    const r = await runWorkerTick(rt, { fns, pinger: { ping: async () => true } });
    expect(fns.drainMailbox).toHaveBeenCalledTimes(4); // the worker's coordinator: one message per call until empty
    expect(r.processed).toBe(3);
  });

  it("an exception in one mailbox or step fails the tick, after the other mailboxes and the remaining steps still ran", async () => {
    const { mailbox: a } = await seedOrgUserMailbox(t.db, { address: "a@contoso.example" });
    const { mailbox: b } = await seedOrgUserMailbox(t.db, { address: "b@contoso.example" });
    const calls: string[] = [];
    const fns = fakeFns(calls, {
      syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string) => {
        calls.push(`sync:${id}`);
        if (id === a.id) throw new Error("boom");
        return cycle(id);
      }),
      dispatchDueDigests: vi.fn(async () => {
        calls.push("digest");
        throw new Error("smtp down");
      }),
    });

    const r = await runWorkerTick(rt, { fns, pinger: { ping: async () => true } });

    expect(calls).toContain(`drain:${b.id}`);
    expect(calls).not.toContain(`drain:${a.id}`); // no complete cycle yet for a: nothing to drain up to
    expect(calls.filter((c) => !c.includes(":"))).toEqual(["digest", "aging", "retention", "health"]);
    expect(r.failed).toBe(true);
    expect(r.failures).toEqual([`sync:${a.id}`, "digest"]);
  });

  it("clears an expired budget pause before the drains, so a new day's budget is used in the same pass", async () => {
    const { mailbox } = await seedOrgUserMailbox(t.db);
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, mailbox.id));
    let pausedAtDrain: boolean | null = null;
    const fns = fakeFns([], {
      drainMailbox: vi.fn(async (_d: PipelineDeps, id: string) => {
        pausedAtDrain = (await t.db.select({ p: s.mailboxes.aiPaused }).from(s.mailboxes).where(eq(s.mailboxes.id, id)))[0]!.p;
        return report(id);
      }),
    });
    const r = await runWorkerTick(rt, { fns, pinger: { ping: async () => true } });
    expect(r.budgetPausesCleared).toBe(1);
    expect(pausedAtDrain).toBe(false);
  });

  it("runs the nightly retention once after its slot and records it; the next tick the same day does not", async () => {
    await seedOrgUserMailbox(t.db);
    const fns = fakeFns([]);
    expect((await runWorkerTick(rt, { fns, pinger: { ping: async () => true } })).retention).toBe(true);
    const [row] = await t.db.select().from(s.appState).where(eq(s.appState.key, "job:retention:last_run"));
    expect((row!.value as { at: string }).at).toBe(now.toISOString());

    now = new Date("2026-09-24T08:05:00Z");
    expect((await runWorkerTick(rt, { fns, pinger: { ping: async () => true } })).retention).toBe(false);
    now = new Date("2026-09-25T00:35:00Z"); // 03:35 Athens on 25/09: the next slot has passed
    expect((await runWorkerTick(rt, { fns, pinger: { ping: async () => true } })).retention).toBe(true);
    expect(fns.runRetention).toHaveBeenCalledTimes(2);
  });

  it("awaits the report dispatch and its ping before returning", async () => {
    await seedOrgUserMailbox(t.db);
    const pings: string[] = [];
    const fns = fakeFns([], { dispatchDueDigests: vi.fn(async () => ({ considered: 1, delivered: 1, failed: 0, skipped: 0 })) });
    const slowPing = async (k: string) => {
      await new Promise((res) => setTimeout(res, 20));
      pings.push(k);
      return true;
    };
    const r = await runWorkerTick(rt, { fns, pinger: { ping: slowPing } });
    expect(pings).toEqual(["cycle", "digest"]);
    expect(r.digestsDelivered).toBe(1);
  });

  it("holds its own lock for the whole pass (the sync bar's sign of a pass in progress) and lets it go after", async () => {
    await seedOrgUserMailbox(t.db);
    rt.withLock = (key, fn) => withSessionLock(t, key, fn);
    const free = async () => (await withSessionLock(t, TICK_LOCK, async () => true)).acquired;
    const heldDuring: boolean[] = [];
    const fns = fakeFns([], {
      syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string) => (heldDuring.push(!(await free())), cycle(id))),
      runHealthChecks: vi.fn(async () => (heldDuring.push(!(await free())), { results: [], alerted: [], resolved: [], reminded: [] })) as unknown as TickFns["runHealthChecks"],
    });
    const r = await runWorkerTick(rt, { fns });
    expect(r.failed).toBe(false);
    expect(heldDuring).toEqual([true, true]);
    expect(await free()).toBe(true);
  });
});
