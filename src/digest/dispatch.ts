import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, isNull, lte, min, ne, notInArray, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { appState, digests, mailboxes, organizations, tasks, users } from "../db/schema.js";
import type { Clock, Logger, MailboxConnectionSettings, MailTransport } from "../domain/types.js";
import { classifyImapError } from "../mail/imap/errors.js";
import { buildDigestModel, sectionTaskIds } from "./build.js";
import { holidayCalendar, isBusinessDayWith, localDateOf, localInstant, parseHhmm, safeZone, type HolidayFn } from "./calendar.js";
import { createLinkFactory, createPreviewLinkFactory } from "./links.js";
import { composeDigestMime, digestMessageId } from "./mime.js";
import { renderDigest } from "./render.js";

export interface DigestDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  transport: MailTransport;
  getPassword(mailbox: { id: string; address: string; credentialsSealed: string | null }): Promise<string>;
  config: Pick<Config, "APP_BASE_URL" | "PLATFORM_MAIL_DOMAIN" | "DEFAULT_TIMEZONE"> & { linkSecret: string };
}

export interface DispatchReport {
  considered: number;
  delivered: number;
  failed: number;
  skipped: number;
}

export const DEFAULT_DIGEST_TIME = "07:30";
/** Catch-up window: a missed report is still sent until this local time. */
export const CATCHUP_UNTIL = "11:00";
/** …but never less than this long after the digest time (a 10:59 digest time still gets a real window). */
export const MIN_CATCHUP_MINUTES = 90;
/** For a digest time at/after CATCHUP_UNTIL, the window is this long instead. */
export const CATCHUP_WINDOW_MINUTES = 210;
/** Sent more than this after the digest time → "Sent late". */
export const LATE_AFTER_MINUTES = 30;
/**
 * Wait before retrying a failed delivery (by attempt number; the last value repeats). Retries go on until the
 * catch-up deadline; an authentication failure marks the mailbox auth_failed, so later retries fail fast
 * without logging in again.
 */
export const RETRY_BACKOFF_MINUTES = [1, 2, 5, 10, 15] as const;
/** "Too many connections": wait ≥ 15 min, whatever the attempt number (same floor as the sync backoff). */
export const TOO_MANY_RETRY_MINUTES = 15;

/**
 * Cross-process claim of a (user, date) report: an app_state row `digest_lease:<user>:<date>` holding
 * { owner, kind, until }. The worker's dispatcher and `pnpm cli digest:send-now` (another process) both take it
 * before touching the row, so they never deliver the same report concurrently. `delivering` leases expire after
 * DELIVERY_LEASE_MS (a crashed holder); after a failure the lease becomes a `backoff` timer until the next retry
 * (it survives a worker restart; a manual send-now may override it, never a live delivery).
 */
export const DIGEST_LEASE_PREFIX = "digest_lease:";
export const DELIVERY_LEASE_MS = 10 * 60_000;

/**
 * digests.last_error markers of an SMTP delivery (SMTP has no Message-ID search, unlike APPEND):
 * - in flight: set durably before the submission. A row found `pending`/`rendered` with it was interrupted
 *   (crash, lost database) at an unknown point → marked failed with SMTP_UNKNOWN and never resent automatically.
 * - sent: the submission succeeded but its bookkeeping failed → the next dispatch finishes the bookkeeping, no resend.
 * - unknown: terminal; `digest:send-now --retry` (after checking the inbox) is the only way to send it again.
 */
export const SMTP_IN_FLIGHT = "smtp_in_flight";
export const SMTP_SENT = "smtp_sent";
export const SMTP_UNKNOWN = "smtp_unknown";
/** Bookkeeping after a successful send is retried this many times (delays in ms) before giving up for this tick. */
const RECORD_RETRY_DELAYS_MS = [200, 800] as const;

export type DueDecision =
  | { kind: "not_due"; localDate: string; reason: "non_business_day" | "before_start" | "before_time" }
  | { kind: "send"; localDate: string; late: boolean }
  | { kind: "too_late"; localDate: string };

