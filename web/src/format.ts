/**
 * Pure formatting helpers (dates, chips, counts). No DOM access, so they run under vitest in node.
 * Calendar dates are "YYYY-MM-DD" strings handled in UTC arithmetic; instants are converted to the
 * user's timezone (Me.timezone) with Intl, never the browser's zone.
 */
import type { TaskListItem } from "../../src/server/api-types.js";

/** Index = Date#getUTCDay() (0 = Sunday). Own arrays, so labels never depend on the browser's ICU data. */
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** Index = Date#getUTCMonth() (0 = January). */
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** UTC midnight (ms) of a "YYYY-MM-DD" date, or null if malformed. Also accepts a full ISO string's date part. */
export function isoDateToUtc(iso: string): number | null {
  const m = ISO_DATE.exec(iso.slice(0, 10));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(ms) ? null : ms;
}

function utcToIsoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && isoDateToUtc(value) !== null && utcToIsoDate(isoDateToUtc(value)!) === value;
}

export function addDays(iso: string, days: number): string {
  const ms = isoDateToUtc(iso);
  if (ms === null) return iso;
  return utcToIsoDate(ms + days * DAY_MS);
}

/** to − from in calendar days (negative when `to` is earlier). */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = isoDateToUtc(fromIso);
  const b = isoDateToUtc(toIso);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: string): number {
  const ms = isoDateToUtc(iso);
  return ms === null ? 0 : new Date(ms).getUTCDay();
}

/** Next Monday–Friday strictly after the date (holidays are the server's business). */
export function nextWeekday(iso: string): string {
  let d = addDays(iso, 1);
  while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, 1);
  return d;
}

/** The Monday strictly after the date. */
export function nextMonday(iso: string): string {
  const dow = weekdayOf(iso);
  return addDays(iso, dow === 1 ? 7 : (8 - dow) % 7 || 7);
}

interface ZonedParts {
  date: string;
  time: string;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      // Unknown zone → browser zone rather than a crash.
      f = new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    }
    partsFormatters.set(zone, f);
  }
  return f;
}

