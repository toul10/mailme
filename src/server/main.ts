import { sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as loadAppConfig } from "../config.js";
import { loadDotEnv } from "../ops/env.js";
import { openDb } from "../db/client.js";
import { systemClock } from "../domain/types.js";
import { loadSealingKeys } from "../lib/sealed.js";
import { createLogger } from "../lib/log.js";
import { errorCode } from "../ops/alerts.js";
import { ingestMessage, type IngestDeps } from "../mail/ingest.js";
import { buildServer } from "./app.js";
import { apiProber } from "./probe.js";
import { cloudRunJobTrigger } from "./sync-now.js";

/** Built SPA next to the repo root (web/dist), if it has been built. */
export function defaultWebDist(): string | null {
  const dir = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return existsSync(path.join(dir, "index.html")) ? dir : null;
}

/**
 * API process: config → db (connectivity check only; migrations are a separate step) → public sealing key →
 * Fastify. The private credentials key is never loaded here.
 */
export async function startApi(): Promise<void> {
  loadDotEnv(process.env.MAILME_ENV_FILE ?? ".env");
  const cfg = loadAppConfig();
  const log = createLogger(cfg.LOG_LEVEL, { proc: "api" });
  const handle = await openDb(cfg.DATABASE_URL);
  await handle.db.execute(sql`select 1`);
  // A connection dropped by the server (DB restart, maintenance) must not crash the API; queries reconnect.
  handle.pool?.on("error", (err) => log.error({ code: errorCode(err) }, "idle database connection error"));

  const keys = loadSealingKeys({ kid: cfg.CREDENTIALS_KID, publicKeyFile: cfg.CREDENTIALS_PUBLIC_KEY_FILE });
  const ingestDeps: IngestDeps = {
    db: handle.db,
    clock: systemClock,
    log: log.child({ mod: "ingest" }),
    platformMailDomain: cfg.PLATFORM_MAIL_DOMAIN,
    lateDiscoveryMaxDays: cfg.LATE_DISCOVERY_MAX_DAYS,
    denyList: cfg.DENY_LIST,
  };
  const webDist = defaultWebDist();

  const app = await buildServer({
    db: handle.db,
    clock: systemClock,
    log,
    config: cfg,
    sealingKeys: { kid: keys.kid, publicKey: keys.publicKey },
    // The credentials route records each login attempt itself (once, synchronously): a non-recording prober.
    probe: apiProber(),
    ingest: (input) => ingestMessage(ingestDeps, input),
    webDist,
    syncNow: cfg.TICK_JOB ? cloudRunJobTrigger(cfg.TICK_JOB) : null,
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, "api shutting down");
    try {
      await app.close();
    } finally {
      await handle.close();
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  log.info({ host: cfg.HOST, port: cfg.PORT, spa: webDist !== null, db: handle.kind }, "api listening");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startApi().catch((err: unknown) => {
    // Startup errors are configuration problems (env, key file, db URL); print them for the operator.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
