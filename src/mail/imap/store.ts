import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import * as s from "../../db/schema.js";
import type { Address, Clock, Logger } from "../../domain/types.js";
import { normalizeMessageId } from "../../lib/text.js";
import { redactSensitive } from "../redact.js";
import { normalizeSubject } from "../subject.js";
import { stripMessageId } from "./client.js";
import { computeBackoffMs, type ImapErrorKind, type LoginOutcome } from "./errors.js";
import { classifyFolder, initialSyncEnabled, isSelectableFolder, type ListedFolder } from "./folders.js";

/** DB side of the IMAP layer: login attempts, mailbox connection state, folder list and per-folder progress. */

export type MailboxRow = typeof s.mailboxes.$inferSelect;
export type FolderRow = typeof s.mailboxFolders.$inferSelect;
export type LoginPurpose = (typeof s.mailboxLoginAttempts.$inferInsert)["purpose"];

/** Shown to the owner (MailboxSummary.statusReason) when the server rejects the password. */
export const AUTH_FAILED_REASON =
  "The mail server rejected the sign-in details (wrong username or password). Sync has stopped — enter the password again.";

export async function recordLoginAttempt(db: Db, at: Date, mailboxId: string, purpose: LoginPurpose, outcome: LoginOutcome, detail: string | null = null): Promise<void> {
  await db.insert(s.mailboxLoginAttempts).values({ mailboxId, at, purpose, outcome, detail: detail ? detail.slice(0, 120) : null });
}

/**
 * Callback for `createMailTransport({ onLoginAttempt })` (and the probe) that records the attempt.
 * Fire-and-forget: a failed insert is logged (codes only) and never breaks delivery.
 */
export function loginAttemptRecorder(db: Db, clock: Clock, log?: Logger) {
  return (mailboxId: string, purpose: LoginPurpose, outcome: string, detail?: string): void => {
    const known: LoginOutcome[] = ["ok", "auth_failed", "network", "tls", "too_many", "protocol", "other"];
    const o = (known as string[]).includes(outcome) ? (outcome as LoginOutcome) : "other";
    recordLoginAttempt(db, clock.now(), mailboxId, purpose, o, detail ?? null).catch(() => {
      log?.warn({ mailboxId, code: "login_attempt_record_failed" });
    });
  };
}

export async function loadMailbox(db: Db, mailboxId: string): Promise<MailboxRow | null> {
  const [row] = await db.select().from(s.mailboxes).where(eq(s.mailboxes.id, mailboxId));
  return row ?? null;
}

export async function loadFolders(db: Db, mailboxId: string): Promise<FolderRow[]> {
  return db.select().from(s.mailboxFolders).where(eq(s.mailboxFolders.mailboxId, mailboxId));
}

export async function markLoginOk(db: Db, mailboxId: string, now: Date): Promise<void> {
  await db.update(s.mailboxes).set({ lastLoginAt: now }).where(eq(s.mailboxes.id, mailboxId));
}

/**
 * The connection worked for a whole cycle: clear the failure streak. `lastSyncAt` moves only on a full cycle.
 * `detail` (folder names and error codes, never content) replaces the generic "sync incomplete" text.
 * With `inboxOnly` (a watcher INBOX-only cycle) a clean cycle leaves last_error alone: only a full cycle, which
 * looks at every folder, may clear what a previous full cycle reported about other folders.
 */
export async function markCycleOk(
  db: Db,
  mailboxId: string,
  now: Date,
  fullCycle: boolean,
  incompleteFolders: number,
  detail: string | null = null,
  inboxOnly = false,
  /** Start of the cycle: a full cycle only covers messages first seen before it started (settle window). */
  cycleStartedAt: Date = now,
): Promise<void> {
  const problem = detail ?? (incompleteFolders > 0 ? `sync incomplete: ${incompleteFolders} folder(s)` : null);
  const touchError = problem !== null || !inboxOnly;
  await db
    .update(s.mailboxes)
    .set({
      consecutiveFailures: 0,
      nextAttemptAt: null,
      ...(touchError ? { lastError: problem ? problem.slice(0, 300) : null } : {}),
      ...(problem ? { lastErrorAt: now } : {}),
      ...(fullCycle ? { lastSyncAt: cycleStartedAt } : {}),
    })
    .where(eq(s.mailboxes.id, mailboxId));
}

