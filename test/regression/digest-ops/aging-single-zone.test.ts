import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import * as s from "../../../src/db/schema.js";
import type { PipelineDeps } from "../../../src/engine/pipeline.js";
import { nullLogger } from "../../../src/lib/log.js";
import type { SyncDeps } from "../../../src/mail/imap/sync.js";
import { runWorkerTick, type TickFns } from "../../../src/worker/tick.js";
import { startWorker, WORKER_SCHEDULE, type WorkerFns, type WorkerRuntime } from "../../../src/worker/worker.js";
import { addTask, setup, type Fixture } from "../../digest/helpers.js";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
  await f.db.update(s.organizations).set({ timezone: "Europe/London" }).where(eq(s.organizations.id, f.orgId));
});
afterEach(() => f.t.close());

describe("aging-single-zone", () => {
  it("the worker's aging job uses the org's timezone for 'today', like the report does", async () => {
    // Snoozed until Fri 25/09. Now: Thu 24/09 22:30 in London (org zone) = Fri 25/09 00:30 in Athens (DEFAULT_TIMEZONE).
    const task = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-25" });
    const now = new Date("2026-09-24T21:30:00Z");

    const armed: Array<{ fn: () => void; ms: number }> = [];
    const timers = { setTimeout: (fn: () => void, ms: number) => (armed.push({ fn, ms }), armed.length), clearTimeout: () => {} };
    const fns: Partial<WorkerFns> = {
      startMailboxWatcher: vi.fn(() => ({ stop: async () => {} })) as unknown as WorkerFns["startMailboxWatcher"],
      drainMailbox: vi.fn(async () => ({}) as never),
      dispatchDueDigests: vi.fn(async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 })),
      runHealthChecks: vi.fn(async () => ({ alerted: [], resolved: [], reminded: [] })) as unknown as WorkerFns["runHealthChecks"],
      runRetention: vi.fn(async () => ({}) as never),
      // runAging: the real one
    };
    const config = loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) });
    expect(config.DEFAULT_TIMEZONE).toBe("Europe/Athens"); // precondition
    const rt: WorkerRuntime = { db: f.db, log: nullLogger, clock: { now: () => now }, config, syncDeps: {} as SyncDeps, pipelineDeps: {} as PipelineDeps, digestDeps: {} as WorkerRuntime["digestDeps"] };
    const worker = startWorker(rt, { fns, scheduler: { timers, random: () => 0.5 }, pinger: { ping: async () => true } });

    // The aging job is armed with initialDelayMs = 60 s; fire only it.
    const aging = armed.filter((a) => a.ms === 60_000);
    expect(aging).toHaveLength(1);
    expect(WORKER_SCHEDULE.agingMs).toBe(3_600_000);
    aging[0]!.fn();
    for (let i = 0; i < 100; i++) {
      const evs = await f.db.select().from(s.taskEvents).where(eq(s.taskEvents.taskId, task.id));
      if (evs.length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await worker.stop(5_000);

    const [row] = await f.db.select().from(s.tasks).where(eq(s.tasks.id, task.id));
    // In the org's zone it is still 24/09: the snooze has not come due.
    expect(row!.snoozedUntil).toBe("2026-09-25");
  });

  it("tick: the one-pass worker's aging uses the org's timezone too", async () => {
    const task = await addTask(f, { snoozeMode: "until_date", snoozedUntil: "2026-09-25" });
    const now = new Date("2026-09-24T21:30:00Z"); // Thu 24/09 22:30 London = Fri 25/09 00:30 Athens
    const fns: Partial<TickFns> = {
      syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string) => ({ mailboxId: id, ok: true, errorKind: null, foldersSynced: 1, newMessages: 0, duplicates: 0, fullCycle: true, startedAt: now, finishedAt: now })),
      drainMailbox: vi.fn(async () => ({}) as never),
      dispatchDueDigests: vi.fn(async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 })),
      runHealthChecks: vi.fn(async () => ({ results: [], alerted: [], resolved: [], reminded: [] })) as unknown as TickFns["runHealthChecks"],
      runRetention: vi.fn(async () => ({}) as never),
      // runAging: the real one
    };
    const config = loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) });
    const rt: WorkerRuntime = { db: f.db, log: nullLogger, clock: { now: () => now }, config, syncDeps: {} as SyncDeps, pipelineDeps: {} as PipelineDeps, digestDeps: {} as WorkerRuntime["digestDeps"] };
    const r = await runWorkerTick(rt, { fns, pinger: { ping: async () => true } });
    expect(r.failures).not.toContain("aging");
    const [row] = await f.db.select().from(s.tasks).where(eq(s.tasks.id, task.id));
    expect(row!.snoozedUntil).toBe("2026-09-25");
  });
});
