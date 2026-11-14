import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import * as s from "../../../src/db/schema.js";
import type { DrainReport, PipelineDeps } from "../../../src/engine/pipeline.js";
import { nullLogger } from "../../../src/lib/log.js";
import type { SyncDeps } from "../../../src/mail/imap/sync.js";
import { runWorkerTick, type TickFns } from "../../../src/worker/tick.js";
import { startWorker, type WorkerFns, type WorkerRuntime } from "../../../src/worker/worker.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

describe("daily-jobs-no-catchup", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it("a worker restarted after 00:05 still clears yesterday's AI budget pause", async () => {
    const { mailbox } = await seedOrgUserMailbox(t.db);
    // Budget reached yesterday evening; the worker was down over 00:05 and restarts at 06:00 local.
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, mailbox.id));
    const now = new Date("2026-09-24T03:00:00Z"); // Thu 24 Sep 06:00 Europe/Athens

    const armed: Array<{ fn: () => void; ms: number }> = [];
    const timers = { setTimeout: (fn: () => void, ms: number) => (armed.push({ fn, ms }), armed.length), clearTimeout: () => {} };
    const report = (mailboxId: string): DrainReport => ({ mailboxId, processed: 0, extracted: 0, applied: 0, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false });
    const fns: Partial<WorkerFns> = {
      startMailboxWatcher: vi.fn(() => ({ stop: async () => {} })) as unknown as WorkerFns["startMailboxWatcher"],
      drainMailbox: vi.fn(async (_d: PipelineDeps, id: string) => report(id)) as unknown as WorkerFns["drainMailbox"],
      dispatchDueDigests: vi.fn(async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 })),
      runAging: vi.fn(async () => ({ unsnoozed: 0, asked: 0, dormant: 0 })),
      runHealthChecks: vi.fn(async () => ({ alerted: [], resolved: [], reminded: [] })) as unknown as WorkerFns["runHealthChecks"],
      runRetention: vi.fn(async () => ({}) as never),
    };
    const rt: WorkerRuntime = {
      db: t.db,
      log: nullLogger,
      clock: { now: () => now },
      config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
      syncDeps: {} as SyncDeps,
      pipelineDeps: {} as PipelineDeps,
      digestDeps: {} as WorkerRuntime["digestDeps"],
    };
    const worker = startWorker(rt, { fns, scheduler: { timers, random: () => 0.5 }, pinger: { ping: async () => true } });

    // One hour of uptime: fire every timer armed at start that is due within the hour.
    const due = armed.filter((a) => a.ms <= 3_600_000);
    expect(due.length).toBeGreaterThan(0); // precondition: the interval jobs did run
    for (const a of due) a.fn();
    await new Promise((r) => setTimeout(r, 200));
    await worker.drainsIdle();

    const [mb] = await t.db.select({ aiPaused: s.mailboxes.aiPaused }).from(s.mailboxes).where(eq(s.mailboxes.id, mailbox.id));
    await worker.stop(1_000);
    // "The worker clears budget pauses at 00:05 local": a new local day, a new budget.
    expect(mb!.aiPaused).toBe(false);
  });

  /** Start a worker at `now`, fire the timers armed within the first hour once, return the retention calls. */
  async function startupRetentionRuns(now: Date): Promise<number> {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    const timers = { setTimeout: (fn: () => void, ms: number) => (armed.push({ fn, ms }), armed.length), clearTimeout: () => {} };
    const runRetention = vi.fn(async () => ({}) as never);
    const fns: Partial<WorkerFns> = {
      startMailboxWatcher: vi.fn(() => ({ stop: async () => {} })) as unknown as WorkerFns["startMailboxWatcher"],
      drainMailbox: vi.fn(async () => ({}) as never) as unknown as WorkerFns["drainMailbox"],
      dispatchDueDigests: vi.fn(async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 })),
      runAging: vi.fn(async () => ({ unsnoozed: 0, asked: 0, dormant: 0 })),
      runHealthChecks: vi.fn(async () => ({ alerted: [], resolved: [], reminded: [] })) as unknown as WorkerFns["runHealthChecks"],
      runRetention,
    };
    const rt: WorkerRuntime = {
      db: t.db,
      log: nullLogger,
      clock: { now: () => now },
      config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
      syncDeps: {} as SyncDeps,
      pipelineDeps: {} as PipelineDeps,
      digestDeps: {} as WorkerRuntime["digestDeps"],
    };
    const worker = startWorker(rt, { fns, scheduler: { timers, random: () => 0.5 }, pinger: { ping: async () => true } });
    for (const a of armed.filter((x) => x.ms <= 3_600_000)) a.fn();
    for (let i = 0; i < 50 && runRetention.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    await worker.stop(1_000);
    return runRetention.mock.calls.length;
  }
  const lastRun = async () => (await t.db.select().from(s.appState).where(eq(s.appState.key, "job:retention:last_run")))[0]?.value as { at: string } | undefined;

  it("a worker never running at 03:30 still runs the nightly retention (missed slot caught up at start)", async () => {
    await seedOrgUserMailbox(t.db);
    const sixAm = new Date("2026-09-24T03:00:00Z"); // 06:00 Athens: today's 03:30 slot was missed
    expect(await startupRetentionRuns(sixAm)).toBe(1);
    expect((await lastRun())!.at).toBe(sixAm.toISOString());

    // Restarted later the same day: today's slot is covered, nothing to catch up.
    expect(await startupRetentionRuns(new Date("2026-09-24T09:00:00Z"))).toBe(0);
    // Just after midnight: yesterday's run covers the latest slot (yesterday 03:30).
    expect(await startupRetentionRuns(new Date("2026-09-24T21:10:00Z"))).toBe(0); // 00:10 Athens on 25/09
    // After 03:30 without a run → caught up.
    expect(await startupRetentionRuns(new Date("2026-09-25T04:00:00Z"))).toBe(1);
  });

  /** One tick at `now` with every step faked except the budget reset and the catch-up; returns the retention calls. */
  async function tickAt(now: Date): Promise<number> {
    const runRetention = vi.fn(async () => ({}) as never);
    const fns: Partial<TickFns> = {
      syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string) => ({ mailboxId: id, ok: true, errorKind: null, foldersSynced: 1, newMessages: 0, duplicates: 0, fullCycle: true, startedAt: now, finishedAt: now })),
      drainMailbox: vi.fn(async (_d: PipelineDeps, id: string): Promise<DrainReport> => ({ mailboxId: id, processed: 0, extracted: 0, applied: 0, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false })),
      dispatchDueDigests: vi.fn(async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 })),
      runAging: vi.fn(async () => ({ unsnoozed: 0, asked: 0, dormant: 0 })),
      runHealthChecks: vi.fn(async () => ({ results: [], alerted: [], resolved: [], reminded: [] })) as unknown as TickFns["runHealthChecks"],
      runRetention,
    };
    const rt: WorkerRuntime = {
      db: t.db,
      log: nullLogger,
      clock: { now: () => now },
      config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
      syncDeps: {} as SyncDeps,
      pipelineDeps: {} as PipelineDeps,
      digestDeps: {} as WorkerRuntime["digestDeps"],
    };
    const r = await runWorkerTick(rt, { fns, pinger: { ping: async () => true } });
    expect(r.failed).toBe(false);
    return runRetention.mock.calls.length;
  }

  it("tick: the first tick after 00:05 clears yesterday's AI budget pause", async () => {
    const { mailbox } = await seedOrgUserMailbox(t.db);
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, mailbox.id));
    await tickAt(new Date("2026-09-24T03:00:00Z")); // Thu 24 Sep 06:00 Europe/Athens
    const [mb] = await t.db.select({ aiPaused: s.mailboxes.aiPaused }).from(s.mailboxes).where(eq(s.mailboxes.id, mailbox.id));
    expect(mb!.aiPaused).toBe(false);
  });

  it("tick: the nightly retention runs on the first tick after its slot, once per slot", async () => {
    await seedOrgUserMailbox(t.db);
    expect(await tickAt(new Date("2026-09-24T03:00:00Z"))).toBe(1); // 06:00 Athens: today's 03:30 slot was missed
    expect(await tickAt(new Date("2026-09-24T09:00:00Z"))).toBe(0);
    expect(await tickAt(new Date("2026-09-24T21:10:00Z"))).toBe(0); // 00:10 Athens on 25/09
    expect(await tickAt(new Date("2026-09-25T00:35:00Z"))).toBe(1); // 03:35 Athens: the tick right after the slot
  });
});
