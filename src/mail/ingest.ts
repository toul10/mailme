import { createHash } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { recordBounce } from "../engine/bounce.js";
import type { Db, DbOrTx, Tx } from "../db/client.js";
import { digests, mailboxFolders, mailboxes, messageLocations, messages, organizations, tasks, threads, users } from "../db/schema.js";
import type {
  Attachment,
  CalendarInfo,
  Clock,
  Direction,
  FilterReason,
  FolderRole,
  IngestInput,
  IngestResult,
  Logger,
  MessageClass,
  MessageLocationInput,
  MessageState,
  ParsedMail,
  Segment,
} from "../domain/types.js";
import { normalizeRules, type MailRule } from "../domain/rules.js";
import { domainOf, normalizeMessageId, PUBLIC_MAIL_DOMAINS } from "../lib/text.js";
import { decideDirection } from "./direction.js";
import { htmlToPlainText } from "./html.js";
import { parseMime } from "./parse.js";
import { isOwnPlatformMail, prefilter } from "./prefilter.js";
import { redactSensitive } from "./redact.js";
import { segmentBodyDetailed } from "./segment.js";
import { normalizeSubject } from "./subject.js";
import { resolveThread } from "./thread.js";

export interface IngestDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  platformMailDomain: string;
  /** Max age (days) for a message first seen after go-live; older → skipped_old. */
  lateDiscoveryMaxDays: number;
  /** Sender/domain deny-list for the pre-filter (lower-cased addresses or "@domain"). Optional; empty when absent. */
  denyList?: string[];
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** States in which a later copy may still change direction/state (nothing was extracted yet). */
const REPROCESSABLE: ReadonlySet<MessageState> = new Set(["discovered", "pending", "filtered", "skipped_old", "failed"]);
const RESTATEABLE: ReadonlySet<MessageState> = new Set(["discovered", "pending", "filtered", "skipped_old"]);
/** Filter reasons whose bodies are not kept (minimization: personal/spam/drafts/own mail). */
const NO_BODY: ReadonlySet<FilterReason> = new Set(["OWN_MAIL", "DENYLIST", "SPAM_FOLDER", "DRAFT_OR_DELETED"]);

type MessageRow = typeof messages.$inferSelect;

interface MailboxCtx {
  id: string;
  userId: string;
  orgId: string;
  owners: string[];
  backfillFrom: Date | null;
  liveSince: Date | null;
  zone: string;
  /** The owner's "Ignore" list (users.muted_senders). */
  muted: string[];
  /** Domains of the owner addresses (free-mail excluded) + the organization's internal domains (PHISHING rule). */
  ownDomains: string[];
  /** The user's own rules (users.mail_rules), unusable ones skipped. */
  rules: MailRule[];
}

/**
 * Parse → own-mail check → dedup (message_key per mailbox) → locations → direction → sort_ts →
 * segments → prefilter → thread → store. Idempotent: re-ingesting the same copy only adds/updates the location.
 */
