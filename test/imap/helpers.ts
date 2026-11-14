import { eq, sql } from "drizzle-orm";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import * as s from "../../src/db/schema.js";
import type { Clock, IngestInput, IngestResult } from "../../src/domain/types.js";
import { nullLogger } from "../../src/lib/log.js";
import type { ImapSyncDeps } from "../../src/mail/imap/sync.js";
import { FakeImapServer } from "./fake-imap.js";

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Records ingest calls; dedups by Message-ID like the real ingest; can be told to fail for given UIDs. */
export class FakeIngest {
  readonly inputs: IngestInput[] = [];
  private readonly keys = new Set<string>();
  /** uid → number of upcoming failures */
  readonly failUids = new Map<number, number>();

  fn = async (input: IngestInput): Promise<IngestResult> => {
    this.inputs.push(input);
    const uid = input.location?.uid;
    const left = uid !== undefined ? this.failUids.get(uid) : undefined;
    if (left !== undefined && left > 0) {
      this.failUids.set(uid!, left - 1);
      throw new Error("ingest exploded");
    }
    const raw = input.source.kind === "mime" ? input.source.raw.toString("latin1") : "";
    const id = /^message-id:[ \t]*<?([^>\r\n]+)>?/im.exec(raw)?.[1] ?? `nokey-${this.inputs.length}`;
    const created = !this.keys.has(id);
    this.keys.add(id);
    return { messageId: `db-${id}`, created, state: "pending", filterReason: null, direction: "INBOUND", threadId: null };
  };

  uidsFor(folderId: string): number[] {
    return this.inputs.filter((i) => i.location?.folderId === folderId).map((i) => i.location!.uid);
  }
}

export const NOW = new Date("2026-09-24T08:00:00Z");

export interface Env {
  t: TestDb;
  mailboxId: string;
  server: FakeImapServer;
  clock: FakeClock;
  ingest: FakeIngest;
  deps: ImapSyncDeps;
}

/**
 * Seeded active mailbox (backfillFrom 2026-08-01) + fake IMAP server with a Dovecot/Plesk-like tree.
 * Pass a shared PGlite db (created once per file) to reuse it: its data is truncated first.
 */
export async function setupEnv(shared?: TestDb): Promise<Env> {
  const t = shared ?? (await createTestDb());
  if (shared) await t.db.execute(sql`truncate table organizations cascade`);
  const { mailbox } = await seedOrgUserMailbox(t.db);
  const server = new FakeImapServer();
  server.addFolder("INBOX", { flags: ["\\HasChildren"] });
  server.addFolder("INBOX.Sent", { flags: ["\\HasNoChildren", "\\Sent"], specialUse: "\\Sent", uidValidity: 2000 });
  server.addFolder("INBOX.Drafts", { flags: ["\\HasNoChildren", "\\Drafts"], specialUse: "\\Drafts", uidValidity: 3000 });
  server.addFolder("INBOX.Trash", { flags: ["\\HasNoChildren", "\\Trash"], specialUse: "\\Trash", uidValidity: 4000 });
  server.addFolder("INBOX.spam", { flags: ["\\HasNoChildren"], uidValidity: 5000 });
  server.addFolder("INBOX.Πελάτες", { flags: ["\\HasNoChildren"], uidValidity: 6000 });
  const clock = new FakeClock(NOW.getTime());
  const ingest = new FakeIngest();
  const deps: ImapSyncDeps = {
    db: t.db,
    clock,
    log: nullLogger,
    config: { BACKFILL_DAYS: 21, MAX_FETCH_BYTES: 5 * 1024 * 1024, FOLDER_POLL_SEC: 300, SYNC_INTERVAL_SEC: 120 },
    getPassword: async () => "s3cret",
    ingest: ingest.fn,
    imapFactory: server.factory,
    random: () => 0.5,
  };
  return { t, mailboxId: mailbox.id, server, clock, ingest, deps };
}

export async function folderByPath(env: Env, path: string) {
  const rows = await env.t.db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, env.mailboxId));
  const f = rows.find((r) => r.path === path);
  if (!f) throw new Error(`no folder ${path}`);
  return f;
}

export async function mailboxRow(env: Env) {
  const [m] = await env.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, env.mailboxId));
  return m!;
}

export async function loginAttempts(env: Env) {
  return env.t.db.select().from(s.mailboxLoginAttempts).where(eq(s.mailboxLoginAttempts.mailboxId, env.mailboxId));
}
