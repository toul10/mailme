import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import { runAging } from "../digest/aging.js";
import { safeZone } from "../digest/calendar.js";
import { dispatchDueDigests } from "../digest/dispatch.js";
import { appState, extractions, mailboxes, organizations, users } from "../db/schema.js";
import { BUDGET_PAUSE_REASONS as BUDGET_PAUSE_REASON_VALUES, type Logger } from "../domain/types.js";
import { drainMailbox, isBudgetPauseExpired } from "../engine/pipeline.js";
import { startMailboxWatcher, type SyncReport } from "../mail/imap/sync.js";
import { errorCode } from "../ops/alerts.js";
import { runHealthChecks } from "../ops/health.js";
import { createHealthPinger, type HealthPinger } from "../ops/ping.js";
import { runRetention } from "../ops/retention.js";
import { createDrainCoordinator } from "./drainer.js";
import type { Runtime } from "./runtime.js";
import { createScheduler, previousDailyAt, waitAtMost, type SchedulerOptions } from "./scheduler.js";
import { createWatcherManager } from "./watchers.js";

/**
 * The worker process: IMAP watchers → drain, periodic drain tick, digest dispatcher, aging,
 * health checks, nightly retention and the AI budget reset. main.ts wires signals and the process lock.
 */

export const WORKER_SCHEDULE = {
  mailboxRefreshMs: 60_000,
  drainTickMs: 60_000,
  digestMs: 60_000,
  agingMs: 3_600_000,
  healthMs: 5 * 60_000,
  retentionAt: "03:30",
  /**
   * Budget pauses are re-checked this often and cleared once the org-local day's spend is under the caps again
   * (a new local day in each org's own timezone; also right after a restart).
   */
  budgetCheckMs: 10 * 60_000,
  /** Daily jobs missed while the worker was down (or never running at their time) run at start and on this check. */
  dailyCatchUpMs: 3_600_000,
  shutdownTimeoutMs: 110_000,
} as const;

/** Daily jobs whose last run is persisted (app_state `job:<name>:last_run`) so a missed slot is caught up. */
const DAILY_JOBS = [{ name: "retention", at: WORKER_SCHEDULE.retentionAt }] as const;
export type DailyJobName = (typeof DAILY_JOBS)[number]["name"];
const lastRunKey = (job: string) => `job:${job}:last_run`;

/** mailboxes.ai_paused_reason values set by the pipeline's daily budget check (src/engine/pipeline.ts). */
export const BUDGET_PAUSE_REASONS = [BUDGET_PAUSE_REASON_VALUES.calls, BUDGET_PAUSE_REASON_VALUES.usd] as const;

export interface WorkerFns {
  startMailboxWatcher: typeof startMailboxWatcher;
  drainMailbox: typeof drainMailbox;
  dispatchDueDigests: typeof dispatchDueDigests;
  runAging: typeof runAging;
  runHealthChecks: typeof runHealthChecks;
  runRetention: typeof runRetention;
}

/** `refreshAi` re-reads Admin → AI before each drain (optional: test runtimes without the AI tables omit it). */
export type WorkerRuntime = Pick<Runtime, "db" | "log" | "clock" | "config" | "syncDeps" | "pipelineDeps" | "digestDeps"> & Partial<Pick<Runtime, "refreshAi" | "withLock">>;

export interface WorkerOptions {
  fns?: Partial<WorkerFns>;
  scheduler?: SchedulerOptions;
  pinger?: HealthPinger;
  /** Disk-check directory and backup marker (see src/ops/env.ts). */
  ops?: { dataDir?: string | null; backupMarkerFile?: string | null };
}

export interface WorkerHandle {
  /** Stop timers and watchers, let the current message finish; returns what was still running at the deadline. */
  stop(timeoutMs?: number): Promise<string[]>;
  /** Exposed for tests / manual triggering. */
  refreshMailboxes(): Promise<void>;
  drainTick(): Promise<void>;
  resetBudgetPauses(): Promise<number>;
  /** Resolves when no mailbox drain is running (drains are started fire-and-forget). */
  drainsIdle(): Promise<void>;
  watching(): string[];
  lastFullCycle(mailboxId: string): Date | null;
}

export interface ActiveMailbox {
  id: string;
  provider: "imap" | "ingest";
  lastSyncAt: Date | null;
}

// ── Shared with the one-pass worker (tick.ts) ───────────────────────────────

/** Mailboxes the worker serves: status active, owner not disabled. */
export async function loadActiveMailboxes(db: WorkerRuntime["db"]): Promise<ActiveMailbox[]> {
  return db
    .select({ id: mailboxes.id, provider: mailboxes.provider, lastSyncAt: mailboxes.lastSyncAt })
    .from(mailboxes)
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(and(eq(mailboxes.status, "active"), isNull(users.disabledAt)));
}

/**
 * The drain watermark: the START of the newest complete sync cycle (a message first seen during or after
 * it waits for the next one), from this process's own cycles or mailboxes.last_sync_at (written by every complete
 * cycle; covers restarts). Pushed (ingest) mailboxes have no folder cycle to wait for. Null: no complete cycle yet,
 * so wait instead of draining unconstrained.
 */
