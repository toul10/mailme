import { runAging } from "../digest/aging.js";
import { dispatchDueDigests } from "../digest/dispatch.js";
import { drainMailbox } from "../engine/pipeline.js";
import { syncMailboxOnce } from "../mail/imap/sync.js";
import { errorCode } from "../ops/alerts.js";
import { runHealthChecks } from "../ops/health.js";
import { createHealthPinger, type HealthPinger } from "../ops/ping.js";
import { runRetention } from "../ops/retention.js";
import { createDrainCoordinator } from "./drainer.js";
import { fullCycleAt, loadActiveMailboxes, missedDailyJobs, resetBudgetPauses, runRetentionJob, type WorkerFns, type WorkerRuntime } from "./worker.js";

/**
 * One pass of the worker, for hosts that start it on a schedule instead of keeping it running (Cloud Run job +
 * Cloud Scheduler: deploy/gcp/README.md). It does what the long-running worker does on its timers, once, in order,
 * and awaits everything: nothing is left running when the process exits. The caller holds the "worker" process lock,
 * so a tick never overlaps another tick, or a running worker, on the same database.
 *
 * 1. Budget pauses whose org-local day is over are cleared (first, so a new day's budget is used in this pass).
 * 2. Per active mailbox: one full IMAP sync cycle (login → LIST → STATUS → fetch → logout), then the queue is drained
 *    up to the START of the newest complete cycle (mail first seen during or after it waits for the next
 *    tick). Pushed (ingest) mailboxes only drain.
 * 3. Due reports (exactly once per user and day), 4. aging, 5. the nightly retention when its slot passed without a
 *    run, 6. health checks last, so they see this pass's sync results.
 *
 * A mailbox that cannot sync records that itself (status, backoff, health alerts) and does not fail the tick. An
 * unexpected exception does (`failed`), after the remaining steps have still run.
 */

export type TickFns = Omit<WorkerFns, "startMailboxWatcher"> & { syncMailboxOnce: typeof syncMailboxOnce };

export interface TickOptions {
  fns?: Partial<TickFns>;
  pinger?: HealthPinger;
  /** Disk-check directory (null skips it) and backup marker, as for the worker (src/ops/env.ts). */
  ops?: { dataDir?: string | null; backupMarkerFile?: string | null };
}

export interface TickReport {
  mailboxes: number;
  synced: number;
  syncFailed: number;
  /** Messages the drains processed (extracted, applied or parked). */
  processed: number;
  digestsDelivered: number;
  budgetPausesCleared: number;
  retention: boolean;
  /** Steps that threw: `sync:<id>`, `drain:<id>`, `digest`, … */
  failures: string[];
  failed: boolean;
  ms: number;
}

export async function runWorkerTick(rt: WorkerRuntime, opts: TickOptions = {}): Promise<TickReport> {
  const fns: TickFns = { syncMailboxOnce, drainMailbox, dispatchDueDigests, runAging, runHealthChecks, runRetention, ...opts.fns };
  const log = rt.log.child({ component: "tick" });
  const zone = rt.config.DEFAULT_TIMEZONE;
  const pinger = opts.pinger ?? createHealthPinger(rt.config.HEALTHCHECK_PING_URL, { log, clock: rt.clock });
  const startedMs = rt.clock.now().getTime();
  const failures: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      failures.push(name);
      log.error({ step: name, code: errorCode(err) }, "tick step failed");
      return undefined;
    }
  };

  const budgetPausesCleared = (await step("budget-reset", () => resetBudgetPauses(rt, log))) ?? 0;

  let processed = 0;
  // The worker's own coordinator: same batches, same stop conditions (lock busy, backoff, pauses, queue empty).
  const drainer = createDrainCoordinator({
    log,
    drain: async (id, o) => {
      try {
        const r = await fns.drainMailbox(rt.pipelineDeps, id, o);
        processed += r.processed;
        return r;
      } catch (err) {
        failures.push(`drain:${id}`);
        throw err; // logged by the coordinator ("drain failed"); the message is retried by the next tick
      }
    },
  });
  const active = (await step("mailboxes", () => loadActiveMailboxes(rt.db))) ?? [];
  let synced = 0;
  let syncFailed = 0;
  for (const mb of active) {
    let cycleStart: Date | null = null;
    if (mb.provider === "imap") {
      const r = await step(`sync:${mb.id}`, () => fns.syncMailboxOnce(rt.syncDeps, mb.id));
      if (r) {
        if (r.ok) synced++;
        else syncFailed++;
        if (r.fullCycle) {
          cycleStart = r.startedAt;
          if (r.ok) await pinger.ping("cycle");
        }
      }
    }
    const at = fullCycleAt(mb, cycleStart, rt.clock.now());
    if (at) await drainer.request(mb.id, at);
  }

  const digest = await step("digest", () => fns.dispatchDueDigests(rt.digestDeps, rt.clock.now()));
  if (digest && digest.delivered > 0) await pinger.ping("digest");
  if (digest && (digest.delivered || digest.failed || digest.skipped)) log.info({ ...digest }, "digest dispatch");

  // runAging works in each org's own timezone; `zone` is only the fallback for an invalid one.
  const aging = await step("aging", () => fns.runAging(rt.db, rt.clock.now(), zone));
  if (aging && (aging.unsnoozed || aging.asked || aging.dormant)) log.info({ ...aging }, "aging");

  let retention = false;
  for (const job of (await step("daily-catch-up", () => missedDailyJobs(rt.db, rt.clock.now(), zone))) ?? []) {
    if (job.name !== "retention") continue;
    log.info({ job: job.name, lastRun: job.lastRun?.toISOString() ?? null }, "daily job missed its slot; running it now");
    retention = (await step("retention", async () => (await runRetentionJob(rt, fns.runRetention, log), true))) ?? false;
  }

  const health = await step("health", () =>
    fns.runHealthChecks(
      { db: rt.db, log, config: rt.config, dataDir: opts.ops?.dataDir ?? null, backupMarkerFile: opts.ops?.backupMarkerFile ?? null },
      rt.clock.now(),
    ),
  );
  if (health && (health.alerted.length || health.resolved.length || health.reminded.length)) {
    log.info({ alerted: health.alerted.length, resolved: health.resolved.length, reminded: health.reminded.length }, "health");
  }

  return {
    mailboxes: active.length,
    synced,
    syncFailed,
    processed,
    digestsDelivered: digest?.delivered ?? 0,
    budgetPausesCleared,
    retention,
    failures,
    failed: failures.length > 0,
    ms: rt.clock.now().getTime() - startedMs,
  };
}
