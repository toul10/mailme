import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { openDb, type Db, type DbHandle } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import * as s from "../../src/db/schema.js";
import type { Direction, Segment, TaskStatus } from "../../src/domain/types.js";
import { foldForSearch } from "../../src/lib/text.js";

/**
 * Fresh embedded Postgres (PGlite, in-memory) with all migrations applied.
 * Usage:
 *   let t: TestDb; beforeEach(async () => { t = await createTestDb(); }); afterEach(() => t.close());
 */
export interface TestDb extends DbHandle {
  db: Db;
}

/**
 * Migrations run once per test worker into a template; each test gets a fresh copy loaded from the
 * template's data dir (much faster than re-running migrations under parallel load).
 */
let template: Promise<Blob> | null = null;

async function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const handle = await openDb("pglite://memory");
    await runMigrations(handle);
    const client = (handle.db as unknown as { $client: PGlite }).$client;
    const dump = await client.dumpDataDir("none");
    await handle.close();
    return dump;
  })();
  return template;
}

export async function createTestDb(): Promise<TestDb> {
  if (process.env.TEST_PG_URL) return createPgTestDb(process.env.TEST_PG_URL);
  const client = new PGlite({ loadDataDir: await migratedTemplate() });
  await client.waitReady;
  const db = drizzlePglite(client, { schema: s }) as unknown as Db;
  return { db, kind: "pglite", pool: null, close: () => client.close() };
}

/**
 * Real PostgreSQL mode (TEST_PG_URL=postgres://localhost:5432/postgres): one migrated template database per
 * worker process, and a throw-away `CREATE DATABASE … TEMPLATE` copy per test, dropped on close.
 */
let pgTemplate: Promise<string> | null = null;
let pgCounter = 0;

