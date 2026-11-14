import type { FetchMessageObject } from "imapflow";
import type { Config } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { Clock, IngestInput, IngestResult, Logger } from "../../domain/types.js";
import { createImapFlowClient, safeLogout, stripMessageId, toSequenceSet, type ImapClientFactory, type ImapClientLike } from "./client.js";
import { classifyImapError, errorCode, ImapOperationError, isFolderCommandFailure, loginOutcomeFor, type ImapErrorKind } from "./errors.js";
import { ensureInbox, toListedFolder } from "./folders.js";
import { fetchLargeMessage } from "./mime-rebuild.js";
import {
  findKnownMessageIds,
  FOLDER_OK,
  isFolderSynced,
  loadFolders,
  loadMailbox,
  markConnectionFailure,
  markCycleOk,
  markLoginOk,
  recordFolderFailure,
  recordLoginAttempt,
  recordPoisonMessage,
  resetFolderForNewUidValidity,
  saveFolderProgress,
  upsertFolders,
  type FolderRow,
  type MailboxRow,
  type PoisonEnvelope,
} from "./store.js";

export interface SyncDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  config: Pick<Config, "BACKFILL_DAYS" | "MAX_FETCH_BYTES" | "FOLDER_POLL_SEC" | "SYNC_INTERVAL_SEC">;
  getPassword(mailbox: { id: string; address: string; credentialsSealed: string | null }): Promise<string>;
  ingest(input: IngestInput): Promise<IngestResult>;
}

