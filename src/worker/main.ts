import { sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { acquireProcessLock } from "../db/client.js";
import { createLogger } from "../lib/log.js";
import { errorCode } from "../ops/alerts.js";
import { loadDotEnv, readOpsEnv } from "../ops/env.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { runWorkerTick } from "./tick.js";
import { countActiveMailboxes, startWorker, WORKER_SCHEDULE, type WorkerHandle } from "./worker.js";

/** After the lock is lost another worker may already run: finish the message in flight, but do not wait long. */
const LOCK_LOST_STOP_MS = 15_000;

/**
 * `pnpm start:worker` — single instance (advisory lock "worker"), graceful SIGINT/SIGTERM.
 * `pnpm start:tick` (`--tick`) — one pass (src/worker/tick.ts), then exit: 0 done or skipped (the lock is held by
 * another tick or a running worker), 1 a step failed. For hosts that start the worker on a schedule (Cloud Run job).
 * `--check` — start-up only: configuration, both sealing keys and the database (select 1), then exit 0. It takes no
 * lock and touches no data: the smoke test of a new deployment (deploy/gcp/README.md).
 */
async function main(): Promise<void> {
  loadDotEnv(".env");
  const config = loadConfig(process.env);
  const ops = readOpsEnv(process.env);
  const tick = process.argv.includes("--tick");
  const check = process.argv.includes("--check");
  const log = createLogger(config.LOG_LEVEL, { proc: tick ? "tick" : check ? "check" : "worker" });

  let rt: Runtime;
  try {
    rt = await createRuntime(config, { log, keys: "eager" });
  } catch (err) {
    console.error(`worker: cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (check) {
    await rt.db.execute(sql`select 1`);
    log.info({ aiMode: config.AI_MODE, db: rt.handle.kind }, "check ok: configuration, both keys and the database");
    await rt.close().catch(() => undefined);
    process.exit(0);
  }

  // An idle pooled connection dropped by the server (DB restart) must not crash the worker; queries reconnect.
  rt.handle.pool?.on("error", (err) => log.error({ code: errorCode(err) }, "idle database connection error"));

  let shutdown: ((reason: string, code: number, timeoutMs?: number) => Promise<void>) | null = null;
  const release = await acquireProcessLock(rt.handle, "worker", (err) => {
    // The session holding the lock is gone (DB restart, failover, dropped connection): this process no longer owns
    // the single-instance guard. Exit non-zero; the supervisor (launchd, compose, Cloud Run) starts a new worker.
    log.error({ code: errorCode(err) }, "worker lock lost with its database session; exiting");
    if (shutdown) void shutdown("lock_lost", 1, LOCK_LOST_STOP_MS);
    else process.exit(1);
  });
  if (!release) {
    await rt.close();
    if (tick) {
      log.info({}, "tick skipped: another tick or worker holds the lock");
      process.exit(0);
    }
    console.error('worker: another worker is already running (advisory lock "worker" is held). Exiting.');
    process.exit(1);
  }

  const dataDir = ops.DISK_CHECK === "off" ? null : existsSync(ops.DATA_DIR) ? path.resolve(ops.DATA_DIR) : process.cwd();
  const opsDeps = { dataDir, backupMarkerFile: ops.BACKUP_MARKER_FILE ?? null };

  if (tick) {
    const r = await runWorkerTick(rt, { ops: opsDeps });
    log.info({ ...r }, "tick done");
    await release().catch(() => undefined);
    await rt.close().catch(() => undefined);
    process.exit(r.failed ? 1 : 0);
  }

  const worker: WorkerHandle = startWorker(rt, { ops: opsDeps });
  log.info({ aiMode: config.AI_MODE, mailboxes: await countActiveMailboxes(rt) }, "worker running");

  let stopping = false;
  shutdown = async (reason: string, exitCode: number, timeoutMs: number = WORKER_SCHEDULE.shutdownTimeoutMs) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal: reason }, "worker shutting down");
    let code = exitCode;
    try {
      const left = await worker.stop(timeoutMs);
      if (left.length) log.warn({ running: left }, "still running at shutdown deadline");
    } catch (err) {
      code = 1;
      log.error({ code: errorCode(err) }, "shutdown error");
    }
    await release().catch(() => undefined);
    await rt.close().catch(() => undefined);
    log.info({}, "worker stopped");
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown?.("SIGINT", 0));
  process.on("SIGTERM", () => void shutdown?.("SIGTERM", 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(`worker: fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