/** Pure: is a user's report due at `now` (org zone, business days, start date, digest time, catch-up window)? */
export function decideDue(now: Date, zone: string, digestTime: string | null, startDate: string | null, holidays: HolidayFn): DueDecision {
  const localDate = localDateOf(now, zone);
  if (!isBusinessDayWith(localDate, holidays)) return { kind: "not_due", localDate, reason: "non_business_day" };
  if (startDate && localDate < startDate) return { kind: "not_due", localDate, reason: "before_start" };
  const dueAt = localInstant(localDate, parseHhmm(digestTime) ?? DEFAULT_DIGEST_TIME, zone);
  if (now.getTime() < dueAt.getTime()) return { kind: "not_due", localDate, reason: "before_time" };
  const cutoff = localInstant(localDate, CATCHUP_UNTIL, zone);
  const deadline =
    dueAt.getTime() < cutoff.getTime()
      ? Math.max(cutoff.getTime(), dueAt.getTime() + MIN_CATCHUP_MINUTES * 60_000)
      : dueAt.getTime() + CATCHUP_WINDOW_MINUTES * 60_000;
  if (now.getTime() >= deadline) return { kind: "too_late", localDate };
  return { kind: "send", localDate, late: now.getTime() - dueAt.getTime() > LATE_AFTER_MINUTES * 60_000 };
}

/**
 * The first local date a user's report may go out: users.digest_start_date when set; otherwise, while every
 * (non-disabled) mailbox of the user is still in its shadow week, the local date of the earliest go-live
 * (mailboxes.live_since). “Week 1, shadow: no report” — and the first delivered report is the go-live one.
 */
export function effectiveDigestStart(startDate: string | null, shadow: { firstLiveSince: Date | null; anyLive: boolean } | undefined, zone: string): string | null {
  if (startDate) return startDate;
  if (!shadow || shadow.anyLive || !shadow.firstLiveSince) return null;
  return localDateOf(shadow.firstLiveSince, zone);
}

/** Per user: earliest live_since of the non-disabled mailboxes, and whether one of them has none (live from the start). */
export async function loadShadowWeeks(db: Db, userIds?: string[]): Promise<Map<string, { firstLiveSince: Date | null; anyLive: boolean }>> {
  const rows = await db
    .select({
      userId: mailboxes.userId,
      firstLiveSince: min(mailboxes.liveSince),
      anyLive: sql<boolean>`bool_or(${mailboxes.liveSince} is null)`,
    })
    .from(mailboxes)
    .where(and(ne(mailboxes.status, "disabled"), userIds ? inArray(mailboxes.userId, userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]) : undefined))
    .groupBy(mailboxes.userId);
  return new Map(rows.map((r) => [r.userId, { firstLiveSince: r.firstLiveSince ? new Date(r.firstLiveSince) : null, anyLive: r.anyLive === true }]));
}

interface DigestUser {
  id: string;
  name: string;
  email: string;
  digestTime: string;
  digestDelivery: "append" | "smtp";
  digestMailboxId: string | null;
  digestStartDate: string | null;
  timezone: string;
  holySpirit: boolean;
}

const userColumns = {
  id: users.id,
  name: users.name,
  email: users.email,
  digestTime: users.digestTime,
  digestDelivery: users.digestDelivery,
  digestMailboxId: users.digestMailboxId,
  digestStartDate: users.digestStartDate,
  timezone: organizations.timezone,
  holySpirit: organizations.holySpiritHoliday,
};

/** A delivery failure with a short, content-free code. */
export class DigestDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Mode = "scheduled" | "manual";

export type RunStatus = "delivered" | "already_delivered" | "failed" | "skipped" | "busy" | "smtp_unknown";

interface RunResult {
  status: RunStatus;
  digestId: string | null;
  html: string;
  subject: string;
}

/** A failed attempt also says when the next one may start (kept as the lease's backoff timer). */
type AttemptResult = RunResult & { retryAt?: Date };

