import { createExtractor } from "../ai/index.js";
import type { Config } from "../config.js";
import { openDb, withSessionLock, type Db, type DbHandle } from "../db/client.js";
import { mailboxLoginAttempts } from "../db/schema.js";
import type { DigestDeps } from "../digest/dispatch.js";
import type { Clock, Extractor, IngestInput, IngestResult, Logger, MailTransport } from "../domain/types.js";
import { systemClock } from "../domain/types.js";
import type { PipelineDeps } from "../engine/pipeline.js";
import { openMailboxPassword } from "../lib/credentials.js";
import { createLogger } from "../lib/log.js";
import { loadSealingKeys, type SealingKeys } from "../lib/sealed.js";
import type { SyncDeps } from "../mail/imap/sync.js";
import { ingestMessage } from "../mail/ingest.js";
import { createMailTransport } from "../mail/transport.js";
import { errorCode } from "../ops/alerts.js";

/**
 * Process wiring shared by the worker and the CLI: one db handle, logger, clock, sealing keys and the
 * dependency bundles each package expects. The API process builds its own deps and never loads the
 * private key.
 */

type SealedMailbox = { id: string; address: string; credentialsSealed: string | null };
type LoginPurpose = (typeof mailboxLoginAttempts.$inferInsert)["purpose"];
type LoginOutcome = (typeof mailboxLoginAttempts.$inferInsert)["outcome"];

export interface Runtime {
  config: Config;
  handle: DbHandle;
  db: Db;
  log: Logger;
  clock: Clock;
  /** Loaded once. Throws when the private key is required (worker, opening credentials) but not configured. */
  sealingKeys(opts?: { requirePrivate?: boolean }): SealingKeys;
  getPassword(mailbox: SealedMailbox): Promise<string>;
  /** Created on first use (the Claude client needs ANTHROPIC_API_KEY; most CLI commands never touch it). */
  readonly extractor: Extractor;
  readonly transport: MailTransport;
  ingest(input: IngestInput): Promise<IngestResult>;
  withLock: PipelineDeps["withLock"];
  recordLoginAttempt(mailboxId: string, purpose: LoginPurpose, outcome: string, detail?: string | null): Promise<void>;
  syncDeps: SyncDeps;
  pipelineDeps: PipelineDeps;
  digestDeps: DigestDeps;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  /** "eager" (worker): load keys now and require the private key. "lazy" (CLI): load on first use. Default eager. */
  keys?: "eager" | "lazy";
  log?: Logger;
  clock?: Clock;
  /** Test seams: reuse an open handle / inject keys, extractor or transport. */
  handle?: DbHandle;
  sealingKeys?: SealingKeys;
  extractor?: Extractor;
  transport?: MailTransport;
}

const LOGIN_OUTCOMES = ["ok", "auth_failed", "network", "tls", "too_many", "protocol", "other"] as const;

/** Map an error kind / outcome string to the login-attempt enum. */
export function normalizeLoginOutcome(outcome: string): LoginOutcome {
  const o = outcome.toLowerCase();
  if (o === "auth") return "auth_failed";
  return (LOGIN_OUTCOMES as readonly string[]).includes(o) ? (o as LoginOutcome) : "other";
}

import { deriveLinkSecret } from "../lib/crypto.js";
export { deriveLinkSecret };

export async function createRuntime(config: Config, opts: RuntimeOptions = {}): Promise<Runtime> {
  const log = opts.log ?? createLogger(config.LOG_LEVEL);
  const clock = opts.clock ?? systemClock;

  let keys: SealingKeys | null = opts.sealingKeys ?? null;
  const sealingKeys = (o: { requirePrivate?: boolean } = {}): SealingKeys => {
    keys ??= loadSealingKeys({
      kid: config.CREDENTIALS_KID,
      publicKeyFile: config.CREDENTIALS_PUBLIC_KEY_FILE,
      privateKeyFile: config.CREDENTIALS_PRIVATE_KEY_FILE ?? null,
    });
    if (o.requirePrivate && !keys.privateKey) {
      throw new Error("CREDENTIALS_PRIVATE_KEY_FILE is not set: this process cannot open mailbox credentials");
    }
    return keys;
  };
  // Fail fast before touching the database: a worker without its private key is useless.
  if ((opts.keys ?? "eager") === "eager") sealingKeys({ requirePrivate: true });

  const handle = opts.handle ?? (await openDb(config.DATABASE_URL));
  const db = handle.db;

  let extractor: Extractor | null = opts.extractor ?? null;
  let transport: MailTransport | null = opts.transport ?? null;

  const recordLoginAttempt: Runtime["recordLoginAttempt"] = async (mailboxId, purpose, outcome, detail) => {
    try {
      await db.insert(mailboxLoginAttempts).values({
        mailboxId,
        purpose,
        outcome: normalizeLoginOutcome(outcome),
        detail: detail ? detail.slice(0, 120) : null,
        at: clock.now(),
      });
    } catch (err) {
      log.warn({ mailboxId, purpose, code: errorCode(err) }, "could not record login attempt");
    }
  };

  const getPassword = async (mailbox: SealedMailbox) => openMailboxPassword(mailbox, sealingKeys({ requirePrivate: true }));
  const ingest = (input: IngestInput) =>
    ingestMessage({ db, clock, log, platformMailDomain: config.PLATFORM_MAIL_DOMAIN, lateDiscoveryMaxDays: config.LATE_DISCOVERY_MAX_DAYS, denyList: config.DENY_LIST }, input);
  const withLock: PipelineDeps["withLock"] = (key, fn) => withSessionLock(handle, key, fn);

  const rt: Runtime = {
    config,
    handle,
    db,
    log,
    clock,
    sealingKeys,
    getPassword,
    get extractor() {
      extractor ??= createExtractor(config);
      return extractor;
    },
    get transport() {
      transport ??= createMailTransport({
        onLoginAttempt: (mailboxId, purpose, outcome, detail) => void recordLoginAttempt(mailboxId, purpose, outcome, detail),
      });
      return transport;
    },
    ingest,
    withLock,
    recordLoginAttempt,
    syncDeps: {
      db,
      clock,
      log: log.child({ component: "sync" }),
      config: {
        BACKFILL_DAYS: config.BACKFILL_DAYS,
        MAX_FETCH_BYTES: config.MAX_FETCH_BYTES,
        FOLDER_POLL_SEC: config.FOLDER_POLL_SEC,
        SYNC_INTERVAL_SEC: config.SYNC_INTERVAL_SEC,
      },
      getPassword,
      ingest,
    },
    pipelineDeps: {
      db,
      withLock,
      get extractor() {
        return rt.extractor;
      },
      clock,
      log: log.child({ component: "pipeline" }),
      config: { SETTLE_SEC: config.SETTLE_SEC, AI_DAILY_CALL_CAP: config.AI_DAILY_CALL_CAP, AI_DAILY_USD_CAP: config.AI_DAILY_USD_CAP },
    },
    digestDeps: {
      db,
      clock,
      log: log.child({ component: "digest" }),
      get transport() {
        return rt.transport;
      },
      getPassword,
      config: {
        APP_BASE_URL: config.APP_BASE_URL,
        PLATFORM_MAIL_DOMAIN: config.PLATFORM_MAIL_DOMAIN,
        DEFAULT_TIMEZONE: config.DEFAULT_TIMEZONE,
        linkSecret: deriveLinkSecret(config),
      },
    },
    close: () => handle.close(),
  };
  return rt;
}
