import { spawn } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { hash } from "@node-rs/argon2";
import type { createChatModel } from "../chat/model.js";
import type { probeChat } from "../chat/probe.js";
import type { Config } from "../config.js";
import type { Db, DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { mailboxes, organizations, securityAudit, users } from "../db/schema.js";
import { deliverDigestForUser } from "../digest/dispatch.js";
import { drainMailbox } from "../engine/pipeline.js";
import { importEmlFiles } from "../mail/eml-import.js";
import { defaultSyncEnabled } from "../mail/imap/folders.js";
import { probeMailbox } from "../mail/imap/probe.js";
import { syncMailboxOnce } from "../mail/imap/sync.js";
import type { OpsEnv } from "../ops/env.js";
import { runHealthChecks } from "../ops/health.js";
import { runRetention } from "../ops/retention.js";
import type { Runtime } from "../worker/runtime.js";
import { UsageError } from "./args.js";
import type { CliIO } from "./io.js";

/** Functions from other packages, injectable so commands are testable without IMAP, SMTP or Claude. */
export interface CliServices {
  runMigrations(handle: DbHandle): Promise<void>;
  hashPassword(password: string): Promise<string>;
  probeMailbox: typeof probeMailbox;
  defaultSyncEnabled: typeof defaultSyncEnabled;
  syncMailboxOnce: typeof syncMailboxOnce;
  drainMailbox: typeof drainMailbox;
  importEmlFiles: typeof importEmlFiles;
  deliverDigestForUser: typeof deliverDigestForUser;
  runRetention: typeof runRetention;
  runHealthChecks: typeof runHealthChecks;
  /** chat:check only; defaults: the configured chat model (src/chat/model.ts) and the invented question (src/chat/probe.ts). */
  createChatModel?: typeof createChatModel;
  probeChat?: typeof probeChat;
  /** Run an external program (pg_dump) with extra environment variables; only exit code and stderr are captured. */
  exec(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }): Promise<{ code: number; stderr: string }>;
}

export interface CliContext {
  io: CliIO;
  /** Validated configuration; throws with the list of missing/invalid keys. */
  config(): Config;
  /** Like config() but null instead of throwing (keys:generate, secrets:generate work before .env exists). */
  tryConfig(): Config | null;
  ops(): OpsEnv;
  /** Opened once per invocation, keys loaded lazily (sealing needs only the public key). */
  runtime(): Promise<Runtime>;
  services: CliServices;
  now(): Date;
}

/** Password hashing for web logins: argon2id with the same OWASP parameters as the API (19 MiB, t=2, p=1). */
export async function hashPassword(password: string): Promise<string> {
  const h = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
  if (!h.startsWith("$argon2id$")) throw new Error("argon2 did not produce an argon2id hash");
  return h;
}

export function execCommand(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => resolve({ code: 127, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export const defaultServices: CliServices = {
  runMigrations,
  hashPassword,
  probeMailbox,
  defaultSyncEnabled,
  syncMailboxOnce,
  drainMailbox,
  importEmlFiles,
  deliverDigestForUser,
  runRetention,
  runHealthChecks,
  exec: execCommand,
};

// ── Lookups ──────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

export async function findOrg(db: Db, ref: string) {
  const rows = isUuid(ref)
    ? await db.select().from(organizations).where(eq(organizations.id, ref))
    : await db.select().from(organizations).where(sql`lower(${organizations.name}) = ${ref.toLowerCase()}`);
  if (rows.length === 0) throw new UsageError(`Organization not found: ${ref}`);
  if (rows.length > 1) throw new UsageError(`Several organizations are named "${ref}"; use the id`);
  return rows[0]!;
}

export async function findUser(db: Db, ref: string) {
  const rows = isUuid(ref)
    ? await db.select().from(users).where(eq(users.id, ref))
    : await db.select().from(users).where(sql`lower(${users.email}) = ${ref.trim().toLowerCase()}`);
  if (!rows[0]) throw new UsageError(`User not found: ${ref}`);
  return rows[0];
}

export async function findMailbox(db: Db, ref: string) {
  const rows = isUuid(ref)
    ? await db.select().from(mailboxes).where(eq(mailboxes.id, ref))
    : await db.select().from(mailboxes).where(eq(mailboxes.address, ref.trim().toLowerCase()));
  if (rows.length === 0) throw new UsageError(`Mailbox not found: ${ref}`);
  if (rows.length > 1) throw new UsageError(`Several mailboxes have address ${ref}; use the id`);
  return rows[0]!;
}

export async function findUserMailbox(db: Db, userId: string, address: string) {
  const [row] = await db.select().from(mailboxes).where(and(eq(mailboxes.userId, userId), eq(mailboxes.address, address)));
  return row ?? null;
}

/** Append-only security log; never content. */
export async function audit(db: Db, event: string, e: { orgId?: string | null; userId?: string | null; detail?: Record<string, unknown>; now: Date }) {
  await db.insert(securityAudit).values({ event, orgId: e.orgId ?? null, userId: e.userId ?? null, detail: { via: "cli", ...e.detail }, ip: null, createdAt: e.now });
}

/** Local date (YYYY-MM-DD) validation. */
export function assertIsoDate(v: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new UsageError(`${what} must be YYYY-MM-DD`);
  return v;
}

export function assertHhMm(v: string, what: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new UsageError(`${what} must be HH:MM`);
  return v;
}