type DigestRow = typeof digests.$inferSelect;

/** What a delivered row records: the content that went out (or is in the inbox). */
interface DeliveredContent {
  subject: string | null;
  html: string | null;
  text: string | null;
  sections: Record<string, string[]>;
  renderedAt: Date;
}

const BUSY: RunResult = { status: "busy", digestId: null, html: "", subject: "" };

// ── Lease ────────────────────────────────────────────────────────────────────

const leaseKey = (userId: string, localDate: string) => `${DIGEST_LEASE_PREFIX}${userId}:${localDate}`;

/** Take the (user, date) lease if it is free, expired, or (manual only) just a retry timer. One atomic statement. */
async function acquireLease(db: Db, key: string, owner: string, now: Date, mode: Mode): Promise<boolean> {
  const value = { owner, kind: "delivering", until: new Date(now.getTime() + DELIVERY_LEASE_MS).toISOString() };
  const expired = sql`(${appState.value} ->> 'until')::timestamptz <= ${now.toISOString()}::timestamptz`;
  const rows = await db
    .insert(appState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value, updatedAt: now },
      setWhere: mode === "manual" ? sql`(${expired} or ${appState.value} ->> 'kind' = 'backoff')` : expired,
    })
    .returning({ key: appState.key });
  return rows.length > 0;
}

/** Give the lease back; after a failure keep it as the retry timer until `retryAt`. Only the owner's lease is touched. */
async function releaseLease(db: Db, key: string, owner: string, now: Date, retryAt: Date | null): Promise<void> {
  const own = and(eq(appState.key, key), sql`${appState.value} ->> 'owner' = ${owner}`);
  if (retryAt) {
    await db.update(appState).set({ value: { owner, kind: "backoff", until: retryAt.toISOString() }, updatedAt: now }).where(own);
  } else {
    await db.delete(appState).where(own);
  }
}

// ── Claim ────────────────────────────────────────────────────────────────────

/** Nothing to deliver for this row (delivered; skipped when scheduled; SMTP outcome unknown). */
function finished(row: DigestRow | undefined, mode: Mode): RunResult | null {
  if (!row) return null;
  if (row.status === "delivered") return { status: "already_delivered", digestId: row.id, html: row.html ?? "", subject: row.subject ?? "" };
  if (row.status === "skipped" && mode === "scheduled") return { status: "skipped", digestId: row.id, html: row.html ?? "", subject: row.subject ?? "" };
  if (row.status === "failed" && row.lastError === SMTP_UNKNOWN) return { status: "smtp_unknown", digestId: row.id, html: "", subject: "" };
  return null;
}

type Claim =
  | { kind: "deliver"; row: DigestRow }
  | { kind: "finalize"; row: DigestRow }
  | { kind: "done"; result: RunResult };

const isOpenRow = (r: DigestRow) => r.status === "pending" || r.status === "rendered";

/** A row an interrupted SMTP delivery left behind: to be finished or marked, never (re)sent. */
const isSmtpInterrupted = (r: DigestRow | undefined) => !!r && isOpenRow(r) && (r.lastError === SMTP_SENT || r.lastError === SMTP_IN_FLIGHT);

/**
 * Under the lease: insert the (user, date) row, or take over a failed / abandoned one. `settleOnly` (past the catch-up
 * deadline): only finish / mark an interrupted SMTP delivery, never start one.
 */