export async function ingestMessage(deps: IngestDeps, input: IngestInput): Promise<IngestResult> {
  const seenAt = input.seenAt ?? deps.clock.now();
  const parsed = input.source.kind === "mime" ? await parseMime(input.source.raw) : input.source.parsed;
  const normId = normalizeMessageId(parsed.messageIdHeader);
  const hashKey = contentHashKey(parsed);
  const loc = input.location;

  const result = await deps.db.transaction(async (tx) => {
    const mb = await loadMailbox(tx, input.mailboxId, deps.log);
    if (loc) await assertFolder(tx, mb.id, loc.folderId);

    const known = await isKnownPlatformMessage(tx, mb, normId, loc, deps.platformMailDomain);
    const ownMail = isOwnPlatformMail(known);

    // Dedup. A reused Message-ID with a different sender or a far-apart date is a collision → content key.
    let key = normId ?? hashKey;
    let existing = await findByKey(tx, mb.id, key);
    if (existing && normId && isCollision(existing, parsed)) {
      deps.log.warn({ mailboxId: mb.id, messageId: existing.id }, "message-id collision; using content key");
      key = hashKey;
      existing = await findByKey(tx, mb.id, key);
    }
    if (existing) return onDuplicate(tx, deps, mb, existing, parsed, input);

    const dir = decideDirection({
      from: parsed.from,
      ownerAddresses: mb.owners,
      hasDeliveryTrace: parsed.hasDeliveryTrace,
      folderRole: loc?.folderRole ?? null,
      otherCopyRoles: [],
      declaredOutbound: input.declaredOutbound,
    });
    const internalDate = loc?.internalDate ?? null;
    const sortTs = computeSortTs(dir.direction, parsed.dateHeader, internalDate, seenAt);
    const backfill = mb.liveSince === null || seenAt < mb.liveSince;
    const decision = await classify(tx, deps, mb, parsed, {
      direction: dir.direction,
      claimsOwnerSender: dir.claimsOwnerSender,
      loc,
      ownMail,
      known,
      tooOld: isTooOld(horizonTs(parsed.dateHeader, internalDate, sortTs), seenAt, backfill, mb.backfillFrom, deps.lateDiscoveryMaxDays),
    });
    // Subject, attachment names and calendar text reach the extractor too: stored redacted.
    const meta = redactedMetadata(parsed);

    const inserted = await tx
      .insert(messages)
      .values({
        mailboxId: mb.id,
        messageKey: key,
        messageIdHeader: normId,
        direction: dir.direction,
        fromAddress: parsed.from?.address ?? null,
        fromName: parsed.from?.name ?? null,
        to: parsed.to,
        cc: parsed.cc,
        bcc: parsed.bcc,
        replyTo: parsed.replyTo,
        subject: meta.subject.slice(0, 2000),
        subjectNorm: normalizeSubject(meta.subject),
        dateHeader: parsed.dateHeader,
        internalDate,
        sortTs,
        firstSeenAt: seenAt,
        inReplyTo: normalizeMessageId(parsed.inReplyTo),
        references: parsed.references.map((r) => normalizeMessageId(r)).filter((r): r is string => !!r),
        threadIndex: parsed.threadIndex,
        headers: parsed.headers,
        segments: decision.segments,
        attachments: meta.attachments,
        calendar: meta.calendar,
        bounce: parsed.bounce,
        textPlain: decision.keepBody ? parsed.textPlain : null,
        textHtml: decision.keepBody ? parsed.textHtml : null,
        bodyPurgedAt: decision.keepBody ? null : seenAt,
        sizeBytes: parsed.sizeBytes,
        classification: decision.classification,
        filterReason: decision.filterReason,
        filterRule: decision.filterRule,
        state: decision.state,
        claimsOwnerSender: dir.claimsOwnerSender,
        hasDeliveryTrace: parsed.hasDeliveryTrace,
        decodeWarnings: parsed.decodeWarnings,
        backfill,
        via: input.via,
      })
      .onConflictDoNothing({ target: [messages.mailboxId, messages.messageKey] })
      .returning();
    const row = inserted[0];
    if (!row) {
      // Lost a race with a concurrent ingest of another copy: treat as a duplicate.
      const winner = await findByKey(tx, mb.id, key);
      if (!winner) throw new Error("ingest: conflicting message row vanished");
      return onDuplicate(tx, deps, mb, winner, parsed, input);
    }
    if (loc) await upsertLocation(tx, row.id, loc);

    let threadId: string | null = null;
    if (decision.state !== "own_mail") {
      const t = await resolveThread(tx, mb.id, {
        messageKey: key,
        inReplyTo: row.inReplyTo,
        references: row.references,
        threadIndex: parsed.threadIndex,
        subject: meta.subject,
        participants: participantsOf(parsed),
        sortTs,
      });
      threadId = t.threadId;
      const late = await isLate(tx, threadId, row.id, sortTs);
      await tx.update(messages).set({ threadId, late }).where(eq(messages.id, row.id));
    }
    if (decision.filterReason === "BOUNCE" && parsed.bounce) {
      const b = await recordBounce(tx, mb.id, row.id, parsed.bounce, seenAt);
      if (b.tasksFlagged) deps.log.info({ mailboxId: mb.id, messageId: row.id, tasksFlagged: b.tasksFlagged }, "bounce flagged tasks");
    }
    deps.log.debug({ mailboxId: mb.id, messageId: row.id, state: decision.state, redactions: decision.redactions + meta.redactions, via: input.via }, "ingested");
    return {
      messageId: row.id,
      created: true,
      state: decision.state,
      filterReason: decision.filterReason,
      direction: dir.direction,
      threadId,
    } satisfies IngestResult;
  });
  return result;
}

