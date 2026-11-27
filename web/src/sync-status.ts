/**
 * The sync bar's words (shell/SyncStatus.tsx): what the worker is doing now, from HealthSummary.activity — checking
 * for new mail, reading one mailbox's queue (how many of how many), stopped (why, and until when), late, or done.
 * Pure: the time, the zone and the mailbox names come in as arguments, so it runs under vitest.
 */
import type { HealthSummary, MailboxActivity } from "../../src/server/api-types.js";
import { agoLabel, plural, zonedParts } from "./format.js";

/** live: the worker is at work; ok: up to date; warn: stopped or late; error: needs a person; idle: nothing known yet. */
export type SyncTone = "live" | "ok" | "warn" | "error" | "idle";

export interface SyncView {
  tone: SyncTone;
  /** One short line: what is happening. */
  title: string;
  /** Where, how far, until when; null when the title says it all. */
  detail: string | null;
  /** 0..1 for a bar that fills; "busy" for work with nothing to count; null for no bar. */
  progress: number | "busy" | null;
}

/**
 * A mailbox not synced for longer than this is late. A scheduled pass runs every few minutes, and a long-running
 * worker completes a full cycle every FOLDER_POLL_SEC (5 minutes by default).
 */
export const LATE_SYNC_MINUTES = 30;

/**
 * Email waiting longer than this for the AI is late (the server's banner then calls the analysis incomplete: the same
 * 60 minutes as STALE_AFTER_MINUTES in src/digest/freshness.ts), so the bar never says all is well while it waits.
 */
export const LATE_ANALYSIS_MINUTES = 60;

const BUDGET = new Set(["budget:calls", "budget:usd"]);
const WATCHED = new Set<MailboxActivity["status"]>(["active", "auth_failed", "blocked"]);

export interface SyncContext {
  now: Date;
  zone: string;
  /** Short mailbox names (mailbox-view.ts mailboxShortNames); the address otherwise. */
  names?: ReadonlyMap<string, string>;
}

/** Whether the worker is at work right now: a scheduled pass running, or the AI reading a mailbox's queue. */
export function isWorking(health: HealthSummary | null): boolean {
  const a = health?.activity;
  return Boolean(a && (a.running === true || a.mailboxes.some((m) => m.analysing)));
}

