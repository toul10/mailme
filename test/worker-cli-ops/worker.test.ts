import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../src/config.js";
import * as s from "../../src/db/schema.js";
import type { DrainReport, PipelineDeps } from "../../src/engine/pipeline.js";
import { nullLogger } from "../../src/lib/log.js";
import type { SyncDeps, SyncReport } from "../../src/mail/imap/sync.js";
import { createDrainCoordinator } from "../../src/worker/drainer.js";
import { startWorker, type WorkerFns, type WorkerRuntime } from "../../src/worker/worker.js";
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

describe("drain coordinator", () => {
  it("drains in single-message batches until the queue is empty or blocked", async () => {
    let left = 3;
    const drain = vi.fn(async (id: string, _o: { maxMessages: number; fullCycleAt: Date }) => report(id, { processed: left-- > 0 ? 1 : 0 }));
    const d = createDrainCoordinator({ drain, log: nullLogger });
    await d.request("mb", new Date(1000));
    expect(drain).toHaveBeenCalledTimes(4);
    expect(drain.mock.calls[0]![1]).toEqual({ maxMessages: 1, fullCycleAt: new Date(1000) });

    const blocked = vi.fn(async (id: string) => report(id, { processed: 1, transientBackoff: true }));
    await createDrainCoordinator({ drain: blocked, log: nullLogger }).request("mb", new Date(1));
    expect(blocked).toHaveBeenCalledTimes(1);
    const throwing = vi.fn(async () => {
      throw new Error("not implemented");
    });
    await expect(createDrainCoordinator({ drain: throwing, log: nullLogger }).request("mb", new Date(1))).resolves.toBeUndefined();
  });

  it("coalesces requests during a run into one re-run with the newest fullCycleAt, and stops between batches", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    const drain = vi.fn(async (id: string, o: { fullCycleAt: Date }) => {
      seen.push(o.fullCycleAt.getTime());
      if (seen.length === 1) await gate;
      return report(id);
    });
    const d = createDrainCoordinator({ drain, log: nullLogger });
    const first = d.request("mb", new Date(1));
    void d.request("mb", new Date(3));
    void d.request("mb", new Date(2));
    expect(d.active()).toEqual(["mb"]);
    release();
    await first;
    await d.idle();
    expect(seen).toEqual([1, 3]);

    let calls = 0;
    const d2 = createDrainCoordinator({
      log: nullLogger,
      drain: async (id) => {
        calls++;
        if (calls === 2) d2.stop();
        return report(id, { processed: 1 });
      },
    });
    await d2.request("mb", new Date(1));
    expect(calls).toBe(2);
    await d2.request("mb", new Date(1));
    expect(calls).toBe(2);
  });
});