// ── Classification of one copy ───────────────────────────────────────────────

interface Decision {
  state: MessageState;
  filterReason: FilterReason | null;
  /** filterReason RULE: the user's rule id. */
  filterRule: string | null;
  classification: MessageClass | null;
  segments: Segment[];
  keepBody: boolean;
  redactions: number;
}

async function classify(
  tx: Tx,
  deps: IngestDeps,
  mb: MailboxCtx,
  parsed: ParsedMail,
  o: {
    direction: Direction;
    claimsOwnerSender: boolean;
    loc: MessageLocationInput | null;
    ownMail: boolean;
    known: boolean;
    tooOld: boolean;
    /** Already-stored segments to reuse when the text parts are no longer available. */
    presegmented?: Segment[];
  },
): Promise<Decision> {
  if (o.ownMail) {
    return { state: "own_mail", filterReason: "OWN_MAIL", filterRule: null, classification: "AUTOMATED", segments: [], keepBody: false, redactions: 0 };
  }
  // segmentBody redacts IBAN / card / password patterns before its caps.
  const { segments, redactions } = o.presegmented
    ? { segments: o.presegmented, redactions: 0 }
    : segmentBodyDetailed({ textPlain: parsed.textPlain, textHtml: parsed.textHtml }, { subject: parsed.subject, zone: mb.zone });
  const spamRelevant = o.loc?.folderRole === "junk" || /^\s*yes\b/i.test(parsed.headers["x-spam-flag"] ?? "");
  const pf = prefilter({
    parsed,
    direction: o.direction,
    folderRole: o.loc?.folderRole ?? null,
    flags: o.loc?.flags ?? [],
    platformMailDomain: deps.platformMailDomain,
    isKnownPlatformMessage: o.known,
    denyList: deps.denyList ?? [],
    mutedList: mb.muted,
    rules: mb.rules,
    isKnownContact: spamRelevant && parsed.from ? await isKnownContact(tx, mb.id, parsed.from.address) : false,
    segments,
    ownDomains: mb.ownDomains,
    claimsOwnerSender: o.claimsOwnerSender,
  });
  const keepBody = !(pf.reason && NO_BODY.has(pf.reason));
  const base = { segments: keepBody ? segments : [], keepBody, redactions };
  if (o.tooOld) return { ...base, state: "skipped_old", filterReason: "TOO_OLD", filterRule: null, classification: null };
  if (pf.reason) return { ...base, state: "filtered", filterReason: pf.reason, filterRule: pf.rule ?? null, classification: pf.classification };
  return { ...base, state: "pending", filterReason: null, filterRule: null, classification: null };
}

// ── Duplicate copies ─────────────────────────────────────────────────────────

