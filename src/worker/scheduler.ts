import { DateTime } from "luxon";
import type { Clock, Logger } from "../domain/types.js";
import { systemClock } from "../domain/types.js";
import { nullLogger } from "../lib/log.js";
import { errorCode } from "../ops/alerts.js";

/**
 * Tiny in-process scheduler for the worker's periodic jobs. Each job re-arms its timer only after the
 * previous run finished, so runs of one job never overlap; jitter spreads jobs apart.
 */

export type JobSchedule =
  /** Every `everyMs` (± `jitterMs`) after the previous run ended. First run after `initialDelayMs` (default: a jittered interval). */
  | { kind: "interval"; everyMs: number; jitterMs?: number; initialDelayMs?: number }
  /** Daily at local "HH:MM" in `zone`. */
  | { kind: "daily"; at: string; zone: string };

export interface JobSpec {
  name: string;
  schedule: JobSchedule;
  run(): Promise<unknown>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerOptions {
  log?: Logger;
  clock?: Clock;
  /** [0, 1) — injectable for tests. */
  random?: () => number;
  timers?: Timers;
}

export interface Scheduler {
  add(job: JobSpec): void;
  start(): void;
  /** Run a job now. If it is running, it runs once more right after (coalesced). False for unknown jobs or after stop. */
  trigger(name: string): boolean;
  isRunning(name: string): boolean;
  /** Stop arming timers and wait for running jobs up to `timeoutMs`. Returns the jobs still running at the deadline. */
  stop(timeoutMs?: number): Promise<string[]>;
  /** Completed runs per job (successful or failed). */
  runCount(name: string): number;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Delay until the next run. Interval: everyMs + uniform(−jitter, +jitter), never negative. Daily: next HH:MM strictly after now. */
export function nextDelayMs(schedule: JobSchedule, now: Date, random: () => number = Math.random): number {
  if (schedule.kind === "interval") {
    const jitter = schedule.jitterMs ?? 0;
    return Math.max(0, Math.round(schedule.everyMs + (random() * 2 - 1) * jitter));
  }
  const [h, m] = parseHhMm(schedule.at);
  const local = DateTime.fromJSDate(now, { zone: schedule.zone });
  let next = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (next.toMillis() <= local.toMillis()) next = next.plus({ days: 1 }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  return next.toMillis() - local.toMillis();
}

/** The most recent local "HH:MM" in `zone` at or before `now` (a daily job's last due slot). */
export function previousDailyAt(at: string, zone: string, now: Date): Date {
  const [h, m] = parseHhMm(at);
  const local = DateTime.fromJSDate(now, { zone });
  let slot = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (slot.toMillis() > local.toMillis()) slot = slot.minus({ days: 1 }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  return slot.toJSDate();
}

function parseHhMm(at: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(at);
  const h = Number(match?.[1]);
  const m = Number(match?.[2]);
  if (!match || h > 23 || m > 59) throw new Error(`Invalid daily time "${at}" (expected HH:MM)`);
  return [h, m];
}

interface JobState {
  spec: JobSpec;
  timer: unknown;
  running: Promise<void> | null;
  rerun: boolean;
  runs: number;
}

export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  const log = opts.log ?? nullLogger;
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? Math.random;
  const timers = opts.timers ?? defaultTimers;
  const jobs = new Map<string, JobState>();
  let started = false;
  let stopped = false;

  const arm = (job: JobState, delay: number) => {
    if (stopped) return;
    if (job.timer !== null) timers.clearTimeout(job.timer);
    job.timer = timers.setTimeout(() => fire(job), delay);
  };

  const fire = (job: JobState) => {
    job.timer = null;
    if (stopped) return;
    if (job.running) {
      job.rerun = true;
      return;
    }
    const startedAt = clock.now().getTime();
    job.running = (async () => {
      try {
        await job.spec.run();
      } catch (err) {
        log.error({ job: job.spec.name, code: errorCode(err) }, "job failed");
      }
    })().finally(() => {
      job.runs++;
      job.running = null;
      log.debug({ job: job.spec.name, ms: clock.now().getTime() - startedAt }, "job finished");
      if (stopped) return;
      if (job.rerun) {
        job.rerun = false;
        arm(job, 0);
      } else {
        arm(job, nextDelayMs(job.spec.schedule, clock.now(), random));
      }
    });
  };

  const initialDelay = (s: JobSchedule) =>
    s.kind === "interval" && s.initialDelayMs !== undefined ? s.initialDelayMs : nextDelayMs(s, clock.now(), random);

  return {
    add(spec) {
      if (jobs.has(spec.name)) throw new Error(`Duplicate job ${spec.name}`);
      if (spec.schedule.kind === "daily") parseHhMm(spec.schedule.at);
      const job: JobState = { spec, timer: null, running: null, rerun: false, runs: 0 };
      jobs.set(spec.name, job);
      if (started) arm(job, initialDelay(spec.schedule));
    },
    start() {
      if (started || stopped) return;
      started = true;
      for (const job of jobs.values()) arm(job, initialDelay(job.spec.schedule));
    },
    trigger(name) {
      const job = jobs.get(name);
      if (!job || stopped) return false;
      if (job.running) {
        job.rerun = true;
        return true;
      }
      if (job.timer !== null) timers.clearTimeout(job.timer);
      fire(job);
      return true;
    },
    isRunning(name) {
      return jobs.get(name)?.running != null;
    },
    runCount(name) {
      return jobs.get(name)?.runs ?? 0;
    },
    async stop(timeoutMs = 110_000) {
      stopped = true;
      for (const job of jobs.values()) {
        if (job.timer !== null) timers.clearTimeout(job.timer);
        job.timer = null;
        job.rerun = false;
      }
      const running = [...jobs.values()].filter((j) => j.running).map((j) => j.running!);
      if (running.length > 0) await waitAtMost(Promise.allSettled(running), timeoutMs, timers);
      return [...jobs.values()].filter((j) => j.running).map((j) => j.spec.name);
    },
  };
}

/** Resolve when `p` settles or after `ms`, whichever comes first. */
export async function waitAtMost(p: Promise<unknown>, ms: number, timers: Timers = defaultTimers): Promise<boolean> {
  let handle: unknown = null;
  const timeout = new Promise<false>((resolve) => {
    handle = timers.setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const, () => true as const), timeout]);
  } finally {
    if (handle !== null) timers.clearTimeout(handle);
  }
}
