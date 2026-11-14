import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../../src/config.js";
import * as s from "../../../src/db/schema.js";
import { applyExtractionWith } from "../../../src/engine/apply.js";
import { buildExtractionContext } from "../../../src/engine/context.js";
import { drainMailboxWith, type DrainInternals, type PipelineDeps } from "../../../src/engine/pipeline.js";
import { nullLogger } from "../../../src/lib/log.js";
import { runWorkerTick, type TickFns } from "../../../src/worker/tick.js";
import { startWorker, WORKER_SCHEDULE, type WorkerRuntime } from "../../../src/worker/worker.js";
import { insertMessage, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { createOp, fakeExtractor, fakePlanner, handleMapFor, insertExtraction, okResult, output, pipelineDeps, sharedTestDb, testClock } from "../../engine-db/fixtures.js";

const shared = sharedTestDb();
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;

beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
  await t.db.update(s.organizations).set({ timezone: "Europe/London" }).where(eq(s.organizations.id, seed.org.id));
});

describe("budget-reset-timezone-mismatch", () => {
  // The engine-side self-heal (drainLoop re-checking an expired budget pause itself) belongs to the engine; this covers
  // the worker's reset, which now follows each org's own local day.
  it("an org in Europe/London gets its budget pause cleared at London midnight, not at 00:05 Athens", async () => {
    const config = loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) });
    expect(config.DEFAULT_TIMEZONE).toBe("Europe/Athens");
    const clock = testClock("2026-09-10T14:01:00Z"); // 15:01 London, Thu 10 Sep
    const threadId = (await insertThread(t.db, seed.mailbox.id)).id;

    // $10 spent by 15:00 London today (the default cap).
    const old = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, subject: "Old", sortTs: new Date("2026-09-10T13:00:00Z"), state: "applied" });
    await insertExtraction(t.db, old, output([]), handleMapFor(), { createdAt: new Date("2026-09-10T14:00:00Z"), state: "applied" });
    await t.db.update(s.extractions).set({ costUsd: 10 });
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, subject: "A", sortTs: new Date("2026-09-10T13:30:00Z") });

    const ex = fakeExtractor((input) => okResult(output([createOp({ title: `ABC — ${input.message.subject}` })])));
    const internals: DrainInternals = { buildContext: buildExtractionContext, apply: (db, m, e, c) => applyExtractionWith(db, m, e, c, { planOperations: fakePlanner().planner }) };
    const deps: PipelineDeps = pipelineDeps(t, ex, clock, { AI_DAILY_USD_CAP: 10 });
    const drain = () => drainMailboxWith(deps, seed.mailbox.id, {}, internals);

    expect(await drain()).toMatchObject({ budgetPaused: true });

    const armed: number[] = [];
    const rt: WorkerRuntime = { db: t.db, log: nullLogger, clock, config, syncDeps: {} as never, pipelineDeps: deps, digestDeps: {} as never };
    const worker = startWorker(rt, { scheduler: { timers: { setTimeout: (_fn: () => void, ms: number) => (armed.push(ms), 0), clearTimeout: () => {} } }, pinger: { ping: async () => true } });
    // The reset is no longer a single 00:05 run in DEFAULT_TIMEZONE: it re-checks every few minutes (from start-up).
    expect(WORKER_SCHEDULE.budgetCheckMs).toBeLessThanOrEqual(15 * 60_000);
    expect(armed).toContain(15_000);
    const paused = async () => (await t.db.select({ p: s.mailboxes.aiPaused }).from(s.mailboxes).where(eq(s.mailboxes.id, seed.mailbox.id)))[0]!.p;

    // 00:05 Athens = 22:05 London: still the same London day, still over the cap → stays paused.
    clock.set("2026-09-10T21:05:00Z");
    expect(await worker.resetBudgetPauses()).toBe(0);
    expect(await paused()).toBe(true);

    // 00:10 London on Fri 11 Sep: a new day in the org's zone, zero spend → cleared.
    clock.set("2026-09-10T23:10:00Z");
    expect(await worker.resetBudgetPauses()).toBe(1);
    expect(await paused()).toBe(false);

    // 09:00 London on Fri 11 Sep: the queue moves again.
    clock.set("2026-09-11T08:00:00Z");
    const r = await drain();
    await worker.stop(1_000);
    expect(r.budgetPaused).toBe(false);
  });

  it("tick: the one-pass worker clears it at London midnight too, not at 00:05 Athens", async () => {
    const config = loadConfig({ MASTER_KEY: Buffer.alloc(32, 1).toString("base64"), APP_SECRET: "y".repeat(40) });
    const clock = testClock("2026-09-10T14:01:00Z");
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, seed.mailbox.id));
    const threadId = (await insertThread(t.db, seed.mailbox.id)).id;
    const old = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, subject: "Old", sortTs: new Date("2026-09-10T13:00:00Z"), state: "applied" });
    await insertExtraction(t.db, old, output([]), handleMapFor(), { createdAt: new Date("2026-09-10T14:00:00Z"), state: "applied" });
    await t.db.update(s.extractions).set({ costUsd: 10 }); // the day's $10 spent by 15:00 London
    const fns: Partial<TickFns> = {
      syncMailboxOnce: async (_d, id) => ({ mailboxId: id, ok: true, errorKind: null, foldersSynced: 1, newMessages: 0, duplicates: 0, fullCycle: true, startedAt: clock.now(), finishedAt: clock.now() }),
      drainMailbox: async (_d, id) => ({ mailboxId: id, processed: 0, extracted: 0, applied: 0, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false }),
      dispatchDueDigests: async () => ({ considered: 0, delivered: 0, failed: 0, skipped: 0 }),
      runAging: async () => ({ unsnoozed: 0, asked: 0, dormant: 0 }),
      runRetention: async () => ({}) as never,
      runHealthChecks: (async () => ({ results: [], alerted: [], resolved: [], reminded: [] })) as unknown as TickFns["runHealthChecks"],
    };
    const rt: WorkerRuntime = { db: t.db, log: nullLogger, clock, config, syncDeps: {} as never, pipelineDeps: {} as never, digestDeps: {} as never };
    const tick = () => runWorkerTick(rt, { fns, pinger: { ping: async () => true } });

    clock.set("2026-09-10T21:05:00Z"); // 00:05 Athens = 22:05 London: the same London day, still over the cap
    expect((await tick()).budgetPausesCleared).toBe(0);
    clock.set("2026-09-10T23:10:00Z"); // 00:10 London on Fri 11 Sep: a new day in the org's zone
    expect((await tick()).budgetPausesCleared).toBe(1);
  });
});