async function onDuplicate(tx: Tx, deps: IngestDeps, mb: MailboxCtx, existing: MessageRow, parsed: ParsedMail, input: IngestInput): Promise<IngestResult> {
  const loc = input.location;
  if (loc) await upsertLocation(tx, existing.id, loc);
  const patch: Partial<typeof messages.$inferInsert> = {};
  if (!existing.internalDate && loc?.internalDate) patch.internalDate = loc.internalDate;

  let direction = existing.direction as Direction;
  let state = existing.state as MessageState;
  let filterReason = existing.filterReason as FilterReason | null;

  if (state !== "own_mail") {
    const roles = await locationRoles(tx, existing.id);
    const dir = decideDirection({
      from: parsed.from,
      ownerAddresses: mb.owners,
      hasDeliveryTrace: parsed.hasDeliveryTrace,
      folderRole: loc?.folderRole ?? null,
      otherCopyRoles: roles,
      declaredOutbound: input.declaredOutbound,
    });
    // Only INBOUND → OUTBOUND (a later Sent copy); a delivered copy never demotes an outbound message.
    const flip = direction === "INBOUND" && dir.direction === "OUTBOUND";
    // A \Draft / \Deleted copy (or one in Drafts) is never read: it may add metadata (location,
    // direction, sort_ts) but never changes the message's state, and never replaces its stored content.
    const degraded = loc ? loc.folderRole === "drafts" || loc.flags.some((f) => /^\\(draft|deleted)$/i.test(f)) : false;
    const undraft = state === "filtered" && filterReason === "DRAFT_OR_DELETED" && !degraded;

    if (flip && !REPROCESSABLE.has(state)) {
      deps.log.warn({ mailboxId: mb.id, messageId: existing.id, state }, "sent copy arrived after extraction; direction kept");
    } else if (flip || undraft) {
      if (flip) {
        direction = "OUTBOUND";
        patch.direction = "OUTBOUND";
        patch.claimsOwnerSender = false;
        const internal = loc?.folderRole === "sent" && loc.internalDate ? loc.internalDate : (patch.internalDate ?? existing.internalDate);
        patch.sortTs = computeSortTs("OUTBOUND", existing.dateHeader ?? parsed.dateHeader, internal, existing.firstSeenAt);
      }
      if (RESTATEABLE.has(state) && !degraded) {
        const sortTs = patch.sortTs ?? existing.sortTs;
        const known = await isKnownPlatformMessage(tx, mb, existing.messageIdHeader, loc, deps.platformMailDomain);
        // Re-classify with this copy's content, or with the stored content when this copy carries none
        // (a headers-only fetch after a UIDVALIDITY change): a duplicate never erases a stored body.
        const src = contentSource(parsed, existing);
        const d = await classify(tx, deps, mb, src.parsed, {
          direction,
          claimsOwnerSender: patch.claimsOwnerSender ?? existing.claimsOwnerSender,
          loc,
          ownMail: false,
          known,
          tooOld: isTooOld(
            horizonTs(existing.dateHeader ?? parsed.dateHeader, earliest(existing.internalDate, loc?.internalDate ?? null), sortTs),
            existing.firstSeenAt,
            existing.backfill,
            mb.backfillFrom,
            deps.lateDiscoveryMaxDays,
          ),
          presegmented: src.presegmented,
        });
        state = d.state;
        filterReason = d.filterReason;
        Object.assign(patch, {
          state: d.state,
          filterReason: d.filterReason,
          filterRule: d.filterRule,
          classification: d.classification,
          segments: d.segments,
          textPlain: d.keepBody ? src.parsed.textPlain : null,
          textHtml: d.keepBody ? src.parsed.textHtml : null,
          bodyPurgedAt: d.keepBody && !src.presegmented ? null : existing.bodyPurgedAt ?? input.seenAt ?? deps.clock.now(),
        });
        if (src.fromCopy) {
          // The copy's content was used (e.g. the real Sent copy of a message first seen as a draft): take its
          // attachment names / calendar too, without ever emptying what is stored.
          const meta = redactedMetadata(parsed);
          if (meta.attachments.length) patch.attachments = meta.attachments;
          if (meta.calendar) patch.calendar = meta.calendar;
        }
      }
      if (existing.threadId && patch.sortTs) {
        patch.late = await isLate(tx, existing.threadId, existing.id, patch.sortTs);
        await tx
          .update(threads)
          .set({
            firstMessageAt: sql`least(coalesce(${threads.firstMessageAt}, ${patch.sortTs}), ${patch.sortTs})`,
            lastMessageAt: sql`greatest(coalesce(${threads.lastMessageAt}, ${patch.sortTs}), ${patch.sortTs})`,
          })
          .where(eq(threads.id, existing.threadId));
      }
    }
  }

  if (Object.keys(patch).length) {
    patch.updatedAt = new Date();
    await tx.update(messages).set(patch).where(eq(messages.id, existing.id));
  }
  deps.log.debug({ mailboxId: mb.id, messageId: existing.id, state, duplicate: true, via: input.via }, "ingested");
  return { messageId: existing.id, created: false, state, filterReason, direction, threadId: existing.threadId };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loadMailbox(tx: DbOrTx, mailboxId: string, log: IngestDeps["log"]): Promise<MailboxCtx> {
  const [row] = await tx
    .select({
      id: mailboxes.id,
      userId: mailboxes.userId,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      aliases: mailboxes.aliases,
      backfillFrom: mailboxes.backfillFrom,
      liveSince: mailboxes.liveSince,
      zone: organizations.timezone,
      internalDomains: organizations.internalDomains,
      muted: users.mutedSenders,
      mailRules: users.mailRules,
    })
    .from(mailboxes)
    .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(eq(mailboxes.id, mailboxId));
  if (!row) throw new Error(`ingest: unknown mailbox ${mailboxId}`);
  const owners = [...new Set([row.address, ...row.aliases].map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const ownerDomains = owners.map(domainOf).filter((d): d is string => !!d && !PUBLIC_MAIL_DOMAINS.has(d));
  const { rules, skipped } = normalizeRules(row.mailRules);
  if (skipped.length) log.warn({ mailboxId, skipped: skipped.map((r) => r.id) }, "unusable mail rules skipped");
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    owners,
    backfillFrom: row.backfillFrom,
    liveSince: row.liveSince,
    zone: row.zone || "Europe/Athens",
    muted: row.muted ?? [],
    ownDomains: [...new Set([...ownerDomains, ...(row.internalDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)])],
    rules,
  };
}

async function assertFolder(tx: DbOrTx, mailboxId: string, folderId: string): Promise<void> {
  const [f] = await tx.select({ mailboxId: mailboxFolders.mailboxId }).from(mailboxFolders).where(eq(mailboxFolders.id, folderId));
  if (!f || f.mailboxId !== mailboxId) throw new Error("ingest: folder does not belong to mailbox");
}

async function findByKey(tx: DbOrTx, mailboxId: string, key: string): Promise<MessageRow | null> {
  const [row] = await tx.select().from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageKey, key)));
  return row ?? null;
}