async function adminQuery(adminUrl: string, text: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

function dbUrl(adminUrl: string, name: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

async function createPgTestDb(adminUrl: string): Promise<TestDb> {
  pgTemplate ??= (async () => {
    const name = `mailme_tpl_${process.pid}`;
    await adminQuery(adminUrl, `drop database if exists ${name}`);
    await adminQuery(adminUrl, `create database ${name}`);
    const handle = await openDb(dbUrl(adminUrl, name));
    await runMigrations(handle);
    await handle.close();
    return name;
  })();
  const template = await pgTemplate;
  const name = `mailme_t_${process.pid}_${++pgCounter}`;
  await adminQuery(adminUrl, `create database ${name} template ${template}`);
  const handle = await openDb(dbUrl(adminUrl, name));
  return {
    ...handle,
    close: async () => {
      await handle.close();
      await adminQuery(adminUrl, `drop database if exists ${name}`);
    },
  } as TestDb;
}

let counter = 0;
const next = () => ++counter;

export async function seedOrgUserMailbox(db: Db, opts: { address?: string; aliases?: string[]; name?: string } = {}) {
  const [org] = await db
    .insert(s.organizations)
    .values({ name: "Contoso", internalDomains: ["contoso.example"] })
    .returning();
  const address = opts.address ?? "owner@contoso.example";
  const [user] = await db
    .insert(s.users)
    .values({ orgId: org!.id, name: opts.name ?? "Owner Person", email: address })
    .returning();
  const [mailbox] = await db
    .insert(s.mailboxes)
    .values({
      orgId: org!.id,
      userId: user!.id,
      address,
      aliases: opts.aliases ?? [],
      imapHost: "mail.contoso.example",
      imapUsername: address,
      status: "active",
      backfillFrom: new Date("2026-08-01T00:00:00Z"),
      liveSince: new Date("2026-09-01T00:00:00Z"),
    })
    .returning();
  return { org: org!, user: user!, mailbox: mailbox! };
}

export async function insertFolder(db: Db, mailboxId: string, path: string, role: (typeof s.mailboxFolders.$inferInsert)["role"]) {
  const [f] = await db
    .insert(s.mailboxFolders)
    .values({ mailboxId, path, name: path, role, syncEnabled: true })
    .returning();
  return f!;
}

export async function insertThread(db: Db, mailboxId: string, subjectNorm = "προσφορα abc") {
  const [t] = await db.insert(s.threads).values({ mailboxId, subjectNorm }).returning();
  return t!;
}

export interface MessageSeed {
  mailboxId: string;
  threadId?: string | null;
  direction?: Direction;
  from?: string;
  fromName?: string | null;
  to?: string[];
  cc?: string[];
  subject?: string;
  sortTs?: Date;
  text?: string;
  segments?: Segment[];
  attachments?: Array<{ filename: string; contentType?: string }>;
  state?: (typeof s.messages.$inferInsert)["state"];
  messageIdHeader?: string;
  inReplyTo?: string | null;
  references?: string[];
  /** First seen before the mailbox went live (messages.backfill). */
  backfill?: boolean;
}

export async function insertMessage(db: Db, m: MessageSeed) {
  const n = next();
  const text = m.text ?? "Καλημέρα, μπορείτε να μου στείλετε την προσφορά;";
  const msgId = m.messageIdHeader ?? `msg-${n}@example.test`;
  const [row] = await db
    .insert(s.messages)
    .values({
      mailboxId: m.mailboxId,
      threadId: m.threadId ?? null,
      messageKey: msgId,
      messageIdHeader: msgId,
      direction: m.direction ?? "INBOUND",
      fromAddress: m.from ?? "client@abc-gr.example",
      fromName: m.fromName ?? "Πελάτης ABC",
      to: (m.to ?? ["owner@contoso.example"]).map((address) => ({ address, name: null })),
      cc: (m.cc ?? []).map((address) => ({ address, name: null })),
      subject: m.subject ?? "Προσφορά",
      subjectNorm: foldForSearch(m.subject ?? "Προσφορά"),
      sortTs: m.sortTs ?? new Date("2026-09-10T08:00:00Z"),
      dateHeader: m.sortTs ?? new Date("2026-09-10T08:00:00Z"),
      internalDate: m.sortTs ?? new Date("2026-09-10T08:00:00Z"),
      firstSeenAt: m.sortTs ?? new Date("2026-09-10T08:00:00Z"),
      inReplyTo: m.inReplyTo ?? null,
      references: m.references ?? [],
      segments: m.segments ?? [{ id: "S1", kind: "NEW", text, author: null, date: null, truncated: false }],
      attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType ?? "application/pdf", size: 1000, inline: false })),
      textPlain: text,
      state: m.state ?? "pending",
      backfill: m.backfill ?? false,
    })
    .returning();
  return row!;
}

export interface TaskSeed {
  orgId: string;
  userId: string;
  mailboxId: string;
  title?: string;
  status?: TaskStatus;
  counterparty?: string | null;
  company?: string | null;
  dueDate?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  closedBy?: "ai" | "user" | null;
}

export async function insertTask(db: Db, t: TaskSeed) {
  const title = t.title ?? "ABC — Αποστολή προσφοράς";
  const [{ max } = { max: 0 }] = (await db.execute(sql`select coalesce(max(ref),0)::int as max from tasks where user_id = ${t.userId}`)).rows as Array<{ max: number }>;
  const [row] = await db
    .insert(s.tasks)
    .values({
      orgId: t.orgId,
      userId: t.userId,
      mailboxId: t.mailboxId,
      ref: Number(max) + 1,
      title,
      status: t.status ?? "ACTION_REQUIRED",
      counterpartyAddress: t.counterparty ?? "client@abc-gr.example",
      company: t.company ?? "ABC",
      companyDomain: "abc-gr.example",
      dueDate: t.dueDate ?? null,
      origin: "ai",
      originMessageId: t.messageId ?? null,
      closedBy: t.closedBy ?? null,
      closedAt: t.status === "COMPLETED" || t.status === "DISMISSED" ? new Date("2026-09-12T08:00:00Z") : null,
      searchText: foldForSearch(`${title} ${t.company ?? "ABC"} ${t.counterparty ?? "client@abc-gr.example"}`),
    })
    .returning();
  if (t.threadId || t.messageId) {
    await db.insert(s.taskLinks).values({ taskId: row!.id, threadId: t.threadId ?? null, messageId: t.messageId ?? null, role: "origin" });
  }
  return row!;
}