describe("worker orchestration", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("runs one watcher per active IMAP mailbox and drains only up to a complete sync cycle", async () => {
    const { mailbox: imap } = await seedOrgUserMailbox(t.db, { address: "a@contoso.example" });
    const { mailbox: ingest } = await seedOrgUserMailbox(t.db, { address: "b@contoso.example" });
    const { mailbox: paused } = await seedOrgUserMailbox(t.db, { address: "c@contoso.example" });
    await t.db.update(s.mailboxes).set({ provider: "ingest" }).where(eq(s.mailboxes.id, ingest.id));
    await t.db.update(s.mailboxes).set({ status: "paused" }).where(eq(s.mailboxes.id, paused.id));

    const now = new Date("2026-09-24T08:00:00Z");
    const hooks = new Map<string, { onCycle(r: SyncReport): void | Promise<void> }>();
    const stops: string[] = [];
    const drains: Array<{ id: string; at: Date }> = [];
    const pings: string[] = [];
    const fns: Partial<WorkerFns> = {
      startMailboxWatcher: vi.fn((_deps: SyncDeps, id: string, h: { onCycle(r: SyncReport): void | Promise<void> }) => {
        hooks.set(id, h);
        return { stop: async () => void stops.push(id) };
      }),
      drainMailbox: vi.fn(async (_deps: PipelineDeps, id: string, o: { fullCycleAt?: Date | null } = {}) => {
        drains.push({ id, at: o.fullCycleAt! });
        return report(id);
      }),
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
    const worker = startWorker(rt, {
      fns,
      scheduler: { timers: { setTimeout: () => 0, clearTimeout: () => {} } },
      pinger: { ping: async (r) => (pings.push(r), true) },
    });

    await worker.refreshMailboxes();
    expect(worker.watching()).toEqual([imap.id]);
    await worker.refreshMailboxes();
    expect(fns.startMailboxWatcher).toHaveBeenCalledTimes(1);

    // No complete cycle yet for the IMAP mailbox: only the ingest-API mailbox drains (up to now).
    await worker.drainTick();
    await worker.drainsIdle();
    expect(drains).toEqual([{ id: ingest.id, at: now }]);

    const cycle = (fullCycle: boolean, finishedAt: Date): SyncReport => ({
      mailboxId: imap.id, ok: true, errorKind: null, foldersSynced: 3, newMessages: 1, duplicates: 0, fullCycle, startedAt: finishedAt, finishedAt,
    });
    const t1 = new Date("2026-09-24T07:58:00Z");
    await hooks.get(imap.id)!.onCycle(cycle(true, t1));
    await worker.drainsIdle();
    expect(drains).toHaveLength(2);
    expect(drains.at(-1)).toEqual({ id: imap.id, at: t1 });
    expect(pings).toEqual(["cycle"]);
    expect(worker.lastFullCycle(imap.id)).toEqual(t1);

    // A partial cycle keeps the previous full-cycle watermark.
    await hooks.get(imap.id)!.onCycle(cycle(false, new Date("2026-09-24T07:59:00Z")));
    await worker.drainsIdle();
    expect(drains).toHaveLength(3);
    expect(drains.at(-1)).toEqual({ id: imap.id, at: t1 });
    expect(pings).toEqual(["cycle"]);

    // After a restart the persisted last_sync_at (full cycles only) is the watermark.
    const t2 = new Date("2026-09-24T07:59:30Z");
    await t.db.update(s.mailboxes).set({ lastSyncAt: t2 }).where(eq(s.mailboxes.id, imap.id));
    drains.length = 0;
    await worker.drainTick();
    await worker.drainsIdle();
    expect(drains).toContainEqual({ id: imap.id, at: t2 });

    // Paused → watcher stopped on the next refresh.
    await t.db.update(s.mailboxes).set({ status: "paused" }).where(eq(s.mailboxes.id, imap.id));
    await worker.refreshMailboxes();
    expect(stops).toEqual([imap.id]);
    expect(worker.watching()).toEqual([]);

    expect(await worker.stop(1_000)).toEqual([]);
  });

  it("clears only budget pauses at the daily reset", async () => {
    const { mailbox: a } = await seedOrgUserMailbox(t.db, { address: "a@contoso.example" });
    const { mailbox: b } = await seedOrgUserMailbox(t.db, { address: "b@contoso.example" });
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, a.id));
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "manual" }).where(eq(s.mailboxes.id, b.id));
    const rt: WorkerRuntime = {
      db: t.db,
      log: nullLogger,
      clock: { now: () => new Date() },
      config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
      syncDeps: {} as SyncDeps,
      pipelineDeps: {} as PipelineDeps,
      digestDeps: {} as WorkerRuntime["digestDeps"],
    };
    const worker = startWorker(rt, { scheduler: { timers: { setTimeout: () => 0, clearTimeout: () => {} } }, pinger: { ping: async () => true } });
    expect(await worker.resetBudgetPauses()).toBe(1);
    const rows = await t.db.select({ id: s.mailboxes.id, aiPaused: s.mailboxes.aiPaused }).from(s.mailboxes);
    expect(rows.find((r) => r.id === a.id)!.aiPaused).toBe(false);
    expect(rows.find((r) => r.id === b.id)!.aiPaused).toBe(true);
    await worker.stop(1_000);
  });
});