function isCollision(existing: MessageRow, parsed: ParsedMail): boolean {
  const a = existing.fromAddress?.toLowerCase() ?? null;
  const b = parsed.from?.address ?? null;
  if (a && b && a !== b) return true;
  if (existing.dateHeader && parsed.dateHeader && Math.abs(existing.dateHeader.getTime() - parsed.dateHeader.getTime()) > 48 * HOUR_MS) return true;
  return false;
}

/** "h:" + sha256(from | date | subject | first 1 KB of body), whitespace-normalized so copies hash alike. */
export function contentHashKey(p: ParsedMail): string {
  const body = (p.textPlain ?? (p.textHtml ? htmlToPlainText(p.textHtml) : "")).replace(/\s+/g, " ").trim().slice(0, 1024);
  const material = [p.from?.address ?? "", p.dateHeader?.toISOString() ?? "", p.subject.replace(/\s+/g, " ").trim(), body].join("|");
  return "h:" + createHash("sha256").update(material, "utf8").digest("hex");
}

async function upsertLocation(tx: DbOrTx, messageId: string, loc: MessageLocationInput): Promise<void> {
  await tx
    .insert(messageLocations)
    .values({ messageId, folderId: loc.folderId, uid: loc.uid, internalDate: loc.internalDate, flags: loc.flags })
    .onConflictDoNothing({ target: [messageLocations.folderId, messageLocations.uid] });
}