async function claim(deps: DigestDeps, user: DigestUser, localDate: string, late: boolean, mode: Mode, settleOnly = false): Promise<Claim> {
  const { db, log } = deps;
  const messageIdHeader = digestMessageId(user.id, localDate, deps.config.PLATFORM_MAIL_DOMAIN);
  if (!settleOnly) {
    const inserted = await db
      .insert(digests)
      .values({ userId: user.id, localDate, status: "pending", late, attempts: 1, messageIdHeader })
      .onConflictDoNothing({ target: [digests.userId, digests.localDate] })
      .returning();
    if (inserted[0]) return { kind: "deliver", row: inserted[0] };
  }

  const [existing] = await db.select().from(digests).where(and(eq(digests.userId, user.id), eq(digests.localDate, localDate)));
  if (settleOnly && !isSmtpInterrupted(existing)) return { kind: "done", result: BUSY };
  if (!existing) return { kind: "done", result: BUSY };
  const done = finished(existing, mode);
  if (done) return { kind: "done", result: done };

  // An earlier holder's SMTP submission succeeded but its bookkeeping did not: finish it, never resend.
  if (isOpenRow(existing) && existing.lastError === SMTP_SENT) return { kind: "finalize", row: existing };
  // An earlier holder was interrupted around its SMTP submission: it may have been sent. At most once — no resend.
  if (isOpenRow(existing) && existing.lastError === SMTP_IN_FLIGHT) {
    const [marked] = await db
      .update(digests)
      .set({ status: "failed", lastError: SMTP_UNKNOWN })
      .where(and(eq(digests.id, existing.id), eq(digests.status, existing.status), eq(digests.lastError, SMTP_IN_FLIGHT)))
      .returning({ id: digests.id });
    if (marked) {
      log.error({ userId: user.id, digestId: existing.id, code: SMTP_UNKNOWN }, "digest SMTP submission was interrupted; it may have been sent — not resending (digest:send-now --retry after checking the inbox)");
      return { kind: "done", result: { status: "failed", digestId: existing.id, html: "", subject: "" } };
    }
    return { kind: "done", result: BUSY };
  }

  // failed, skipped (manual), or pending/rendered left behind by a holder whose lease expired.
  const [taken] = await db
    .update(digests)
    .set({ status: "pending", attempts: sql`${digests.attempts} + 1`, late, messageIdHeader })
    .where(and(eq(digests.id, existing.id), eq(digests.status, existing.status), eq(digests.attempts, existing.attempts)))
    .returning();
  return taken ? { kind: "deliver", row: taken } : { kind: "done", result: BUSY };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

async function deliveryMailbox(db: Db, user: DigestUser) {
  const cols = {
    id: mailboxes.id,
    address: mailboxes.address,
    provider: mailboxes.provider,
    status: mailboxes.status,
    imapHost: mailboxes.imapHost,
    imapPort: mailboxes.imapPort,
    imapUsername: mailboxes.imapUsername,
    smtpHost: mailboxes.smtpHost,
    smtpPort: mailboxes.smtpPort,
    credentialsSealed: mailboxes.credentialsSealed,
  };
  if (user.digestMailboxId) {
    const [mb] = await db.select(cols).from(mailboxes).where(and(eq(mailboxes.id, user.digestMailboxId), eq(mailboxes.userId, user.id)));
    return mb ?? null;
  }
  // First active IMAP mailbox; else the first other non-disabled one, so the failure names its status (e.g. auth_failed).
  const [mb] = await db
    .select(cols)
    .from(mailboxes)
    .where(and(eq(mailboxes.userId, user.id), eq(mailboxes.provider, "imap"), ne(mailboxes.status, "disabled"), isNotNull(mailboxes.imapHost)))
    .orderBy(sql`(${mailboxes.status} = 'active') desc`, asc(mailboxes.createdAt), asc(mailboxes.id))
    .limit(1);
  return mb ?? null;
}

function isAuthError(err: unknown): boolean {
  if (err instanceof DigestDeliveryError) return false;
  try {
    if (classifyImapError(err).kind === "auth") return true;
  } catch {
    // classifier unavailable → heuristics below
  }
  const e = (err ?? {}) as { authenticationFailed?: unknown; code?: unknown; responseCode?: unknown; message?: unknown };
  if (e.authenticationFailed === true || e.code === "EAUTH" || e.responseCode === 535) return true;
  return typeof e.message === "string" && /AUTHENTICATIONFAILED|authentication failed|invalid credentials/i.test(e.message);
}

function isTooManyConnections(err: unknown): boolean {
  if (err instanceof DigestDeliveryError) return false;
  try {
    return classifyImapError(err).kind === "too_many";
  } catch {
    return false;
  }
}

/** Short error code for logs and digests.last_error (never message content or addresses). */
function errorCode(err: unknown): string {
  if (err instanceof DigestDeliveryError) return err.code;
  const e = (err ?? {}) as { code?: unknown; name?: unknown };
  const code = typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(e.code) ? e.code : null;
  const name = typeof e.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.name) ? e.name : "Error";
  return isAuthError(err) ? `auth${code ? `:${code}` : ""}` : `${name}${code ? `:${code}` : ""}`;
}

