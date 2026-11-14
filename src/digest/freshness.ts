import { and, eq, gte, inArray, isNull, min, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.js";
import { appState, mailboxes, messages, organizations, users } from "../db/schema.js";
import { localDateOf, localTime, safeZone, shortDayLabel } from "./calendar.js";
import type { DigestProblem, Freshness } from "./model.js";

/** Sync older than this, or a pending message waiting longer than this, makes the analysis "incomplete". */
export const STALE_AFTER_MINUTES = 60;
/**
 * Parked (failed) messages count toward the banner only while not acknowledged and only for this long: a message
 * parked weeks ago says nothing about today's data (the web "Not analysed" list and `messages:parked` keep them).
 */
export const PARKED_BANNER_HOURS = 24;

/**
 * Parked, not acknowledged, parked at/after `since`. Every parking path stamps `updated_at` (engine/pipeline.ts,
 * engine/apply.ts) and retention leaves a parked row's `updated_at` alone, so it is the parked time.
 */
export function recentParkedSql(since: Date) {
  return and(eq(messages.state, "failed"), isNull(messages.failureAcknowledgedAt), gte(messages.updatedAt, since));
}

/**
 * app_state keys that may hold the global AI pause (the engine sets it on a GLOBAL extractor error).
 * The key is not part of the contract yet, so every plausible spelling is honoured.
 */
export const GLOBAL_PAUSE_KEYS = ["ai_global_pause", "global_ai_pause", "ai_paused", "global_pause", "ai_pause"] as const;

/** Mailbox statuses that are expected to be syncing (setup/paused/disabled are the user's choice). */
const WATCHED_STATUSES = new Set(["active", "auth_failed", "blocked"]);

export interface MailboxHealth {
  id: string;
  address: string;
  provider: "imap" | "ingest";
  status: string;
  lastSyncAt: Date | null;
  aiPaused: boolean;
  aiPausedReason: string | null;
}

export interface FreshnessInput {
  now: Date;
  zone: string;
  mailboxes: MailboxHealth[];
  pendingCount: number;
  oldestPendingAt: Date | null;
  failedCount: number;
  globalPaused: boolean;
}

export interface FreshnessAssessment {
  freshness: Freshness;
  /** Freshness-related report problems (auth_failed / stale / paused). */
  problems: DigestProblem[];
}

const minutesBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));

/** Pure: health numbers → banner text and problem lines. */
export function assessFreshness(input: FreshnessInput): FreshnessAssessment {
  const { now, zone } = input;
  const watched = input.mailboxes.filter((m) => WATCHED_STATUSES.has(m.status));
  const synced = watched.filter((m) => m.provider === "imap");

  const syncTimes = synced.map((m) => m.lastSyncAt).filter((d): d is Date => d !== null);
  const lastSyncAt = syncTimes.length ? new Date(Math.min(...syncTimes.map((d) => d.getTime()))) : null;
  const staleMinutes = lastSyncAt ? minutesBetween(lastSyncAt, now) : null;
  const neverSynced = synced.some((m) => m.lastSyncAt === null);
  const staleMailboxes = synced.filter((m) => m.lastSyncAt !== null && minutesBetween(m.lastSyncAt, now) > STALE_AFTER_MINUTES);

  const oldestPendingMinutes = input.oldestPendingAt ? minutesBetween(input.oldestPendingAt, now) : null;
  const pendingStale = oldestPendingMinutes !== null && oldestPendingMinutes > STALE_AFTER_MINUTES;

  const authFailed = watched.filter((m) => m.status === "auth_failed");
  const blocked = watched.filter((m) => m.status === "blocked");
  const mailboxPaused = watched.filter((m) => m.aiPaused);
  const paused = input.globalPaused || mailboxPaused.length > 0;

  // "Incomplete since": the earliest point from which data may be missing.
  const sinceCandidates: Date[] = [];
  for (const m of [...staleMailboxes, ...authFailed, ...blocked]) if (m.lastSyncAt) sinceCandidates.push(m.lastSyncAt);
  if (pendingStale && input.oldestPendingAt) sinceCandidates.push(input.oldestPendingAt);
  const since = sinceCandidates.length ? new Date(Math.min(...sinceCandidates.map((d) => d.getTime()))) : null;

  const incomplete = staleMailboxes.length > 0 || neverSynced || pendingStale || paused || authFailed.length > 0 || blocked.length > 0;
  const parts: string[] = [];
  if (incomplete) parts.push(since ? `Analysis incomplete since ${formatSince(since, now, zone)}` : "Analysis incomplete");
  if (authFailed.length) parts.push("Your email password is needed again");
  if (blocked.length) parts.push("The connection to the mail server is blocked");
  if (neverSynced) parts.push("No sync has finished yet");
  if (paused) parts.push("AI analysis is paused");
  if (input.failedCount > 0) parts.push(input.failedCount === 1 ? "1 message not analysed" : `${input.failedCount} messages not analysed`);

  const problems: DigestProblem[] = [];
  for (const m of authFailed) {
    problems.push({ kind: "auth_failed", text: `The password for ${m.address} is not accepted. Enter it again in the MailMe settings.` });
  }
  for (const m of blocked) {
    problems.push({ kind: "stale", text: `The mail server connection for ${m.address} is blocked.` });
  }
  for (const m of staleMailboxes) {
    if (m.status !== "active") continue;
    problems.push({ kind: "stale", text: `Last sync of ${m.address}: ${formatSince(m.lastSyncAt!, now, zone)}.` });
  }
  if (pendingStale && input.oldestPendingAt) {
    problems.push({ kind: "stale", text: `${input.pendingCount} ${input.pendingCount === 1 ? "message is" : "messages are"} waiting for analysis (the oldest since ${formatSince(input.oldestPendingAt, now, zone)}).` });
  }
  if (input.globalPaused) problems.push({ kind: "paused", text: "AI analysis is stopped for all accounts." });
  for (const m of mailboxPaused) {
    // The last alternative is Greek for "limit": a pause reason may have been typed in Greek.
    const budget = /budget|cap|limit|όριο/i.test(m.aiPausedReason ?? "");
    problems.push({ kind: "paused", text: `AI analysis for ${m.address} is paused${budget ? " (daily limit)" : ""}.` });
  }

  return {
    freshness: {
      lastSyncAt,
      staleMinutes,
      pendingCount: input.pendingCount,
      oldestPendingMinutes,
      failedCount: input.failedCount,
      paused,
      banner: parts.length ? parts.join(" · ") : null,
    },
    problems,
  };
}