async function locationRoles(tx: DbOrTx, messageId: string): Promise<FolderRole[]> {
  const rows = await tx
    .select({ role: mailboxFolders.role })
    .from(messageLocations)
    .innerJoin(mailboxFolders, eq(mailboxFolders.id, messageLocations.folderId))
    .where(eq(messageLocations.messageId, messageId));
  return rows.map((r) => r.role as FolderRole);
}

/**
 * Platform mail recorded in `digests` (the only own-mail signal, headers alone can be forged):
 * - the Message-ID of a report of any user of this organization (a report delivered to, or forwarded into, a
 *   colleague's mailbox is still platform mail); the digest row carries it before the report is sent;
 * - or, for an APPEND into this user's inbox, the recorded APPEND UID together with a platform-domain Message-ID.
 */
async function isKnownPlatformMessage(tx: DbOrTx, mb: MailboxCtx, normId: string | null, loc: MessageLocationInput | null, platformDomain: string): Promise<boolean> {
  if (normId) {
    const byId = await tx
      .select({ id: digests.id })
      .from(digests)
      .innerJoin(users, eq(users.id, digests.userId))
      .where(and(eq(users.orgId, mb.orgId), sql`lower(btrim(${digests.messageIdHeader}, '<> ')) = ${normId.toLowerCase()}`))
      .limit(1);
    if (byId.length) return true;
  }
  const inPlatformDomain = !!normId && normId.toLowerCase().endsWith("@" + platformDomain.trim().toLowerCase());
  if (!loc || loc.folderRole !== "inbox" || !inPlatformDomain) return false;
  const byUid = await tx
    .select({ id: digests.id })
    .from(digests)
    .where(and(eq(digests.userId, mb.userId), eq(digests.appendUid, loc.uid), eq(digests.deliveredVia, "append")))
    .limit(1);
  return byUid.length > 0;
}

/** The owner wrote to this address before (outbound To/Cc) or it is a task counterparty. */
async function isKnownContact(tx: DbOrTx, mailboxId: string, address: string): Promise<boolean> {
  const a = address.trim().toLowerCase();
  if (!a) return false;
  const probe = JSON.stringify([{ address: a }]);
  const sent = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailboxId),
        eq(messages.direction, "OUTBOUND"),
        sql`(${messages.to} @> ${probe}::jsonb or ${messages.cc} @> ${probe}::jsonb)`,
      ),
    )
    .limit(1);
  if (sent.length) return true;
  const t = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.mailboxId, mailboxId), sql`lower(${tasks.counterpartyAddress}) = ${a}`))
    .limit(1);
  return t.length > 0;
}

/** Older than the thread's last applied message → processed with the whole thread in context. */
async function isLate(tx: DbOrTx, threadId: string, messageId: string, sortTs: Date): Promise<boolean> {
  const [row] = await tx
    .select({ last: sql<Date | string | null>`max(${messages.sortTs})` })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.state, "applied"), ne(messages.id, messageId)));
  if (!row?.last) return false;
  const last = row.last instanceof Date ? row.last : new Date(row.last);
  return sortTs.getTime() < last.getTime();
}

/**
 * INBOUND = INTERNALDATE ?? Date; OUTBOUND = Date clamped to [INTERNALDATE − 24 h, INTERNALDATE].
 * Without INTERNALDATE (ingest API / .eml) the Date header is used, never later than the first sighting.
 */