/** Wait before the next attempt: by attempt number, but ≥ 15 min after "too many connections". */
function retryDelayMs(err: unknown, attempts: number): number {
  const table = RETRY_BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MINUTES.length) - 1]!;
  return (isTooManyConnections(err) ? Math.max(table, TOO_MANY_RETRY_MINUTES) : table) * 60_000;
}

/** The content the previous attempt stored right before its transport call (what an earlier APPEND may have left in the inbox). */
function storedContent(row: DigestRow): DeliveredContent | null {
  if (row.html === null || row.sections === null) return null;
  return { subject: row.subject, html: row.html, text: row.text, sections: row.sections, renderedAt: row.renderedAt ?? row.createdAt };
}

interface Sent {
  via: "append" | "smtp";
  appendUid: number | null;
  content: DeliveredContent;
}

/** Build → render → store → deliver one claimed row; bookkeeping (reported tasks) only after a successful send. */
async function deliverClaimed(deps: DigestDeps, user: DigestUser, row: DigestRow, now: Date, late: boolean): Promise<AttemptResult> {
  const { db, log } = deps;
  const previous = storedContent(row);
  let mailboxId: string | null = null;
  let sent: Sent;
  try {
    // Check the delivery mailbox first: a retry against an unusable mailbox fails fast, without rendering or logging in.
    const mb = await deliveryMailbox(db, user);
    if (!mb) throw new DigestDeliveryError("no_mailbox");
    mailboxId = mb.id;
    if (mb.status !== "active") throw new DigestDeliveryError(`mailbox_${mb.status}`);
    if (!mb.imapHost) throw new DigestDeliveryError("mailbox_no_host");

    const model = await buildDigestModel(db, user.id, row.localDate, now, { late });
    const links = createLinkFactory({ db, baseUrl: deps.config.APP_BASE_URL, linkSecret: deps.config.linkSecret, now }, user.id, row.id);
    const { subject, html, text } = await renderDigest(model, links);
    const content: DeliveredContent = { subject, html, text, sections: sectionTaskIds(model), renderedAt: now };
    const messageIdHeader = row.messageIdHeader ?? digestMessageId(user.id, row.localDate, deps.config.PLATFORM_MAIL_DOMAIN);
    const raw = await composeDigestMime({ from: `"MailMe" <${mb.address}>`, to: user.email, subject, html, text, messageId: messageIdHeader, date: now });
    const password = await deps.getPassword({ id: mb.id, address: mb.address, credentialsSealed: mb.credentialsSealed });
    const settings: MailboxConnectionSettings = {
      mailboxId: mb.id,
      address: mb.address,
      imapHost: mb.imapHost,
      imapPort: mb.imapPort,
      imapUsername: mb.imapUsername ?? mb.address,
      smtpHost: mb.smtpHost ?? mb.imapHost,
      smtpPort: mb.smtpPort,
    };
    const smtp = user.digestDelivery === "smtp";
    // Durable right before the wire: the content about to be sent (rendered_at = the "New" watermark), and for SMTP
    // the in-flight marker — whatever happens next, a later attempt never submits it again blindly.
    await db
      .update(digests)
      .set({ status: "rendered", ...content, late, messageIdHeader, lastError: smtp ? SMTP_IN_FLIGHT : null })
      .where(eq(digests.id, row.id));

    if (smtp) {
      await deps.transport.sendSmtp(settings, password, raw, { from: mb.address, to: [user.email] });
      sent = { via: "smtp", appendUid: null, content };
    } else {
      const res = await deps.transport.appendToInbox(settings, password, raw, messageIdHeader);
      if (!res.alreadyPresent) {
        sent = { via: "append", appendUid: res.uid, content };
      } else if (previous) {
        // An earlier attempt's APPEND reached the server (its OK was lost): the inbox holds that copy, not this render.
        sent = { via: "append", appendUid: res.uid, content: previous };
      } else {
        // The copy in the inbox is from an attempt whose content was not kept: mark nothing as reported, and keep the
        // "New" watermark at the first claim (may repeat an item tomorrow, never loses one).
        log.warn({ userId: user.id, digestId: row.id }, "digest already in the inbox from an earlier attempt of unknown content; nothing marked as reported");
        sent = { via: "append", appendUid: res.uid, content: { ...content, sections: {}, renderedAt: row.createdAt } };
      }
    }
  } catch (err) {
    return failAttempt(deps, row, now, err, mailboxId);
  }
  return recordSent(deps, user, row, now, sent);
}