export function describeSync(health: HealthSummary | null, ctx: SyncContext): SyncView {
  if (!health) return { tone: "idle", title: "Sync", detail: null, progress: null };
  const a = health.activity;
  const name = (m: MailboxActivity) => ctx.names?.get(m.id) ?? m.address;
  const watched = a.mailboxes.filter((m) => WATCHED.has(m.status));

  // Nothing new arrives from a mailbox the server cannot log in to: that comes first.
  const broken = watched.find((m) => m.status === "auth_failed" || m.status === "blocked");
  if (broken) {
    const why = broken.status === "auth_failed" ? "the password is not accepted" : "the mail server blocks the connection";
    return { tone: "error", title: "Sync: problem", detail: `${name(broken)}: ${why}`, progress: null };
  }
  // Also before work in progress: a scheduled pass runs during a global pause too, and must not hide it.
  if (a.globalPaused) {
    return { tone: "error", title: "AI analysis stopped", detail: "For every mailbox: an administrator needs to check it", progress: null };
  }

  // The AI reading a queue: during a scheduled pass, or whenever a long-running worker drains a mailbox.
  const reading = watched.find((m) => m.analysing);
  if (reading) {
    const total = reading.done + reading.queued;
    const eta = etaMinutes(reading, a.runningSince, ctx.now);
    return {
      tone: "live",
      title: total > 0 ? `Analysing email: ${reading.done} of ${total}` : "Analysing new email…",
      detail: `${name(reading)}${eta !== null ? ` · about ${plural(eta, "minute", "minutes")} left` : ""}`,
      progress: total > 0 ? reading.done / total : "busy",
    };
  }
  if (a.running) return { tone: "live", title: "Checking for new email…", detail: null, progress: "busy" };

  const paused = watched.find((m) => m.paused);
  if (paused) {
    const budget = BUDGET.has(paused.paused ?? "");
    const parts = [name(paused)];
    if (paused.queued > 0) parts.push(`${plural(paused.queued, "email", "emails")} waiting`);
    if (paused.resumesAt) parts.push(`resumes ${resumeLabel(paused.resumesAt, ctx.zone)}`);
    return { tone: "warn", title: budget ? "Analysis paused: daily limit" : "Analysis paused", detail: parts.join(" · "), progress: null };
  }

  const synced = watched.filter((m) => m.provider === "imap");
  if (synced.some((m) => m.lastSyncAt === null)) return { tone: "live", title: "First sync…", detail: null, progress: "busy" };
  const times = synced.map((m) => Date.parse(m.lastSyncAt!)).filter((t) => Number.isFinite(t));
  const oldest = times.length ? Math.min(...times) : null;
  const newest = times.length ? Math.max(...times) : null;
  const minutes = (t: number) => (ctx.now.getTime() - t) / 60_000;
  if (oldest !== null && minutes(oldest) > LATE_SYNC_MINUTES) {
    const late = synced.find((m) => Date.parse(m.lastSyncAt!) === oldest)!;
    return { tone: "warn", title: "Sync is late", detail: `${name(late)}: last check ${agoLabel(minutes(oldest))}`, progress: null };
  }

  if (health.oldestPendingMinutes !== null && health.oldestPendingMinutes > LATE_ANALYSIS_MINUTES) {
    return {
      tone: "warn",
      title: "Analysis is late",
      detail: `${plural(health.pendingCount, "email", "emails")} waiting · the oldest arrived ${agoLabel(health.oldestPendingMinutes)}`,
      progress: null,
    };
  }

  const last = newest !== null ? `Last check ${agoLabel(minutes(newest))}` : null;
  if (health.failedCount > 0) {
    return { tone: "warn", title: `${plural(health.failedCount, "email", "emails")} not analysed`, detail: last, progress: null };
  }
  const queued = watched.reduce((n, m) => n + m.queued, 0);
  if (queued > 0) {
    return { tone: "ok", title: `${plural(queued, "new email", "new emails")} queued`, detail: `Analysed in the next pass${last ? ` · ${last.toLowerCase()}` : ""}`, progress: null };
  }
  return { tone: "ok", title: "All up to date", detail: last, progress: null };
}

/** Minutes left at this pass's pace, once there is enough to tell (3 messages and half a minute); else null. */
export function etaMinutes(m: Pick<MailboxActivity, "done" | "queued">, runningSince: string | null, now: Date): number | null {
  if (!runningSince || m.done < 3 || m.queued === 0) return null;
  const elapsed = now.getTime() - Date.parse(runningSince);
  if (!Number.isFinite(elapsed) || elapsed < 30_000) return null;
  return Math.max(1, Math.ceil((m.queued * elapsed) / m.done / 60_000));
}

/** "at midnight" for a local midnight, else "at 14:05". */
export function resumeLabel(iso: string, zone: string): string {
  const time = zonedParts(iso, zone)?.time;
  if (!time) return "later";
  return time === "00:00" ? "at midnight" : `at ${time}`;
}

/** The mailbox's own line for "System status". */
export function mailboxActivityLine(m: MailboxActivity, ctx: SyncContext): string {
  const parts: string[] = [];
  if (m.provider === "imap") {
    const ago = m.lastSyncAt ? agoLabel((ctx.now.getTime() - Date.parse(m.lastSyncAt)) / 60_000) : null;
    parts.push(ago ? `synced ${ago}` : "not synced yet");
  }
  parts.push(`${m.doneToday} analysed today`);
  if (m.queued > 0) parts.push(`${m.queued} waiting`);
  if (m.paused && m.resumesAt) parts.push(`resumes ${resumeLabel(m.resumesAt, ctx.zone)}`);
  return parts.join(" · ");
}

/** The mailbox's state in two words, for a chip. */
export function mailboxActivityState(m: MailboxActivity): { label: string; tone: SyncTone } {
  if (m.status === "auth_failed") return { label: "Sign-in failed", tone: "error" };
  if (m.status === "blocked") return { label: "Blocked", tone: "error" };
  if (m.analysing) return { label: "Analysing now", tone: "live" };
  if (m.paused) return { label: BUDGET.has(m.paused) ? "Paused: daily limit" : "Paused", tone: "warn" };
  if (m.status !== "active") return { label: "Inactive", tone: "idle" };
  return { label: "OK", tone: "ok" };
}