export function fullCycleAt(mb: ActiveMailbox, lastFullCycle: Date | null, now: Date): Date | null {
  if (mb.provider === "ingest") return now;
  if (lastFullCycle && mb.lastSyncAt) return lastFullCycle > mb.lastSyncAt ? lastFullCycle : mb.lastSyncAt;
  return lastFullCycle ?? mb.lastSyncAt;
}

/**
 * Clear budget pauses whose org-local day is over: the mailbox's spend since local midnight (in its org's timezone,
 * the same window the pipeline's budget check counts) is under its caps again. Same caps and rounding as
 * engine/pipeline.ts budgetExceeded. Manual pauses are never touched.
 */
export async function resetBudgetPauses(rt: Pick<WorkerRuntime, "db" | "config" | "clock">, log: Logger): Promise<number> {
  const now = rt.clock.now();
  const zone = rt.config.DEFAULT_TIMEZONE;
  const paused = await rt.db
    .select({ mailbox: mailboxes, timezone: organizations.timezone })
    .from(mailboxes)
    .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
    .where(and(eq(mailboxes.aiPaused, true), inArray(mailboxes.aiPausedReason, [...BUDGET_PAUSE_REASONS])));
  let cleared = 0;
  for (const { mailbox: mb, timezone } of paused) {
    // One implementation of the budget window/caps: the engine's (org-local day, same rounding as the pipeline).
    if (!(await isBudgetPauseExpired(mb, safeZone(timezone, safeZone(zone)), now, { db: rt.db, config: rt.config }))) continue;
    const rows = await rt.db
      .update(mailboxes)
      .set({ aiPaused: false, aiPausedReason: null })
      .where(and(eq(mailboxes.id, mb.id), eq(mailboxes.aiPaused, true), eq(mailboxes.aiPausedReason, mb.aiPausedReason!)))
      .returning({ id: mailboxes.id });
    cleared += rows.length;
  }
  if (cleared) log.info({ mailboxes: cleared }, "daily AI budget pauses cleared");
  return cleared;
}

/** Daily jobs whose most recent slot passed without a completed run (worker down, or started afterwards). */
export async function missedDailyJobs(db: WorkerRuntime["db"], now: Date, zone: string): Promise<Array<{ name: DailyJobName; lastRun: Date | null }>> {
  const missed: Array<{ name: DailyJobName; lastRun: Date | null }> = [];
  for (const job of DAILY_JOBS) {
    const [row] = await db.select({ value: appState.value }).from(appState).where(eq(appState.key, lastRunKey(job.name)));
    const at = typeof (row?.value as { at?: unknown } | undefined)?.at === "string" ? new Date((row!.value as { at: string }).at) : null;
    const due = previousDailyAt(job.at, zone, now);
    if (!at || Number.isNaN(at.getTime()) || at.getTime() < due.getTime()) missed.push({ name: job.name, lastRun: at });
  }
  return missed;
}

/** The nightly retention purge, recorded as run (`job:retention:last_run`) for the catch-up check. */
export async function runRetentionJob(rt: Pick<WorkerRuntime, "db" | "config" | "clock">, runRetention: WorkerFns["runRetention"], log: Logger): Promise<void> {
  const startedAt = rt.clock.now();
  const r = await runRetention(rt.db, startedAt, rt.config);
  const value = { at: startedAt.toISOString() };
  await rt.db.insert(appState).values({ key: lastRunKey("retention"), value, updatedAt: startedAt }).onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: startedAt } });
  log.info({ ...r }, "retention purge");
}