async function failAttempt(deps: DigestDeps, row: DigestRow, now: Date, err: unknown, mailboxId: string | null): Promise<AttemptResult> {
  const { db, log } = deps;
  const auth = isAuthError(err);
  const code = errorCode(err);
  // The transport threw, so an SMTP submission was not accepted: the in-flight marker is replaced by the error.
  await db.update(digests).set({ status: "failed", lastError: code }).where(eq(digests.id, row.id));
  if (auth && mailboxId) {
    // AUTHENTICATIONFAILED is final: stop every login with this password until a person fixes it.
    await db
      .update(mailboxes)
      .set({ status: "auth_failed", statusReason: "digest_delivery", lastError: "auth", lastErrorAt: now })
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.status, "active")));
  }
  const retryAt = new Date(now.getTime() + retryDelayMs(err, row.attempts));
  log.warn({ userId: row.userId, digestId: row.id, attempts: row.attempts, code, retryAt: retryAt.toISOString() }, "digest delivery failed");
  return { status: "failed", digestId: row.id, html: "", subject: "", retryAt };
}

/**
 * After a successful send: mark the row delivered and the shown tasks reported. Never the failure path — a failed
 * retry would send the report again. The bookkeeping is retried briefly; if the database still refuses, the row is
 * left for the next dispatch to finish (SMTP: `smtp_sent`, no resend; APPEND: the Message-ID search finds the copy).
 */
async function recordSent(deps: DigestDeps, user: DigestUser, row: DigestRow, now: Date, sent: Sent): Promise<AttemptResult> {
  const { db, log } = deps;
  let lastErr: unknown = null;
  for (let i = 0; i <= RECORD_RETRY_DELAYS_MS.length; i++) {
    try {
      await recordDelivered(db, user.id, row.id, now, sent);
      log.info(
        { userId: user.id, digestId: row.id, via: sent.via, attempts: row.attempts, autoClosed: sent.content.sections.autoClosed?.length ?? 0, stillValid: sent.content.sections.stillValid?.length ?? 0 },
        "digest delivered",
      );
      return { status: "delivered", digestId: row.id, html: sent.content.html ?? "", subject: sent.content.subject ?? "" };
    } catch (err) {
      lastErr = err;
      const delay = RECORD_RETRY_DELAYS_MS[i];
      if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    }
  }
  try {
    await db
      .update(digests)
      .set({ subject: sent.content.subject, html: sent.content.html, text: sent.content.text, sections: sent.content.sections, renderedAt: sent.content.renderedAt, ...(sent.via === "smtp" ? { lastError: SMTP_SENT } : {}) })
      .where(and(eq(digests.id, row.id), inArray(digests.status, ["pending", "rendered"])));
  } catch {
    // Still unreachable: an SMTP row keeps its in-flight marker (→ smtp_unknown, never resent).
  }
  log.error({ userId: user.id, digestId: row.id, via: sent.via, code: errorCode(lastErr) }, "digest sent but its bookkeeping failed; the next dispatch finishes it without resending");
  return { status: "delivered", digestId: row.id, html: sent.content.html ?? "", subject: sent.content.subject ?? "" };
}