/** Folder columns reset whenever the folder is covered (synced, or unchanged by STATUS). */
export const FOLDER_OK = { consecutiveFailures: 0, failingSince: null, lastError: null } as const;

/**
 * A command on this folder (EXAMINE / STATUS / SEARCH / FETCH) failed this cycle. `error` is an op + code, never
 * content. Returns the new streak of consecutive failed cycles.
 */
export async function recordFolderFailure(db: Db, folderId: string, now: Date, error: string): Promise<number> {
  const [row] = await db
    .update(s.mailboxFolders)
    .set({
      consecutiveFailures: sql`${s.mailboxFolders.consecutiveFailures} + 1`,
      failingSince: sql`coalesce(${s.mailboxFolders.failingSince}, ${now.toISOString()}::timestamptz)`,
      lastError: error.slice(0, 200),
    })
    .where(eq(s.mailboxFolders.id, folderId))
    .returning({ failures: s.mailboxFolders.consecutiveFailures });
  return row?.failures ?? 1;
}

/**
 * Connection/login failure:
 * - auth → status `auth_failed` + a statusReason for the owner, no automatic retry (a person re-enters the password);
 * - everything else → consecutiveFailures+1 and nextAttemptAt = now + backoff (too_many ≥ 15 min).
 * Returns the scheduled next attempt (null for auth).
 */
export async function markConnectionFailure(
  db: Db,
  mailboxId: string,
  kind: ImapErrorKind | "credentials",
  message: string,
  now: Date,
  random: () => number = Math.random,
): Promise<Date | null> {
  const lastError = `${kind}: ${message}`.slice(0, 300);
  if (kind === "auth") {
    await db
      .update(s.mailboxes)
      .set({ lastError, lastErrorAt: now, nextAttemptAt: null, consecutiveFailures: sql`${s.mailboxes.consecutiveFailures} + 1` })
      .where(eq(s.mailboxes.id, mailboxId));
    // Only an active mailbox flips; a mailbox the user paused/disabled meanwhile keeps its status.
    await db
      .update(s.mailboxes)
      .set({ status: "auth_failed", statusReason: AUTH_FAILED_REASON })
      .where(and(eq(s.mailboxes.id, mailboxId), eq(s.mailboxes.status, "active")));
    return null;
  }
  const [row] = await db
    .update(s.mailboxes)
    .set({ lastError, lastErrorAt: now, consecutiveFailures: sql`${s.mailboxes.consecutiveFailures} + 1` })
    .where(eq(s.mailboxes.id, mailboxId))
    .returning({ failures: s.mailboxes.consecutiveFailures });
  const next = new Date(now.getTime() + computeBackoffMs(kind === "credentials" ? "other" : kind, row?.failures ?? 1, random));
  await db.update(s.mailboxes).set({ nextAttemptAt: next }).where(eq(s.mailboxes.id, mailboxId));
  return next;
}

/**
 * LIST → mailbox_folders:
 * - new folders get the classified role and the default sync selection;
 * - existing folders keep a user-chosen role (role_source = user), their sync/private choice and their sync state;
 * - folders missing from LIST get gone_at (never deleted — renames show up as gone + new); a folder that
 *   reappears is revived with its state intact;
 * - \Noselect / \NonExistent entries are ignored.
 * An empty LIST is refused by the caller (it would mark everything gone).
 */