export function startWorker(rt: WorkerRuntime, opts: WorkerOptions = {}): WorkerHandle {
  const fns: WorkerFns = {
    startMailboxWatcher,
    drainMailbox,
    dispatchDueDigests,
    runAging,
    runHealthChecks,
    runRetention,
    ...opts.fns,
  };
  const log = rt.log.child({ component: "worker" });
  const zone = rt.config.DEFAULT_TIMEZONE;
  const pinger = opts.pinger ?? createHealthPinger(rt.config.HEALTHCHECK_PING_URL, { log, clock: rt.clock });
  const scheduler = createScheduler({ log, clock: rt.clock, ...opts.scheduler });
  /** Last complete sync cycle per mailbox, from onCycle (mailboxes.last_sync_at covers restarts). */
  const fullCycles = new Map<string, Date>();

  const drainer = createDrainCoordinator({
    log,
    // Admin → AI first: a drain must not run with a key or model that was just replaced.
    drain: async (id, o) => {
      await rt.refreshAi?.();
      return fns.drainMailbox(rt.pipelineDeps, id, o);
    },
  });

  const onCycle = (r: SyncReport) => {
    if (r.fullCycle) {
      const prev = fullCycles.get(r.mailboxId);
      // Messages first seen after the cycle started (e.g. after Sent was scanned) wait for the next full cycle.
      if (!prev || prev < r.startedAt) fullCycles.set(r.mailboxId, r.startedAt);
      if (r.ok) void pinger.ping("cycle");
    }
    // A partial cycle does not make newer messages eligible, but the queue up to the last full cycle can move.
    const at = fullCycles.get(r.mailboxId);
    if (at) void drainer.request(r.mailboxId, at);
  };

  const watchers = createWatcherManager({
    start: (id, hooks) => fns.startMailboxWatcher(rt.syncDeps, id, hooks),
    onCycle,
    log,
  });

  const refreshMailboxes = async () => {
    const active = await loadActiveMailboxes(rt.db);
    await watchers.reconcile(active.filter((m) => m.provider === "imap").map((m) => m.id));
  };

  const drainTick = async () => {
    // Also the AI report's heartbeat when no mailbox drains.
    await rt.refreshAi?.().catch((err: unknown) => rt.log.warn({ code: errorCode(err) }, "AI settings refresh failed"));
    for (const mb of await loadActiveMailboxes(rt.db)) {
      const at = fullCycleAt(mb, fullCycles.get(mb.id) ?? null, rt.clock.now());
      if (at) void drainer.request(mb.id, at);
    }
  };

  /** Run a daily job now if its most recent slot passed without a completed run (worker down, or started afterwards). */
  const catchUpDailyJobs = async () => {
    for (const job of await missedDailyJobs(rt.db, rt.clock.now(), zone)) {
      if (scheduler.isRunning(job.name)) continue;
      log.info({ job: job.name, lastRun: job.lastRun?.toISOString() ?? null }, "daily job missed its slot; running it now");
      scheduler.trigger(job.name);
    }
  };

  scheduler.add({ name: "mailboxes", schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.mailboxRefreshMs, jitterMs: 5_000, initialDelayMs: 0 }, run: refreshMailboxes });
  scheduler.add({ name: "drain", schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.drainTickMs, jitterMs: 5_000, initialDelayMs: 5_000 }, run: drainTick });
  scheduler.add({
    name: "digest",
    schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.digestMs, jitterMs: 2_000, initialDelayMs: 10_000 },
    run: async () => {
      const r = await fns.dispatchDueDigests(rt.digestDeps, rt.clock.now());
      if (r.delivered > 0) await pinger.ping("digest");
      if (r.delivered || r.failed || r.skipped) log.info({ ...r }, "digest dispatch");
    },
  });
  scheduler.add({
    name: "aging",
    schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.agingMs, jitterMs: 60_000, initialDelayMs: 60_000 },
    run: async () => {
      // runAging works in each org's own timezone; `zone` is only the fallback for an invalid one.
      const r = await fns.runAging(rt.db, rt.clock.now(), zone);
      if (r.unsnoozed || r.asked || r.dormant) log.info({ ...r }, "aging");
    },
  });
  scheduler.add({
    name: "health",
    schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.healthMs, jitterMs: 15_000, initialDelayMs: 90_000 },
    run: async () => {
      const r = await fns.runHealthChecks(
        { db: rt.db, log, config: rt.config, dataDir: opts.ops?.dataDir ?? null, backupMarkerFile: opts.ops?.backupMarkerFile ?? null },
        rt.clock.now(),
      );
      if (r.alerted.length || r.resolved.length || r.reminded.length) log.info({ alerted: r.alerted.length, resolved: r.resolved.length, reminded: r.reminded.length }, "health");
    },
  });
  scheduler.add({
    name: "retention",
    schedule: { kind: "daily", at: WORKER_SCHEDULE.retentionAt, zone },
    run: () => runRetentionJob(rt, fns.runRetention, log),
  });
  scheduler.add({
    name: "budget-reset",
    schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.budgetCheckMs, jitterMs: 30_000, initialDelayMs: 15_000 },
    run: async () => {
      await resetBudgetPauses(rt, log);
    },
  });
  scheduler.add({
    name: "daily-catch-up",
    schedule: { kind: "interval", everyMs: WORKER_SCHEDULE.dailyCatchUpMs, jitterMs: 60_000, initialDelayMs: 30_000 },
    run: catchUpDailyJobs,
  });
  scheduler.start();
  log.info({ jobs: 8 }, "worker started");

  return {
    async stop(timeoutMs = WORKER_SCHEDULE.shutdownTimeoutMs) {
      const deadline = Date.now() + timeoutMs;
      drainer.stop();
      const jobs = scheduler.stop(timeoutMs);
      await watchers.stopAll(Math.min(30_000, timeoutMs));
      const left = await jobs;
      const drained = await waitAtMost(drainer.idle(), Math.max(0, deadline - Date.now()));
      return [...left, ...(drained ? [] : drainer.active().map((id) => `drain:${id}`))];
    },
    refreshMailboxes,
    drainTick,
    resetBudgetPauses: () => resetBudgetPauses(rt, log),
    drainsIdle: () => drainer.idle(),
    watching: () => watchers.running(),
    lastFullCycle: (id) => fullCycles.get(id) ?? null,
  };
}

/** Count of active mailboxes (startup log). */
export async function countActiveMailboxes(rt: Pick<Runtime, "db">): Promise<number> {
  const res = await rt.db.execute(sql`select count(*)::int as n from mailboxes where status = 'active'`);
  return Number((res.rows[0] as { n: number | string } | undefined)?.n ?? 0);
}
