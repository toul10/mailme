import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import * as s from "../../src/db/schema.js";
import type { Clock, IngestInput, IngestResult, Logger, MailboxConnectionSettings } from "../../src/domain/types.js";
import { encryptSecret } from "../../src/lib/crypto.js";
import { ephemeralSealingKeys, type SealingKeys } from "../../src/lib/sealed.js";
import type { ProbeResult } from "../../src/mail/imap/probe.js";
import { buildServer } from "../../src/server/app.js";
import { hashPassword } from "../../src/server/auth/passwords.js";
import { cookieConfig, createSession } from "../../src/server/auth/sessions.js";
import type { SyncNowTrigger } from "../../src/server/sync-now.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

export const PASSWORD = "correct horse battery staple";
export const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
/** mail.contoso.example's public address: what the harness resolver answers by default. */
export const PUBLIC_MAIL_IP = "9.9.9.9";

export class FakeClock implements Clock {
  constructor(public t: Date = new Date("2026-09-15T07:00:00Z")) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ MASTER_KEY, APP_SECRET: "test-secret-test-secret-test-secret-1234", NODE_ENV: "test", AI_MODE: "mock", ...overrides });
}

export interface LogCall {
  level: string;
  obj: object;
  msg?: string;
}

export function spyLogger(calls: LogCall[]): Logger {
  const mk = (level: string) => (obj: object, msg?: string) => void calls.push({ level, obj, msg });
  const logger: Logger = { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug"), child: () => logger };
  return logger;
}

export interface Harness {
  t: TestDb;
  app: FastifyInstance;
  clock: FakeClock;
  config: Config;
  keys: SealingKeys;
  logs: LogCall[];
  probe: ReturnType<typeof vi.fn<(settings: MailboxConnectionSettings, password: string) => Promise<ProbeResult>>>;
  ingest: ReturnType<typeof vi.fn<(input: IngestInput) => Promise<IngestResult>>>;
  /** DNS for the SSRF guard: every name resolves to a public address unless a test says otherwise. */
  resolveHost: ReturnType<typeof vi.fn<(host: string) => Promise<string[]>>>;
  seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
  close(): Promise<void>;
}

export async function makeHarness(opts: { config?: Record<string, string>; webDist?: string | null; clock?: FakeClock; syncNow?: SyncNowTrigger | null } = {}): Promise<Harness> {
  const t = await createTestDb();
  const clock = opts.clock ?? new FakeClock();
  const config = testConfig(opts.config);
  const keys = ephemeralSealingKeys("k-test");
  const logs: LogCall[] = [];
  const probe = vi.fn<(settings: MailboxConnectionSettings, password: string) => Promise<ProbeResult>>();
  const ingest = vi.fn<(input: IngestInput) => Promise<IngestResult>>();
  const resolveHost = vi.fn<(host: string) => Promise<string[]>>(async () => [PUBLIC_MAIL_IP]);
  const seed = await seedOrgUserMailbox(t.db);
  const app = await buildServer({
    db: t.db,
    clock,
    log: spyLogger(logs),
    config,
    sealingKeys: { kid: keys.kid, publicKey: keys.publicKey },
    probe,
    ingest,
    webDist: opts.webDist ?? null,
    resolveHost,
    syncNow: opts.syncNow ?? null,
  });
  await app.ready();
  return {
    t,
    app,
    clock,
    config,
    keys,
    logs,
    probe,
    ingest,
    resolveHost,
    seed,
    async close() {
      await app.close();
      await t.close();
    },
  };
}

/** Give a seeded user a password (and optionally an enabled TOTP secret). */
export async function setCredentials(h: Harness, userId: string, opts: { totpSecret?: string } = {}): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await h.t.db
    .update(s.users)
    .set({
      passwordHash: await hashPassword(PASSWORD),
      totpSecretEnc: opts.totpSecret ? encryptSecret(opts.totpSecret, MASTER_KEY) : null,
      totpEnabled: !!opts.totpSecret,
    })
    .where(eq(s.users.id, userId));
}

export async function addUser(h: Harness, opts: { email: string; role?: "admin" | "member"; orgId?: string }) {
  const [u] = await h.t.db
    .insert(s.users)
    .values({ orgId: opts.orgId ?? h.seed.org.id, name: opts.email.split("@")[0]!, email: opts.email, role: opts.role ?? "member" })
    .returning();
  return u!;
}

export interface Session {
  cookies: Record<string, string>;
  csrf: string;
}

/** A fully authenticated session created directly in the DB (no password/TOTP round trip). */
export async function sessionFor(h: Harness, userId: string, mfaVerified = true): Promise<Session> {
  const sess = await createSession(h.t.db, userId, mfaVerified, h.clock.now());
  return { cookies: { [cookieConfig(h.config.APP_BASE_URL).session]: sess.token }, csrf: sess.csrfToken };
}

export function cookiesFrom(res: LightMyRequestResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.cookies as Array<{ name: string; value: string }>) out[c.name] = c.value;
  return out;
}

export function setCookieHeaders(res: LightMyRequestResponse): string[] {
  const raw = res.headers["set-cookie"];
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
}

/** JSON request with the session cookie and CSRF header. */
export function api(h: Harness, sess: Session | null, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) {
  return h.app.inject({
    method,
    url,
    cookies: sess?.cookies ?? {},
    headers: sess && method !== "GET" ? { "x-csrf-token": sess.csrf } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}