export function computeSortTs(direction: Direction, dateHeader: Date | null, internalDate: Date | null, seenAt: Date): Date {
  const capped = dateHeader && dateHeader.getTime() > seenAt.getTime() ? seenAt : dateHeader;
  if (direction === "INBOUND") return internalDate ?? capped ?? seenAt;
  if (!dateHeader) return internalDate ?? seenAt;
  if (!internalDate) return capped ?? seenAt;
  const lo = internalDate.getTime() - 24 * HOUR_MS;
  const hi = internalDate.getTime();
  return new Date(Math.min(hi, Math.max(lo, dateHeader.getTime())));
}

/**
 * The time the horizon rules judge a message by: the older of its Date header and INTERNALDATE.
 * A copy APPENDed or dragged into a synced folder (Outlook .pst → IMAP, a restore) gets a fresh INTERNALDATE, so
 * the Date header is what shows it is old; an old INTERNALDATE (migrated mailbox) is old too. Without either
 * (ingest API upload without a Date header), the processing time `sortTs`. sort_ts itself is not affected.
 */
export function horizonTs(dateHeader: Date | null, internalDate: Date | null, sortTs: Date): Date {
  return earliest(dateHeader, internalDate) ?? sortTs;
}

/** Horizon rules: before mailbox.backfillFrom, or (after go-live) older than lateDiscoveryMaxDays when first seen. */
export function isTooOld(ts: Date, seenAt: Date, backfill: boolean, backfillFrom: Date | null, lateDiscoveryMaxDays: number): boolean {
  if (backfillFrom && ts.getTime() < backfillFrom.getTime()) return true;
  return !backfill && ts.getTime() < seenAt.getTime() - lateDiscoveryMaxDays * DAY_MS;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/** Subject, attachment names and calendar text as stored (and later sent to the extractor): redacted. */
function redactedMetadata(p: ParsedMail): { subject: string; attachments: Attachment[]; calendar: CalendarInfo | null; redactions: number } {
  let redactions = 0;
  const red = (s: string): string => {
    const r = redactSensitive(s);
    redactions += r.redactions;
    return r.text;
  };
  const redOrNull = (s: string | null): string | null => (s === null ? null : red(s));
  const subject = red(p.subject);
  const attachments = p.attachments.map((a) => {
    const filename = red(a.filename);
    return filename === a.filename ? a : { ...a, filename };
  });
  const calendar = p.calendar ? { ...p.calendar, summary: redOrNull(p.calendar.summary), location: redOrNull(p.calendar.location) } : null;
  return { subject, attachments, calendar, redactions };
}

/** Real content: text, a (non-empty) attachment list or a calendar part. A headers-only fetch has none. */
function hasContent(p: ParsedMail): boolean {
  return !!(p.textPlain?.trim() || p.textHtml?.trim()) || p.attachments.length > 0 || p.calendar !== null;
}

/**
 * What to (re)classify a duplicate copy with: its own content, or — when it carries none (headers-only fetch) and
 * the stored row does — the stored text parts (or stored segments once the text parts are gone).
 */
function contentSource(parsed: ParsedMail, existing: MessageRow): { parsed: ParsedMail; presegmented?: Segment[]; fromCopy: boolean } {
  if (hasContent(parsed)) return { parsed, fromCopy: true };
  const storedText = !!(existing.textPlain?.trim() || existing.textHtml?.trim());
  const storedAny = storedText || existing.segments.length > 0 || existing.attachments.length > 0 || existing.calendar !== null;
  if (!storedAny) return { parsed, fromCopy: true };
  const stored: ParsedMail = {
    ...parsed,
    textPlain: existing.textPlain,
    textHtml: existing.textHtml,
    attachments: existing.attachments,
    calendar: existing.calendar ?? parsed.calendar,
    bounce: existing.bounce ?? parsed.bounce,
    decodeWarnings: [...new Set([...existing.decodeWarnings, ...parsed.decodeWarnings])],
  };
  return { parsed: stored, presegmented: storedText ? undefined : existing.segments, fromCopy: false };
}

function participantsOf(p: ParsedMail): string[] {
  return [p.from, ...p.to, ...p.cc].filter((a): a is NonNullable<typeof a> => !!a).map((a) => a.address);
}
