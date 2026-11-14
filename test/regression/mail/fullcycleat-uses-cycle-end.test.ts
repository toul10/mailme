import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../../src/config.js";
import { drainMailbox, type DrainReport, type PipelineDeps } from "../../../src/engine/pipeline.js";
import { nullLogger } from "../../../src/lib/log.js";
import type { SyncDeps, SyncReport } from "../../../src/mail/imap/sync.js";
import { runWorkerTick } from "../../../src/worker/tick.js";
import { startWorker, type WorkerFns, type WorkerRuntime } from "../../../src/worker/worker.js";
import { createTestDb, insertMessage, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { fakeExtractor, okResult, output, pipelineDeps, testClock } from "../../engine-db/fixtures.js";

const report = (mailboxId: string): DrainReport => ({ mailboxId, processed: 0, extracted: 0, applied: 0, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false });

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

/**
 * One full cycle 10:03:00 → 10:03:05: Sent scanned first (10:03:00), INBOX last (10:03:04).
 * A self-Cc INBOX copy arrives at 10:03:02 and is ingested by that cycle's INBOX pass (first_seen 10:03:04);
 * its Sent copy (saved 10:03:03) is only seen by the next full cycle at ~10:08:05 (FOLDER_POLL_SEC=300).
 */
const STARTED = new Date("2026-09-24T07:03:00Z");
const FINISHED = new Date("2026-09-24T07:03:05Z");
const INBOX_SEEN = new Date("2026-09-24T07:03:04Z");

async function watermarkFromWorker(mailboxId: string): Promise<Date> {
  const hooks = new Map<string, { onCycle(r: SyncReport): void | Promise<void> }>();
  const drains: Date[] = [];
  const fns: Partial<WorkerFns> = {
    startMailboxWatcher: vi.fn((_d: SyncDeps, id: string, h: { onCycle(r: SyncReport): void | Promise<void> }) => {
      hooks.set(id, h);
      return { stop: async () => {} };
    }),
    drainMailbox: vi.fn(async (_d: PipelineDeps, id: string, o: { fullCycleAt?: Date | null } = {}) => {
      drains.push(o.fullCycleAt!);
      return report(id);
    }),
  };
  const rt: WorkerRuntime = {
    db: t.db,
    log: nullLogger,
    clock: { now: () => FINISHED },
    config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
    syncDeps: {} as SyncDeps,
    pipelineDeps: {} as PipelineDeps,
    digestDeps: {} as WorkerRuntime["digestDeps"],
  };
  const worker = startWorker(rt, { fns, scheduler: { timers: { setTimeout: () => 0, clearTimeout: () => {} } }, pinger: { ping: async () => true } });
  await worker.refreshMailboxes();
  await hooks.get(mailboxId)!.onCycle({ mailboxId, ok: true, errorKind: null, foldersSynced: 3, newMessages: 1, duplicates: 0, fullCycle: true, startedAt: STARTED, finishedAt: FINISHED });
  await worker.drainsIdle();
  await worker.stop(1_000);
  return drains.at(-1)!;
}

/** The same cycle seen by the one-pass worker (src/worker/tick.ts): sync once, then drain. */
async function watermarkFromTick(mailboxId: string): Promise<Date> {
  const drains: Date[] = [];
  const rt: WorkerRuntime = {
    db: t.db,
    log: nullLogger,
    clock: { now: () => FINISHED },
    config: loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) }),
    syncDeps: {} as SyncDeps,
    pipelineDeps: {} as PipelineDeps,
    digestDeps: {} as WorkerRuntime["digestDeps"],
  };
  await runWorkerTick(rt, {
    fns: {
      syncMailboxOnce: vi.fn(async (_d: SyncDeps, id: string): Promise<SyncReport> => ({ mailboxId: id, ok: true, errorKind: null, foldersSynced: 3, newMessages: 1, duplicates: 0, fullCycle: true, startedAt: STARTED, finishedAt: FINISHED })),
      drainMailbox: vi.fn(async (_d: PipelineDeps, id: string, o: { fullCycleAt?: Date | null } = {}) => {
        drains.push(o.fullCycleAt!);
        return report(id);
      }),
      dispatchDueDigests: vi.fn(async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 })),
      runAging: vi.fn(async () => ({ unsnoozed: 0, asked: 0, dormant: 0 })),
      runRetention: vi.fn(async () => ({}) as never),
      runHealthChecks: vi.fn(async () => ({ results: [], alerted: [], resolved: [], reminded: [] })) as never,
    },
    pinger: { ping: async () => true },
  });
  expect(drains.length).toBeGreaterThan(0);
  return drains.at(-1)!;
}

describe("fullcycleat-uses-cycle-end", () => {
  it("control: a message first seen after the cycle ended waits for the next full cycle", async () => {
    const { mailbox } = await seedOrgUserMailbox(t.db);
    const at = await watermarkFromWorker(mailbox.id);
    const thread = await insertThread(t.db, mailbox.id);
    const m = await insertMessage(t.db, { mailboxId: mailbox.id, threadId: thread.id, sortTs: new Date("2026-09-24T07:03:10Z") });
    await t.db.execute(`update messages set first_seen_at = '2026-09-24T07:03:10Z' where id = '${m.id}'`);
    const clock = testClock("2026-09-24T07:06:30Z"); // settle (180 s) passed, next full cycle not yet run
    const ex = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailbox(pipelineDeps(t, ex, clock), mailbox.id, { fullCycleAt: at });
    expect(ex.calls).toHaveLength(0);
  });

  it.each([
    ["worker", watermarkFromWorker],
    ["tick", watermarkFromTick],
  ] as const)("%s: a message ingested during the cycle AFTER Sent was scanned must also wait for the next full cycle", async (_mode, watermark) => {
    const { mailbox } = await seedOrgUserMailbox(t.db);
    const at = await watermark(mailbox.id);
    const thread = await insertThread(t.db, mailbox.id);
    const m = await insertMessage(t.db, { mailboxId: mailbox.id, threadId: thread.id, sortTs: INBOX_SEEN });
    await t.db.execute(`update messages set first_seen_at = '${INBOX_SEEN.toISOString()}' where id = '${m.id}'`);
    const clock = testClock("2026-09-24T07:06:30Z"); // settle passed at 07:06:04; next Sent scan only at ~07:08:05
    const ex = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailbox(pipelineDeps(t, ex, clock), mailbox.id, { fullCycleAt: at });
    expect(ex.calls).toHaveLength(0);
  });
});
