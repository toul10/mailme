import { sql } from "drizzle-orm";
import type { Db } from "../../src/db/client.js";
import * as s from "../../src/db/schema.js";
import type { AppendResult, Logger, MailboxConnectionSettings, MailTransport } from "../../src/domain/types.js";
import type { DigestDeps } from "../../src/digest/dispatch.js";
import type { LinkFactory } from "../../src/digest/model.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

export const LINK_SECRET = "digest-link-secret-digest-link-secret-0001";
export const BASE_URL = "https://mailme.example.test";

/** Thursday 24/09/2026 (EEST, UTC+3). */
export const TODAY = "2026-09-24";
/** 07:30 Athens on TODAY. */
export const AT_0730 = new Date("2026-09-24T04:30:00Z");

export interface Fixture {
  t: TestDb;
  db: Db;
  orgId: string;
  userId: string;
  mailboxId: string;
}

let userSeq = 0;

/** Fresh org/user/mailbox; in a fresh in-memory DB unless `shared` is given (then with a unique address). */
export async function setup(opts: { lastSyncAt?: Date | null; shared?: TestDb } = {}): Promise<Fixture> {
  const t = opts.shared ?? (await createTestDb());
  const { org, user, mailbox } = await seedOrgUserMailbox(t.db, opts.shared ? { address: `owner${++userSeq}@contoso.example` } : {});
  await t.db
    .update(s.mailboxes)
    .set({ lastSyncAt: opts.lastSyncAt === undefined ? new Date("2026-09-24T04:25:00Z") : opts.lastSyncAt, credentialsSealed: "sealed" })
    .where(sql`${s.mailboxes.id} = ${mailbox.id}`);
  return { t, db: t.db, orgId: org.id, userId: user.id, mailboxId: mailbox.id };
}

let refSeq = 1000;

export async function addTask(f: Fixture, o: Partial<typeof s.tasks.$inferInsert> = {}) {
  const [row] = await f.db
    .insert(s.tasks)
    .values({
      orgId: f.orgId,
      userId: f.userId,
      mailboxId: f.mailboxId,
      ref: ++refSeq,
      title: "ABC — Αποστολή προσφοράς",
      status: "ACTION_REQUIRED",
      origin: "ai",
      company: "ABC",
      createdAt: new Date("2026-09-10T08:00:00Z"),
      lastActivityAt: new Date("2026-09-23T08:00:00Z"),
      ...o,
    })
    .returning();
  return row!;
}

export async function addMessage(f: Fixture, o: Partial<typeof s.messages.$inferInsert> = {}) {
  const key = `m-${++refSeq}@example.test`;
  const [row] = await f.db
    .insert(s.messages)
    .values({
      mailboxId: f.mailboxId,
      messageKey: key,
      messageIdHeader: key,
      direction: "INBOUND",
      fromAddress: "client@abc-gr.example",
      fromName: "Πελάτης ABC",
      subject: "Προσφορά",
      sortTs: new Date("2026-09-22T07:02:00Z"),
      state: "applied",
      ...o,
    })
    .returning();
  return row!;
}

export async function linkMessage(f: Fixture, taskId: string, messageId: string, threadId: string | null = null) {
  await f.db.insert(s.taskLinks).values({ taskId, messageId, threadId, role: "update" });
}

export interface TransportCall {
  kind: "append" | "smtp";
  settings: MailboxConnectionSettings;
  password: string;
  raw: Buffer;
  messageId?: string;
  envelope?: { from: string; to: string[] };
}

/** In-memory MailTransport: idempotent APPEND by Message-ID (like the real one), optional scripted failures. */
export class FakeTransport implements MailTransport {
  calls: TransportCall[] = [];
  inbox = new Map<string, number>();
  failures: unknown[] = [];
  private uid = 100;

  async appendToInbox(settings: MailboxConnectionSettings, password: string, raw: Buffer, messageIdHeader: string): Promise<AppendResult> {
    this.calls.push({ kind: "append", settings, password, raw, messageId: messageIdHeader });
    const failure = this.failures.shift();
    if (failure) throw failure;
    const known = this.inbox.get(messageIdHeader);
    if (known !== undefined) return { alreadyPresent: true, uid: known, folder: "INBOX" };
    const uid = ++this.uid;
    this.inbox.set(messageIdHeader, uid);
    return { alreadyPresent: false, uid, folder: "INBOX" };
  }

  async sendSmtp(settings: MailboxConnectionSettings, password: string, raw: Buffer, envelope: { from: string; to: string[] }): Promise<{ messageId: string }> {
    this.calls.push({ kind: "smtp", settings, password, raw, envelope });
    const failure = this.failures.shift();
    if (failure) throw failure;
    return { messageId: "smtp-ok" };
  }
}

export interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  obj: object;
  msg?: string;
}

export function memoryLogger(entries: LogEntry[] = []): Logger & { entries: LogEntry[] } {
  const log = {
    entries,
    info: (obj: object, msg?: string) => void entries.push({ level: "info", obj, msg }),
    warn: (obj: object, msg?: string) => void entries.push({ level: "warn", obj, msg }),
    error: (obj: object, msg?: string) => void entries.push({ level: "error", obj, msg }),
    debug: (obj: object, msg?: string) => void entries.push({ level: "debug", obj, msg }),
    child: () => log,
  };
  return log;
}

export function makeDeps(f: Fixture, transport: MailTransport, now: Date = AT_0730, log = memoryLogger()): DigestDeps & { log: ReturnType<typeof memoryLogger> } {
  return {
    db: f.db,
    clock: { now: () => now },
    log,
    transport,
    getPassword: async () => "pw",
    config: { APP_BASE_URL: BASE_URL, PLATFORM_MAIL_DOMAIN: "mailme.test", DEFAULT_TIMEZONE: "Europe/Athens", linkSecret: LINK_SECRET },
  };
}

/** LinkFactory for pure render tests: deterministic URLs under BASE_URL. */
export function fakeLinks(): LinkFactory & { issued: Array<{ taskId: string; action: string }> } {
  const issued: Array<{ taskId: string; action: string }> = [];
  return {
    issued,
    action: async (taskId, action) => {
      issued.push({ taskId, action });
      return `${BASE_URL}/a/tok-${action}-${taskId}`;
    },
    task: (taskId) => `${BASE_URL}/tasks/${taskId}`,
    list: (tab) => `${BASE_URL}/tasks?tab=${tab}`,
  };
}