/** Local calendar date and HH:mm of an instant in `zone`. */
export function zonedParts(instant: Date | string, zone: string): ZonedParts | null {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const p of formatterFor(zone).formatToParts(d)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

/** Today's local date in the user's timezone. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return zonedParts(now, zone)?.date ?? utcToIsoDate(now.getTime());
}

/** "24 Sep", or "31 Dec 2025" when the year differs from the reference date's year (en-GB order). */
export function formatDayMonth(iso: string, referenceIso?: string): string {
  const ms = isoDateToUtc(iso);
  if (ms === null) return iso;
  const d = new Date(ms);
  const base = `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  if (referenceIso && referenceIso.slice(0, 4) !== iso.slice(0, 4)) return `${base} ${d.getUTCFullYear()}`;
  return base;
}

/** "Thu 24 Sep". */
export function formatDateShort(iso: string, referenceIso?: string): string {
  if (isoDateToUtc(iso) === null) return iso;
  return `${WEEKDAYS_SHORT[weekdayOf(iso)]} ${formatDayMonth(iso, referenceIso)}`;
}

/** "Thursday 24 Sep". */
export function formatDateLong(iso: string, referenceIso?: string): string {
  if (isoDateToUtc(iso) === null) return iso;
  return `${WEEKDAYS_LONG[weekdayOf(iso)]} ${formatDayMonth(iso, referenceIso)}`;
}

/** Instant in the user's zone: "Today 10:02", "Yesterday 18:40", "Tue 22 Sep 09:15" (24-hour clock). */
export function formatDateTime(instant: string | Date, zone: string, today?: string): string {
  const p = zonedParts(instant, zone);
  if (!p) return "";
  if (today) {
    if (p.date === today) return `Today ${p.time}`;
    if (p.date === addDays(today, -1)) return `Yesterday ${p.time}`;
  }
  return `${formatDateShort(p.date, today)} ${p.time}`;
}

/** A count with its noun in the English singular or plural: plural(1, "task", "tasks") → "1 task", plural(2, …) → "2 tasks". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Minutes → "just now", "5 minutes ago", "2 hours ago", "3 days ago". */
export function agoLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return "just now";
  if (m < 60) return `${plural(m, "minute", "minutes")} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${plural(h, "hour", "hours")} ago`;
  return `${plural(Math.floor(h / 24), "day", "days")} ago`;
}

/** Minutes elapsed since an ISO instant. */
export function minutesSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 60_000;
}

export type Tone = "overdue" | "today" | "soon" | "normal" | "muted";

export interface Chip {
  text: string;
  tone: Tone;
  /** Longer text for a tooltip / screen readers. */
  title?: string;
}

type DeadlineInput = Pick<TaskListItem, "status" | "dueDate" | "duePhrase" | "overdue" | "expectReplyBy">;

const CLOSED = new Set(["COMPLETED", "DISMISSED"]);

/**
 * Deadline chip for a list row / task page: overdue → red, due today → orange, tomorrow → "soon".
 * WAITING_FOR_ME reads as a promise ("Promised for …"); WAITING_FOR_OTHER without a due date falls back
 * to the reply-by date (follow-up once it has passed).
 */
export function deadlineChip(item: DeadlineInput, today: string): Chip | null {
  const promise = item.status === "WAITING_FOR_ME";
  if (CLOSED.has(item.status)) {
    return item.dueDate ? { text: `Due ${formatDateShort(item.dueDate, today)}`, tone: "muted" } : null;
  }
  if (item.dueDate && isoDateToUtc(item.dueDate) !== null) {
    const due = item.dueDate;
    const label = formatDateShort(due, today);
    const diff = daysBetween(today, due);
    if (item.overdue || diff < 0) {
      const late = Math.max(0, -diff);
      return {
        text: promise ? `Promise overdue · ${label}` : `Overdue · ${label}`,
        tone: "overdue",
        title: late > 0 ? `Overdue by ${plural(late, "day", "days")} (due ${formatDateLong(due, today)})` : `Overdue (due ${formatDateLong(due, today)})`,
      };
    }
    if (diff === 0) return { text: promise ? "Promised for today" : "Today", tone: "today", title: `Due today, ${formatDateLong(due, today)}` };
    if (diff === 1) return { text: promise ? "Promised for tomorrow" : "Tomorrow", tone: "soon", title: `Due tomorrow, ${formatDateLong(due, today)}` };
    return { text: promise ? `Promised for ${label}` : `Due ${label}`, tone: "normal", title: `Due ${formatDateLong(due, today)}` };
  }
  if (item.duePhrase) return { text: item.duePhrase, tone: "normal", title: "Vague due date (as written)" };
  if (item.status === "WAITING_FOR_OTHER" && item.expectReplyBy && isoDateToUtc(item.expectReplyBy) !== null) {
    const label = formatDateShort(item.expectReplyBy, today);
    if (daysBetween(today, item.expectReplyBy) < 0) return { text: `Follow up · since ${label}`, tone: "today", title: `A reply was expected by ${formatDateLong(item.expectReplyBy, today)}` };
    return { text: `Reply by ${label}`, tone: "normal", title: `A reply is expected by ${formatDateLong(item.expectReplyBy, today)}` };
  }
  return null;
}

/** "waiting 4 business days" (WAITING_FOR_OTHER) / "you promised 4 business days ago" (WAITING_FOR_ME). */
export function waitingLabel(status: TaskListItem["status"], businessDays: number | null): string | null {
  if (businessDays === null || businessDays < 0) return null;
  if (status === "WAITING_FOR_OTHER") {
    return businessDays === 0 ? "waiting since today" : `waiting ${plural(businessDays, "business day", "business days")}`;
  }
  if (status === "WAITING_FOR_ME") {
    return businessDays === 0 ? "you promised today" : `you promised ${plural(businessDays, "business day", "business days")} ago`;
  }
  return null;
}

export function suggestionsLabel(n: number): string | null {
  if (n <= 0) return null;
  return plural(n, "suggestion", "suggestions");
}

/** "Snoozed until Wed 30 Sep" / "Snoozed until they reply". */
export function snoozeLabel(item: Pick<TaskListItem, "snoozeMode" | "snoozedUntil">, today: string): string | null {
  if (item.snoozeMode === "until_reply") return "Snoozed until they reply";
  if (item.snoozeMode === "until_date" && item.snoozedUntil) return `Snoozed until ${formatDateShort(item.snoozedUntil, today)}`;
  if (item.snoozedUntil) return `Snoozed until ${formatDateShort(item.snoozedUntil, today)}`;
  return null;
}

export function counterpartyLabel(item: Pick<TaskListItem, "counterpartyName" | "counterpartyAddress">): string | null {
  const name = item.counterpartyName?.trim();
  const addr = item.counterpartyAddress?.trim();
  if (name && addr) return `${name} <${addr}>`;
  return name || addr || null;
}

/** 1536 KB → "1.5 MB" (decimal point, as en-GB writes it). */
export function formatKb(kb: number): string {
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

/** TOTP secret in groups of four for reading aloud / typing. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** Digits only (users paste "123 456"). */
export function normalizeTotpCode(input: string): string {
  return input.replace(/\D+/g, "").slice(0, 8);
}

/** Loose e-mail check for form hints (the server validates for real). */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim());
}