/** One transaction: row delivered with the content that went out, auto-closed tasks reported, questions re-stamped. */
async function recordDelivered(db: Db, userId: string, digestId: string, now: Date, sent: Sent): Promise<void> {
  const autoClosed = sent.content.sections.autoClosed ?? [];
  const stillValid = sent.content.sections.stillValid ?? [];
  await db.transaction(async (tx) => {
    const [earlier] = await tx
      .select({ id: digests.id })
      .from(digests)
      .where(and(eq(digests.userId, userId), eq(digests.status, "delivered"), ne(digests.id, digestId)))
      .limit(1);
    await tx
      .update(digests)
      .set({
        status: "delivered",
        deliveredVia: sent.via,
        appendUid: sent.appendUid,
        deliveredAt: now,
        lastError: null,
        subject: sent.content.subject,
        html: sent.content.html,
        text: sent.content.text,
        sections: sent.content.sections,
        renderedAt: sent.content.renderedAt,
      })
      .where(eq(digests.id, digestId));
    if (!earlier) {
      // Go-live: AI closures from the shadow week are part of the "Earlier" triage, not a 5-per-day backlog.
      await tx
        .update(tasks)
        .set({ autoClosedReportedAt: now })
        .where(and(eq(tasks.userId, userId), eq(tasks.closedBy, "ai"), isNull(tasks.autoClosedReportedAt), notInArray(tasks.id, autoClosed.length ? autoClosed : ["00000000-0000-0000-0000-000000000000"])));
    }
    if (autoClosed.length) {
      await tx
        .update(tasks)
        .set({ autoClosedReportedAt: now })
        .where(and(inArray(tasks.id, autoClosed), eq(tasks.userId, userId), isNull(tasks.autoClosedReportedAt)));
    }
    if (stillValid.length) {
      // "Still valid?" counts from when the user was actually shown it; skip tasks answered in the meantime.
      await tx
        .update(tasks)
        .set({ stillValidAskedAt: now })
        .where(and(inArray(tasks.id, stillValid), eq(tasks.userId, userId), isNotNull(tasks.stillValidAskedAt), lte(tasks.lastActivityAt, tasks.stillValidAskedAt)));
    }
  });
}

/** Finish a row whose SMTP submission succeeded but whose bookkeeping failed: delivered with its stored content, no resend. */
async function finalizeSent(deps: DigestDeps, user: DigestUser, row: DigestRow, now: Date): Promise<AttemptResult> {
  const content = storedContent(row) ?? { subject: row.subject, html: row.html, text: row.text, sections: {}, renderedAt: row.renderedAt ?? row.createdAt };
  return recordSent(deps, user, row, now, { via: "smtp", appendUid: null, content });
}

async function runForUser(deps: DigestDeps, user: DigestUser, localDate: string, now: Date, late: boolean, mode: Mode, settleOnly = false): Promise<RunResult> {
  const { db, log } = deps;
  // Fast path without a lease: nothing to do for a finished row.
  const [current] = await db.select().from(digests).where(and(eq(digests.userId, user.id), eq(digests.localDate, localDate)));
  const done = finished(current, mode);
  if (done) return done;
  if (settleOnly && !isSmtpInterrupted(current)) return BUSY;

  const key = leaseKey(user.id, localDate);
  const owner = `${process.pid}:${randomUUID()}`;
  if (!(await acquireLease(db, key, owner, now, mode))) return BUSY;
  let retryAt: Date | null = null;
  try {
    const c = await claim(deps, user, localDate, late, mode, settleOnly);
    if (c.kind === "done") return c.result;
    const res = c.kind === "finalize" ? await finalizeSent(deps, user, c.row, now) : await deliverClaimed(deps, user, c.row, now, late);
    retryAt = res.retryAt ?? null;
    return { status: res.status, digestId: res.digestId, html: res.html, subject: res.subject };
  } finally {
    await releaseLease(db, key, owner, now, retryAt).catch(() => log.warn({ userId: user.id, code: "lease_release_failed" }, "digest lease not released; it expires on its own"));
  }
}