/** "06:10" today, "Tue 22 Sep 18:05" on another day. */
function formatSince(at: Date, now: Date, zone: string): string {
  const day = localDateOf(at, zone);
  return day === localDateOf(now, zone) ? localTime(at, zone) : `${shortDayLabel(day)} ${localTime(at, zone)}`;
}

/** Interpret an app_state value as "paused". A row without an explicit flag counts as paused. */
export function isPausedValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["true", "1", "on", "paused", "yes"].includes(v.trim().toLowerCase());
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["paused", "active", "enabled", "on"]) if (k in o) return Boolean(o[k]);
    return true;
  }
  return false;
}

export async function isGloballyPaused(db: DbOrTx): Promise<boolean> {
  const rows = await db.select({ value: appState.value }).from(appState).where(inArray(appState.key, [...GLOBAL_PAUSE_KEYS]));
  return rows.some((r) => isPausedValue(r.value));
}

/**
 * Load a user's health numbers (zone from the org) and assess them. Parked messages count while not acknowledged
 * and parked within the last PARKED_BANNER_HOURS.
 */
export async function loadFreshness(db: DbOrTx, userId: string, now: Date, zoneOverride?: string): Promise<FreshnessAssessment> {
  let zone = zoneOverride;
  if (!zone) {
    const [row] = await db
      .select({ timezone: organizations.timezone })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .where(eq(users.id, userId));
    zone = safeZone(row?.timezone);
  }
  const mbs = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      provider: mailboxes.provider,
      status: mailboxes.status,
      lastSyncAt: mailboxes.lastSyncAt,
      aiPaused: mailboxes.aiPaused,
      aiPausedReason: mailboxes.aiPausedReason,
    })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId));
  const ids = mbs.map((m) => m.id);
  let pendingCount = 0;
  let oldestPendingAt: Date | null = null;
  let failedCount = 0;
  if (ids.length) {
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int`, oldest: min(messages.firstSeenAt) })
      .from(messages)
      .where(and(inArray(messages.mailboxId, ids), inArray(messages.state, ["pending", "extracted"])));
    pendingCount = Number(pending?.n ?? 0);
    oldestPendingAt = pending?.oldest ? new Date(pending.oldest) : null;
    const [failed] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(inArray(messages.mailboxId, ids), recentParkedSql(new Date(now.getTime() - PARKED_BANNER_HOURS * 3_600_000))));
    failedCount = Number(failed?.n ?? 0);
  }
  return assessFreshness({ now, zone, mailboxes: mbs, pendingCount, oldestPendingAt, failedCount, globalPaused: await isGloballyPaused(db) });
}

/** Sync/queue health for a user's mailboxes; banner if > 60 min stale, recent unacknowledged failures, auth problems or paused. */
export async function computeFreshness(db: Db, userId: string, now: Date): Promise<Freshness> {
  return (await loadFreshness(db, userId, now)).freshness;
}