export async function upsertFolders(db: Db, mailboxId: string, listed: readonly ListedFolder[], now: Date): Promise<{ added: number; updated: number; gone: number }> {
  const existing = await loadFolders(db, mailboxId);
  const byPath = new Map(existing.map((f) => [f.path, f]));
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;

  for (const f of listed) {
    if (!isSelectableFolder(f) || seen.has(f.path)) continue;
    seen.add(f.path);
    const cls = classifyFolder(f);
    const row = byPath.get(f.path);
    if (!row) {
      const inserted = await db
        .insert(s.mailboxFolders)
        .values({
          mailboxId,
          path: f.path,
          name: f.name || f.path,
          delimiter: f.delimiter,
          role: cls.role,
          roleSource: cls.source,
          specialUse: f.specialUse,
          syncEnabled: initialSyncEnabled(f, cls.role),
        })
        .onConflictDoNothing()
        .returning({ id: s.mailboxFolders.id });
      added += inserted.length;
      continue;
    }
    const patch: Partial<typeof s.mailboxFolders.$inferInsert> = {};
    if (row.name !== (f.name || f.path)) patch.name = f.name || f.path;
    if (row.delimiter !== f.delimiter) patch.delimiter = f.delimiter;
    if (row.specialUse !== f.specialUse) patch.specialUse = f.specialUse;
    if (row.goneAt !== null) patch.goneAt = null;
    if (row.roleSource !== "user" && (row.role !== cls.role || row.roleSource !== cls.source)) {
      patch.role = cls.role;
      patch.roleSource = cls.source;
    }
    if (Object.keys(patch).length > 0) {
      await db.update(s.mailboxFolders).set(patch).where(eq(s.mailboxFolders.id, row.id));
      updated++;
    }
  }

  // INBOX never goes (RFC 3501 §5.1), even when a namespace-prefixed LIST leaves it out.
  const goneIds = existing.filter((f) => !seen.has(f.path) && f.goneAt === null && f.path.toUpperCase() !== "INBOX").map((f) => f.id);
  if (goneIds.length > 0) {
    await db.update(s.mailboxFolders).set({ goneAt: now }).where(inArray(s.mailboxFolders.id, goneIds));
  }
  return { added, updated, gone: goneIds.length };
}

/** A folder is synced when enabled, not private and still listed. */
export function isFolderSynced(f: FolderRow): boolean {
  // Virtual folders (\All, \Flagged) only mirror messages that live elsewhere; rows enabled by an older setup stay off.
  const virtual = f.specialUse === "\\All" || f.specialUse === "\\Flagged";
  return f.syncEnabled && !f.private && f.goneAt === null && !virtual;
}

/**
 * UIDVALIDITY changed: every stored UID of the folder is meaningless. Drop its message_locations (the messages
 * stay; UNIQUE(folder, uid) would otherwise collide with the new numbering) and restart it as a first sync.
 */
export async function resetFolderForNewUidValidity(db: Db, folderId: string, uidValidity: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(s.messageLocations).where(eq(s.messageLocations.folderId, folderId));
    await tx
      .update(s.mailboxFolders)
      .set({ uidValidity, uidNext: null, lastSeenUid: 0, firstSyncDone: false })
      .where(eq(s.mailboxFolders.id, folderId));
  });
}

export async function saveFolderProgress(
  db: Db,
  folderId: string,
  patch: Partial<
    Pick<FolderRow, "lastSeenUid" | "uidNext" | "uidValidity" | "firstSyncDone" | "lastSyncedAt" | "consecutiveFailures" | "failingSince" | "lastError">
  >,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await db.update(s.mailboxFolders).set(patch).where(eq(s.mailboxFolders.id, folderId));
}

/**
 * Which of these Message-IDs does the mailbox already have (with content, so a headers-only re-listing is enough)?
 * Candidates are the stripped id as written, lower-cased, and exactly as ingest stores it (normalizeMessageId: local
 * part as written, domain lower-cased — Exchange ids have upper case in both), with and without <>, against
 * message_key and message_id_header. Messages only ever seen as \Draft / \Deleted copies were never read, so they
 * are not "known": their clean copy must be fetched in full. Returns lower-cased stripped ids.
 */