/** Per-minute: users at/after digest_time on a business day with no digest row yet → build, render, deliver exactly once. Catch-up until 11:00. */
export async function dispatchDueDigests(deps: DigestDeps, now: Date): Promise<DispatchReport> {
  const { db, log } = deps;
  const report: DispatchReport = { considered: 0, delivered: 0, failed: 0, skipped: 0 };
  const fallbackZone = safeZone(deps.config.DEFAULT_TIMEZONE);
  const candidates = await db
    .select(userColumns)
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(and(eq(users.digestEnabled, true), isNull(users.disabledAt)))
    .orderBy(asc(users.id));
  const shadow = candidates.some((u) => !u.digestStartDate) ? await loadShadowWeeks(db) : new Map();

  for (const user of candidates) {
    try {
      const zone = safeZone(user.timezone, fallbackZone);
      const startDate = effectiveDigestStart(user.digestStartDate, shadow.get(user.id), zone);
      const decision = decideDue(now, zone, user.digestTime, startDate, holidayCalendar({ includeHolySpirit: user.holySpirit }));
      if (decision.kind === "not_due") continue;
      report.considered++;
      if (decision.kind === "too_late") {
        const inserted = await db
          .insert(digests)
          .values({
            userId: user.id,
            localDate: decision.localDate,
            status: "skipped",
            late: true,
            lastError: "catchup_window_passed",
            messageIdHeader: digestMessageId(user.id, decision.localDate, deps.config.PLATFORM_MAIL_DOMAIN),
          })
          .onConflictDoNothing({ target: [digests.userId, digests.localDate] })
          .returning({ id: digests.id });
        if (inserted[0]) {
          report.skipped++;
          log.warn({ userId: user.id, digestId: inserted[0].id, localDate: decision.localDate }, "digest skipped: catch-up window passed");
        } else {
          // An SMTP delivery interrupted just before the deadline is still finished (sent) or marked (unknown) — never sent.
          const res = await runForUser(deps, user, decision.localDate, now, true, "scheduled", true);
          if (res.status === "delivered") report.delivered++;
          else if (res.status === "failed") report.failed++;
        }
        continue;
      }
      const res = await runForUser(deps, user, decision.localDate, now, decision.late, "scheduled");
      if (res.status === "delivered") report.delivered++;
      else if (res.status === "failed") report.failed++;
    } catch (err) {
      report.failed++;
      log.error({ userId: user.id, code: errorCode(err) }, "digest dispatch error");
    }
  }
  return report;
}

/**
 * Build + render + deliver for one user/date (CLI preview uses dryRun). Status `busy`: another process is delivering
 * this report right now; `smtp_unknown`: an interrupted SMTP submission may have gone out (see SMTP_UNKNOWN).
 */
export async function deliverDigestForUser(deps: DigestDeps, userId: string, localDate: string, opts: { dryRun?: boolean; late?: boolean } = {}): Promise<{ status: string; html: string; subject: string }> {
  const now = deps.clock.now();
  const [user] = await deps.db.select(userColumns).from(users).innerJoin(organizations, eq(organizations.id, users.orgId)).where(eq(users.id, userId));
  if (!user) throw new Error("digest: user not found");
  if (opts.dryRun) {
    const model = await buildDigestModel(deps.db, userId, localDate, now, { late: opts.late ?? false });
    const { subject, html } = await renderDigest(model, createPreviewLinkFactory(deps.config.APP_BASE_URL));
    return { status: "preview", html, subject };
  }
  const res = await runForUser(deps, user, localDate, now, opts.late ?? false, "manual");
  return { status: res.status, html: res.html, subject: res.subject };
}