export interface SyncReport {
  mailboxId: string;
  ok: boolean;
  errorKind: string | null;
  foldersSynced: number;
  newMessages: number;
  duplicates: number;
  /** true when every sync-enabled folder was covered in this cycle (settle-window input). */
  fullCycle: boolean;
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Optional runtime extras, read off the deps object when present (tests inject a fake IMAP client and
 * compress time). Production callers can ignore them.
 */
export interface SyncExtras {
  /** IMAP connection factory. Default: real imapflow (implicit TLS, verified certificate). */
  imapFactory?: ImapClientFactory;
  /** Jitter source for the backoff. */
  random?: () => number;
  /** Abortable sleep used by the watcher. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export type ImapSyncDeps = SyncDeps & SyncExtras;

/**
 * `SyncReport.errorKind` values: an ImapErrorKind for connection problems, or
 * - `inactive` (status ≠ active: auth_failed / paused / …, no login attempted), `backoff` (nextAttemptAt in the future),
 * - `config` (no IMAP host), `not_found`, `not_imap` (ingest-only mailbox), `credentials` (password unavailable),
 * - `folder` / `ingest` (connection fine, but a folder could not be completed this cycle).
 */
export type SyncErrorKind = ImapErrorKind | "inactive" | "backoff" | "config" | "not_found" | "not_imap" | "credentials" | "folder" | "ingest";

const DAY_MS = 86_400_000;
/** Envelope-level data for every candidate UID (cheap); bodies are fetched afterwards in bounded batches. */
const META_QUERY = { uid: true, flags: true, internalDate: true, size: true, envelope: true } as const;
const META_CHUNK = 500;
const BATCH_MAX_MESSAGES = 25;
/**
 * Consecutive ingest failures of the same (folder, uid) before the sync skips it. The skipped message is recorded
 * as a `failed` messages row ("Not analysed"), never silently dropped.
 */
export const POISON_MAX_ATTEMPTS = 5;
/**
 * Consecutive failed cycles after which a non-INBOX folder no longer holds back the full-cycle watermark (the
 * settle window). It is still tried every cycle, and mailboxes.last_error names it until it recovers.
 */
export const FOLDER_EXCLUDE_AFTER = 3;

interface MessageMeta {
  uid: number;
  size: number;
  flags: string[];
  internalDate: Date | null;
  messageId: string | null;
  envelope: PoisonEnvelope;
}

interface Counters {
  foldersSynced: number;
  newMessages: number;
  duplicates: number;
  folderErrors: number;
  ingestErrors: number;
}

interface CycleCtx {
  deps: ImapSyncDeps;
  client: ImapClientLike;
  mailbox: MailboxRow;
  log: Logger;
  counters: Counters;
  /** Path currently selected on the connection (STATUS is not sent for it). */
  selected: string | null;
  stopped(): boolean;
  /** (folderId:uid) → consecutive ingest failures; enables poison-message skipping. */
  failures: Map<string, number> | null;
}

const newCounters = (): Counters => ({ foldersSynced: 0, newMessages: 0, duplicates: 0, folderErrors: 0, ingestErrors: 0 });

/**
 * Ingest-failure counts per mailbox, shared by the watcher and syncMailboxOnce in this process, so a message that
 * keeps failing is skipped (with its trace) whichever of them keeps retrying it.
 */
const failureMaps = new Map<string, Map<string, number>>();
function failuresFor(mailboxId: string): Map<string, number> {
  let m = failureMaps.get(mailboxId);
  if (!m) {
    m = new Map();
    failureMaps.set(mailboxId, m);
  }
  return m;
}

function toDate(v: Date | string | undefined | null): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNum(v: bigint | number | undefined | null): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** First-sync horizon: `mailbox.backfillFrom`, else now − BACKFILL_DAYS. */
export function syncHorizon(mailbox: Pick<MailboxRow, "backfillFrom">, now: Date, backfillDays: number): Date {
  return mailbox.backfillFrom ?? new Date(now.getTime() - backfillDays * DAY_MS);
}

/**
 * Order within a cycle: INBOX first, then Sent, other folders by path, junk last. A broken user folder can never
 * keep INBOX from being synced (the watcher re-selects INBOX for IDLE after the cycle).
 */
function folderOrder(a: FolderRow, b: FolderRow): number {
  const rank = (f: FolderRow) => (f.role === "inbox" ? 0 : f.role === "sent" ? 1 : f.role === "junk" ? 5 : 2);
  return rank(a) - rank(b) || a.path.localeCompare(b.path);
}

function hasFlag(flags: string[], flag: string): boolean {
  const f = flag.toLowerCase();
  return flags.some((x) => x.toLowerCase() === f);
}

function withHeaderTerminator(headers: Buffer): Buffer {
  const text = headers.toString("latin1").replace(/(\r?\n)+$/, "");
  return Buffer.from(text + "\r\n\r\n", "latin1");
}

function toMeta(m: FetchMessageObject): MessageMeta {
  const env = m.envelope;
  const addr = (a: { address?: string; name?: string } | undefined) =>
    a?.address ? { address: a.address.trim().toLowerCase(), name: a.name?.trim() || null } : null;
  return {
    uid: m.uid,
    size: m.size ?? 0,
    flags: [...(m.flags ?? [])],
    internalDate: toDate(m.internalDate),
    messageId: env?.messageId ?? null,
    envelope: {
      subject: typeof env?.subject === "string" ? env.subject : null,
      from: addr(env?.from?.[0]),
      to: (env?.to ?? []).map(addr).filter((a): a is NonNullable<typeof a> => a !== null),
      date: toDate(env?.date),
    },
  };
}

async function fetchMetas(client: ImapClientLike, range: string): Promise<MessageMeta[]> {
  const rows = await client.fetchAll(range, { ...META_QUERY }, { uid: true });
  return rows.filter((r) => Number.isInteger(r.uid) && r.uid > 0).map(toMeta);
}

async function fetchBuffers(client: ImapClientLike, uids: number[], kind: "source" | "headers"): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>();
  if (uids.length === 0) return out;
  const query = kind === "source" ? { uid: true, source: true } : { uid: true, headers: true };
  for (const m of await client.fetchAll(toSequenceSet(uids), query, { uid: true })) {
    const buf = kind === "source" ? m.source : m.headers;
    if (buf) out.set(m.uid, kind === "headers" ? withHeaderTerminator(buf) : buf);
  }
  return out;
}

type Plan = "headers" | "source" | "large";
type FolderOp = "EXAMINE" | "STATUS" | "SEARCH" | "FETCH";

/**
 * Outcome of one folder in a cycle:
 * - `covered`: everything new was processed (or STATUS showed nothing changed);
 * - `incomplete`: stopped, or an ingest failure left a message for the next cycle (not a folder problem);
 * - `failed`: an IMAP command on the folder failed (tagged NO, folder missing / not permitted); op + code only.
 */
type FolderResult = { status: "covered" } | { status: "incomplete" } | { status: "failed"; op: FolderOp; code: string | null };

/**
 * Sync one folder (EXAMINE → UIDVALIDITY check → SEARCH or UID range → fetch → ingest in UID order).
 * `lastSeenUid` is persisted after each successfully ingested message, so a crash re-ingests at most the
 * message in flight (ingest dedups). Ingest errors are contained. A failed folder command is contained for a
 * non-INBOX folder (`failed`); connection errors, and any error on INBOX, propagate (fatal for the cycle).
 */
async function syncFolder(ctx: CycleCtx, folder: FolderRow): Promise<FolderResult> {
  const step: { op: FolderOp } = { op: "EXAMINE" };
  try {
    return await syncFolderSteps(ctx, folder, step);
  } catch (err) {
    // A failed SELECT/EXAMINE deselects the previous mailbox (RFC 3501 §6.3.1): IDLE must re-open INBOX.
    if (step.op === "EXAMINE") ctx.selected = null;
    if (folder.role === "inbox" || !isFolderCommandFailure(err)) throw err;
    return { status: "failed", op: step.op, code: errorCode(err) };
  }
}

async function syncFolderSteps(ctx: CycleCtx, folder: FolderRow, step: { op: FolderOp }): Promise<FolderResult> {
  const { deps, client, log } = ctx;
  const { db, clock, config } = deps;

  step.op = "EXAMINE";
  const box = await client.mailboxOpen(folder.path, { readOnly: true });
  ctx.selected = folder.path;

  const uidValidity = toNum(box.uidValidity);
  const uidNextAtOpen = toNum(box.uidNext);
  let lastSeen = folder.lastSeenUid;
  let mode: "first" | "incremental" | "resync";

  if (uidValidity !== null && folder.uidValidity !== null && folder.uidValidity !== uidValidity) {
    log.warn({ folderId: folder.id, code: "uidvalidity_changed" });
    await resetFolderForNewUidValidity(db, folder.id, uidValidity);
    lastSeen = 0;
    mode = "resync";
  } else {
    if (uidValidity !== null && folder.uidValidity === null) await saveFolderProgress(db, folder.id, { uidValidity });
    // A folder that completed a sync before (lastSyncedAt) but has firstSyncDone=false is a resync still in progress.
    mode = folder.firstSyncDone ? "incremental" : folder.lastSyncedAt !== null ? "resync" : "first";
  }

  let metas: MessageMeta[] = [];
  if (mode === "incremental") {
    // UIDNEXT tells us whether anything is new; without it, fetch (N:* always returns ≥ 1 message — filtered below).
    step.op = "FETCH";
    if (uidNextAtOpen === null || uidNextAtOpen > lastSeen + 1) metas = await fetchMetas(client, `${lastSeen + 1}:*`);
  } else {
    const h = syncHorizon(ctx.mailbox, clock.now(), config.BACKFILL_DAYS);
    step.op = "SEARCH";
    const found = await client.search({ or: [{ since: h }, { sentSince: h }] }, { uid: true });
    if (!Array.isArray(found)) throw new ImapOperationError("protocol", "SEARCH returned no result", "SEARCH");
    const uids = [...new Set(found)].filter((u) => u > lastSeen).sort((a, b) => a - b);
    step.op = "FETCH";
    for (let i = 0; i < uids.length; i += META_CHUNK) metas.push(...(await fetchMetas(client, toSequenceSet(uids.slice(i, i + META_CHUNK)))));
  }
  // `N:*` with N above the highest UID returns the last message; SEARCH may race with arrivals. Keep only new, once.
  const byUid = new Map<number, MessageMeta>();
  for (const m of metas) if (m.uid > lastSeen) byUid.set(m.uid, m);
  const todo = [...byUid.values()].sort((a, b) => a.uid - b.uid);

  // After a UIDVALIDITY change, messages we already store only need their new location: headers, no body.
  const known =
    mode === "resync" ? await findKnownMessageIds(db, ctx.mailbox.id, todo.map((m) => m.messageId).filter((x): x is string => !!x)) : new Set<string>();
  const planFor = (m: MessageMeta): Plan => {
    // Drafts are never read: \Draft / \Deleted copies go to ingest with headers + flags only.
    if (hasFlag(m.flags, "\\Draft") || hasFlag(m.flags, "\\Deleted")) return "headers";
    // Only with a Message-ID: the fallback dedup key hashes body bytes.
    if (mode === "resync" && m.messageId && known.has(stripMessageId(m.messageId).toLowerCase())) return "headers";
    return m.size > config.MAX_FETCH_BYTES ? "large" : "source";
  };

  const batchBytes = Math.max(config.MAX_FETCH_BYTES, 1024 * 1024) * 2;
  let i = 0;
  while (i < todo.length) {
    const batch: MessageMeta[] = [];
    let bytes = 0;
    while (i < todo.length && batch.length < BATCH_MAX_MESSAGES) {
      const m = todo[i]!;
      const cost = planFor(m) === "source" ? m.size : 0;
      if (batch.length > 0 && bytes + cost > batchBytes) break;
      batch.push(m);
      bytes += cost;
      i++;
    }
    const plans = new Map(batch.map((m) => [m.uid, planFor(m)]));
    const headers = await fetchBuffers(client, batch.filter((m) => plans.get(m.uid) === "headers").map((m) => m.uid), "headers");
    const sources = await fetchBuffers(client, batch.filter((m) => plans.get(m.uid) === "source").map((m) => m.uid), "source");

    for (const m of batch) {
      if (ctx.stopped()) return { status: "incomplete" };
      const plan = plans.get(m.uid)!;
      const raw =
        plan === "headers"
          ? headers.get(m.uid)
          : plan === "source"
            ? sources.get(m.uid)
            : await fetchLargeMessage(client, m.uid, { maxTextBytes: config.MAX_FETCH_BYTES });
      if (!raw) {
        // Expunged between SEARCH/FETCH and now: nothing to ingest.
        lastSeen = m.uid;
        await saveFolderProgress(db, folder.id, { lastSeenUid: lastSeen });
        continue;
      }

      const failKey = `${folder.id}:${m.uid}`;
      try {
        const res = await deps.ingest({
          mailboxId: ctx.mailbox.id,
          source: { kind: "mime", raw },
          location: { folderId: folder.id, folderRole: folder.role, uid: m.uid, internalDate: m.internalDate, flags: m.flags },
          seenAt: clock.now(),
          via: "imap",
        });
        if (res.created) ctx.counters.newMessages++;
        else ctx.counters.duplicates++;
        ctx.failures?.delete(failKey);
      } catch (err) {
        const attempts = (ctx.failures?.get(failKey) ?? 0) + 1;
        if (ctx.failures && attempts >= POISON_MAX_ATTEMPTS) {
          // Never let one message block the folder (and the settle window) forever — but never lose it silently
          // either: a `failed` row ("Not analysed") is written before the UID is passed.
          try {
            await recordPoisonMessage(db, {
              mailbox: ctx.mailbox,
              folder,
              uidValidity: uidValidity ?? folder.uidValidity,
              uid: m.uid,
              internalDate: m.internalDate,
              flags: m.flags,
              size: m.size,
              envelope: m.envelope,
              attempts,
              now: clock.now(),
            });
          } catch (traceErr) {
            // Without the trace the UID is not skipped: it is retried next cycle.
            log.error({ folderId: folder.id, uid: m.uid, attempts, code: "poison_trace_failed", err: errorCode(traceErr) });
            ctx.counters.ingestErrors++;
            return { status: "incomplete" };
          }
          log.error({ folderId: folder.id, uid: m.uid, attempts, code: "ingest_poison_skipped", err: errorCode(err) });
          ctx.failures.delete(failKey);
          lastSeen = m.uid;
          await saveFolderProgress(db, folder.id, { lastSeenUid: lastSeen });
          continue;
        }
        ctx.failures?.set(failKey, attempts);
        log.error({ folderId: folder.id, uid: m.uid, attempts, code: "ingest_failed", err: errorCode(err) });
        ctx.counters.ingestErrors++;
        return { status: "incomplete" };
      }
      lastSeen = m.uid;
      await saveFolderProgress(db, folder.id, { lastSeenUid: lastSeen });
    }
  }

  // Everything below UIDNEXT-at-open was either processed or intentionally out of scope (older than the horizon).
  const finalSeen = uidNextAtOpen !== null ? Math.max(lastSeen, uidNextAtOpen - 1) : lastSeen;
  await saveFolderProgress(db, folder.id, {
    lastSeenUid: finalSeen,
    uidNext: uidNextAtOpen,
    ...(uidValidity !== null ? { uidValidity } : {}),
    firstSyncDone: true,
    lastSyncedAt: clock.now(),
    ...FOLDER_OK,
  });
  log.debug({ folderId: folder.id, mode, fetched: todo.length, code: "folder_synced" });
  return { status: "covered" };
}

/** STATUS says nothing changed since the last completed sync of this folder (or STATUS failed on a non-INBOX folder). */
async function unchangedByStatus(ctx: CycleCtx, folder: FolderRow): Promise<boolean | { failed: string | null }> {
  if (!folder.firstSyncDone || folder.uidNext === null || folder.uidValidity === null) return false;
  if (ctx.selected === folder.path) return false;
  try {
    const st = await ctx.client.status(folder.path, { uidNext: true, uidValidity: true, messages: true });
    return toNum(st.uidNext) === folder.uidNext && toNum(st.uidValidity) === folder.uidValidity;
  } catch (err) {
    if (folder.role === "inbox" || !isFolderCommandFailure(err)) throw err;
    return { failed: errorCode(err) };
  }
}

/**
 * LIST → folder upsert → per enabled folder (INBOX first): STATUS, then sync if changed.
 * A folder command that fails on a non-INBOX folder is recorded on the folder (streak, since, op + code) and the
 * cycle goes on. `full` is true when every folder was covered, except folders failing for ≥ FOLDER_EXCLUDE_AFTER
 * consecutive cycles: those no longer freeze the settle window, and `problem` names them for mailboxes.last_error.
 */
async function runFullCycle(ctx: CycleCtx): Promise<{ full: boolean; problem: string | null }> {
  const { db, clock } = ctx.deps;
  const raw = (await ctx.client.list({ listOnly: true })).map(toListedFolder);
  // An empty LIST is a server fault, never "every folder is gone" (checked before INBOX is added back).
  if (raw.length === 0) throw new ImapOperationError("protocol", "LIST returned no folders", "LIST");
  const listed = ensureInbox(raw);
  await upsertFolders(db, ctx.mailbox.id, listed, clock.now());

  const folders = (await loadFolders(db, ctx.mailbox.id)).filter(isFolderSynced).sort(folderOrder);
  let allCovered = true;
  const excluded: string[] = [];
  for (const folder of folders) {
    if (ctx.stopped()) return { full: false, problem: null };
    const unchanged = await unchangedByStatus(ctx, folder);
    let res: FolderResult;
    if (typeof unchanged === "object") {
      res = { status: "failed", op: "STATUS", code: unchanged.failed };
    } else if (unchanged) {
      ctx.counters.foldersSynced++;
      await saveFolderProgress(db, folder.id, { lastSyncedAt: clock.now(), ...FOLDER_OK });
      continue;
    } else {
      res = await syncFolder(ctx, folder);
    }
    if (res.status === "covered") {
      ctx.counters.foldersSynced++;
      continue;
    }
    if (res.status === "incomplete") {
      allCovered = false;
      continue;
    }
    ctx.counters.folderErrors++;
    const code = res.code ?? "error";
    const streak = await recordFolderFailure(db, folder.id, clock.now(), `${res.op}: ${code}`);
    ctx.log.warn({ folderId: folder.id, code: "folder_sync_failed", op: res.op, err: code, streak });
    if (streak >= FOLDER_EXCLUDE_AFTER) excluded.push(`"${folder.path}" (${res.op} ${code})`);
    else allCovered = false;
  }
  const incomplete = ctx.counters.folderErrors + ctx.counters.ingestErrors;
  const problem = excluded.length
    ? `sync incomplete: ${incomplete} folder(s); failing for ${FOLDER_EXCLUDE_AFTER}+ cycles and left out of the settle check: ${excluded.join(", ")}`
    : null;
  return { full: allCovered && !ctx.stopped(), problem };
}

async function runInboxCycle(ctx: CycleCtx): Promise<void> {
  const inbox = (await loadFolders(ctx.deps.db, ctx.mailbox.id)).find((f) => f.role === "inbox" && isFolderSynced(f));
  if (!inbox) return;
  const res = await syncFolder(ctx, inbox);
  if (res.status === "covered") ctx.counters.foldersSynced++;
}

type Session = { ok: true; client: ImapClientLike } | { ok: false; kind: SyncErrorKind };

/** Why a mailbox must not be contacted right now (no login attempt is made). */
function gate(mb: MailboxRow | null, now: Date): SyncErrorKind | null {
  if (!mb) return "not_found";
  if (mb.provider !== "imap") return "not_imap";
  if (mb.status !== "active") return "inactive";
  if (!mb.imapHost) return "config";
  if (mb.nextAttemptAt && mb.nextAttemptAt.getTime() > now.getTime()) return "backoff";
  return null;
}

/** Password → connect (login) → record the attempt → update the mailbox's connection state. */
async function openSession(deps: ImapSyncDeps, mb: MailboxRow, mode: "short" | "watch", log: Logger): Promise<Session> {
  const { db, clock } = deps;
  let pass: string;
  try {
    pass = await deps.getPassword({ id: mb.id, address: mb.address, credentialsSealed: mb.credentialsSealed });
  } catch (err) {
    log.error({ code: "credentials_unavailable", err: errorCode(err) });
    await markConnectionFailure(db, mb.id, "credentials", "password unavailable", clock.now(), deps.random);
    return { ok: false, kind: "credentials" };
  }
  const factory = deps.imapFactory ?? createImapFlowClient;
  const client = factory({ host: mb.imapHost!, port: mb.imapPort, user: mb.imapUsername || mb.address, pass, mode });
  try {
    await client.connect();
  } catch (err) {
    const c = classifyImapError(err);
    const at = clock.now();
    await recordLoginAttempt(db, at, mb.id, "sync", loginOutcomeFor(c.kind), errorCode(err));
    await markConnectionFailure(db, mb.id, c.kind, c.message, at, deps.random);
    log.warn({ code: "imap_login_failed", kind: c.kind, err: errorCode(err) });
    try {
      client.close();
    } catch {
      // not connected
    }
    return { ok: false, kind: c.kind };
  }
  const at = clock.now();
  await recordLoginAttempt(db, at, mb.id, "sync", "ok", null);
  await markLoginOk(db, mb.id, at);
  return { ok: true, client };
}

function report(mailboxId: string, startedAt: Date, finishedAt: Date, c: Counters, errorKind: SyncErrorKind | null, fullCycle: boolean): SyncReport {
  return {
    mailboxId,
    ok: errorKind === null,
    errorKind,
    foldersSynced: c.foldersSynced,
    newMessages: c.newMessages,
    duplicates: c.duplicates,
    fullCycle,
    startedAt,
    finishedAt,
  };
}

const incompleteKind = (c: Counters): SyncErrorKind | null => (c.ingestErrors > 0 ? "ingest" : c.folderErrors > 0 ? "folder" : null);

/** One full cycle: login → LIST (update folders) → STATUS → fetch new UIDs per enabled folder → ingest → logout. */
export async function syncMailboxOnce(deps: SyncDeps, mailboxId: string): Promise<SyncReport> {
  const d = deps as ImapSyncDeps;
  const { db, clock } = d;
  const log = d.log.child({ mailboxId, component: "imap-sync" });
  const startedAt = clock.now();
  const counters = newCounters();
  const mb = await loadMailbox(db, mailboxId);
  const blocked = gate(mb, startedAt);
  if (blocked || !mb) return report(mailboxId, startedAt, clock.now(), counters, blocked ?? "not_found", false);

  const session = await openSession(d, mb, "short", log);
  if (!session.ok) return report(mailboxId, startedAt, clock.now(), counters, session.kind, false);
  const ctx: CycleCtx = {
    deps: d,
    client: session.client,
    mailbox: mb,
    log,
    counters,
    selected: null,
    stopped: () => false,
    failures: failuresFor(mailboxId),
  };
  try {
    const cycle = await runFullCycle(ctx);
    const incomplete = counters.folderErrors + counters.ingestErrors;
    await markCycleOk(db, mb.id, clock.now(), cycle.full, incomplete, cycle.problem, false, startedAt);
    log.info({ code: "sync_cycle", folders: counters.foldersSynced, created: counters.newMessages, duplicates: counters.duplicates, full: cycle.full });
    return report(mailboxId, startedAt, clock.now(), counters, incompleteKind(counters), cycle.full);
  } catch (err) {
    const c = classifyImapError(err);
    log.warn({ code: "sync_cycle_failed", kind: c.kind, err: errorCode(err) });
    await markConnectionFailure(db, mb.id, c.kind, c.message, clock.now(), d.random);
    return report(mailboxId, startedAt, clock.now(), counters, c.kind, false);
  } finally {
    await safeLogout(session.client);
  }
}

// ── Watcher ──────────────────────────────────────────────────────────────────

/** Statuses on which the watcher exits for good (a person must act); `paused` / `setup` are waited out. */
const TERMINAL_STATUSES = new Set(["auth_failed", "blocked", "disabled"]);
const STOP_GRACE_MS = 15_000;
const LOOP_ERROR_DELAY_MS = 30_000;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Long-lived session: IDLE on INBOX, STATUS-poll other folders every FOLDER_POLL_SEC, one connection per mailbox. */
export function startMailboxWatcher(deps: SyncDeps, mailboxId: string, hooks: { onCycle(report: SyncReport): void | Promise<void> }): { stop(): Promise<void> } {
  const d = deps as ImapSyncDeps;
  const { db, clock, config } = d;
  const sleep = d.sleep ?? defaultSleep;
  const log = d.log.child({ mailboxId, component: "imap-watcher" });
  const stopCtl = new AbortController();
  const failures = failuresFor(mailboxId);
  let stopped = false;
  let active: ImapClientLike | null = null;
  let wakeCtl: AbortController | null = null;

  const wake = () => wakeCtl?.abort();
  /** Sleep until `ms` elapses, `wake()` is called or the watcher stops. */
  const waitFor = async (ms: number) => {
    if (stopped) return;
    const ctl = new AbortController();
    wakeCtl = ctl;
    const onStop = () => ctl.abort();
    stopCtl.signal.addEventListener("abort", onStop, { once: true });
    try {
      await sleep(Math.max(0, ms), ctl.signal);
    } finally {
      stopCtl.signal.removeEventListener("abort", onStop);
      if (wakeCtl === ctl) wakeCtl = null;
    }
  };

  const emit = async (r: SyncReport) => {
    try {
      await hooks.onCycle(r);
    } catch (err) {
      log.error({ code: "on_cycle_failed", err: errorCode(err) });
    }
  };

  const runSession = async (mb: MailboxRow): Promise<"stop" | "retry"> => {
    const startedAt = clock.now();
    const session = await openSession(d, mb, "watch", log);
    if (!session.ok) {
      await emit(report(mailboxId, startedAt, clock.now(), newCounters(), session.kind, false));
      return session.kind === "auth" ? "stop" : "retry";
    }
    const client = session.client;
    active = client;
    let closed = false;
    let inboxDirty = false;
    let inboxPath = "INBOX";
    const onExists = (e: { path: string }) => {
      if (e.path === inboxPath) {
        inboxDirty = true;
        wake();
      }
    };
    const onClose = () => {
      closed = true;
      wake();
    };
    client.on("exists", onExists);
    client.on("close", onClose);
    client.on("error", onClose);

    const ctx: CycleCtx = { deps: d, client, mailbox: mb, log, counters: newCounters(), selected: null, stopped: () => stopped, failures };
    const cycle = async (kind: "full" | "inbox"): Promise<"continue" | "end"> => {
      const fresh = await loadMailbox(db, mailboxId);
      if (!fresh || fresh.status !== "active") return "end";
      ctx.mailbox = fresh;
      ctx.counters = newCounters();
      const started = clock.now();
      let full = false;
      let problem: string | null = null;
      if (kind === "full") ({ full, problem } = await runFullCycle(ctx));
      else await runInboxCycle(ctx);
      if (stopped) return "end";
      const folders = await loadFolders(db, mailboxId);
      inboxPath = folders.find((f) => f.role === "inbox" && f.goneAt === null)?.path ?? "INBOX";
      // Keep INBOX selected (read-only) so auto-IDLE runs on it between cycles.
      if (ctx.selected !== inboxPath) {
        await client.mailboxOpen(inboxPath, { readOnly: true });
        ctx.selected = inboxPath;
      }
      await markCycleOk(db, mailboxId, clock.now(), full, ctx.counters.folderErrors + ctx.counters.ingestErrors, problem, kind === "inbox", started);
      log.info({ code: "watch_cycle", kind, folders: ctx.counters.foldersSynced, created: ctx.counters.newMessages, duplicates: ctx.counters.duplicates, full });
      await emit(report(mailboxId, started, clock.now(), ctx.counters, incompleteKind(ctx.counters), full));
      return "continue";
    };

    try {
      let nextFullAt = 0;
      let nextInboxAt = Number.POSITIVE_INFINITY;
      while (!stopped && !closed) {
        const now = Date.now();
        let step: "continue" | "end" = "continue";
        if (now >= nextFullAt) {
          step = await cycle("full");
          nextFullAt = Date.now() + config.FOLDER_POLL_SEC * 1000;
          nextInboxAt = Date.now() + config.SYNC_INTERVAL_SEC * 1000;
        } else if (inboxDirty || now >= nextInboxAt) {
          inboxDirty = false;
          step = await cycle("inbox");
          nextInboxAt = Date.now() + config.SYNC_INTERVAL_SEC * 1000;
        } else {
          await waitFor(Math.min(nextFullAt, nextInboxAt) - now);
        }
        if (step === "end") return "retry";
      }
      if (stopped) return "stop";
      // The server or the network closed the connection: reconnect after a short backoff.
      await markConnectionFailure(db, mailboxId, "network", "connection closed", clock.now(), d.random);
      log.warn({ code: "imap_connection_closed" });
      return "retry";
    } catch (err) {
      if (stopped) return "stop";
      const c = classifyImapError(err);
      log.warn({ code: "watch_session_failed", kind: c.kind, err: errorCode(err) });
      await markConnectionFailure(db, mailboxId, c.kind, c.message, clock.now(), d.random);
      await emit(report(mailboxId, startedAt, clock.now(), ctx.counters, c.kind, false));
      return c.kind === "auth" ? "stop" : "retry";
    } finally {
      client.off("exists", onExists);
      client.off("close", onClose);
      client.off("error", onClose);
      active = null;
      await safeLogout(client);
    }
  };

  const loop = (async () => {
    while (!stopped) {
      try {
        const mb = await loadMailbox(db, mailboxId);
        if (!mb || mb.provider !== "imap") {
          log.warn({ code: "watcher_exit", reason: mb ? "not_imap" : "not_found" });
          return;
        }
        if (TERMINAL_STATUSES.has(mb.status)) {
          log.warn({ code: "watcher_exit", reason: mb.status });
          return;
        }
        if (mb.status !== "active" || !mb.imapHost) {
          await waitFor(config.SYNC_INTERVAL_SEC * 1000);
          continue;
        }
        const wait = mb.nextAttemptAt ? mb.nextAttemptAt.getTime() - clock.now().getTime() : 0;
        if (wait > 0) {
          await waitFor(wait);
          continue;
        }
        if ((await runSession(mb)) === "stop" && !stopped) {
          log.warn({ code: "watcher_exit", reason: "auth" });
          return;
        }
      } catch (err) {
        log.error({ code: "watcher_loop_error", err: errorCode(err) });
        await waitFor(LOOP_ERROR_DELAY_MS);
      }
    }
  })();

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        stopCtl.abort();
        wake();
      }
      let timer: NodeJS.Timeout | undefined;
      const graceful = await Promise.race([
        loop.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!graceful) {
        // A command is stuck (dead socket): drop the connection so the loop can unwind.
        try {
          active?.close();
        } catch {
          // already closed
        }
        await loop;
      }
    },
  };
}