export async function findKnownMessageIds(db: Db, mailboxId: string, rawIds: readonly string[]): Promise<Set<string>> {
  const stripped = [...new Set(rawIds.map((r) => stripMessageId(r)).filter((x) => x.length > 0))];
  const known = new Set<string>();
  for (let i = 0; i < stripped.length; i += 200) {
    const candidates = new Set<string>();
    for (const id of stripped.slice(i, i + 200)) {
      for (const v of [id, id.toLowerCase(), normalizeMessageId(id)]) {
        if (!v) continue;
        candidates.add(v);
        candidates.add(`<${v}>`);
      }
    }
    const list = [...candidates];
    const rows = await db
      .select({ key: s.messages.messageKey, header: s.messages.messageIdHeader, filterReason: s.messages.filterReason })
      .from(s.messages)
      .where(and(eq(s.messages.mailboxId, mailboxId), or(inArray(s.messages.messageKey, list), inArray(s.messages.messageIdHeader, list))));
    for (const r of rows) {
      if (r.filterReason === "DRAFT_OR_DELETED") continue;
      for (const v of [r.key, r.header]) if (v) known.add(stripMessageId(v).toLowerCase());
    }
  }
  return known;
}

/** Envelope data of a message the sync could not ingest (from FETCH ENVELOPE; may be partial). */
export interface PoisonEnvelope {
  subject: string | null;
  from: Address | null;
  to: Address[];
  date: Date | null;
}

/**
 * Durable trace of a message skipped after repeated ingest failures ("nothing disappears"):
 * a minimal `failed` messages row (shown as "Not analysed", counted in the recall denominator) plus its location.
 * No Message-ID is stored, so a later resync never treats the message as known and fetches it in full again.
 */
export async function recordPoisonMessage(
  db: Db,
  p: {
    mailbox: Pick<MailboxRow, "id" | "liveSince">;
    folder: Pick<FolderRow, "id" | "role">;
    uidValidity: number | null;
    uid: number;
    internalDate: Date | null;
    flags: string[];
    size: number;
    envelope: PoisonEnvelope;
    attempts: number;
    now: Date;
  },
): Promise<string> {
  const { mailbox, folder, envelope, now } = p;
  const messageKey = `poison:${folder.id}:${p.uidValidity ?? 0}:${p.uid}`;
  const subject = redactSensitive((envelope.subject ?? "").slice(0, 2000)).text;
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(s.messages)
      .values({
        mailboxId: mailbox.id,
        messageKey,
        messageIdHeader: null,
        direction: folder.role === "sent" ? "OUTBOUND" : "INBOUND",
        fromAddress: envelope.from?.address ?? null,
        fromName: envelope.from?.name ?? null,
        to: envelope.to,
        subject,
        subjectNorm: normalizeSubject(subject),
        dateHeader: envelope.date,
        internalDate: p.internalDate,
        sortTs: p.internalDate ?? now,
        firstSeenAt: now,
        sizeBytes: Math.max(0, Math.min(p.size, 2_147_483_647)),
        state: "failed",
        attempts: p.attempts,
        lastError: "ingest_failed",
        backfill: mailbox.liveSince === null || now.getTime() < mailbox.liveSince.getTime(),
        via: "imap",
      })
      .onConflictDoNothing({ target: [s.messages.mailboxId, s.messages.messageKey] })
      .returning({ id: s.messages.id });
    const id =
      inserted[0]?.id ??
      (await tx.select({ id: s.messages.id }).from(s.messages).where(and(eq(s.messages.mailboxId, mailbox.id), eq(s.messages.messageKey, messageKey))))[0]!.id;
    await tx
      .insert(s.messageLocations)
      .values({ messageId: id, folderId: folder.id, uid: p.uid, internalDate: p.internalDate, flags: p.flags })
      .onConflictDoNothing({ target: [s.messageLocations.folderId, s.messageLocations.uid] });
    return id;
  });
}
