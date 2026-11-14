import { DateTime } from "luxon";
import { EN_MONTHS_SHORT, EN_WEEKDAYS, EN_WEEKDAYS_SHORT, greekHolidays } from "../lib/dates.js";

/**
 * Digest-side calendar helpers: org-aware business days (optional Holy Spirit Monday), zone validation and
 * the short English date labels used in the report (own day and month names, so they never depend on ICU).
 */

export type HolidayFn = (year: number) => Set<string>;

/** Holiday calendar for an organization, memoized per year. */
export function holidayCalendar(opts: { includeHolySpirit?: boolean } = {}): HolidayFn {
  const cache = new Map<number, Set<string>>();
  return (year) => {
    let set = cache.get(year);
    if (!set) {
      set = greekHolidays(year, { includeHolySpirit: opts.includeHolySpirit ?? false });
      cache.set(year, set);
    }
    return set;
  };
}

export function isBusinessDayWith(isoDate: string, holidays: HolidayFn): boolean {
  const d = DateTime.fromISO(isoDate, { zone: "UTC" });
  if (d.weekday >= 6) return false;
  return !holidays(d.year).has(isoDate);
}

/** Business days strictly after `fromIso` up to and including `toIso` (0 when to ≤ from). */
export function businessDaysBetweenWith(fromIso: string, toIso: string, holidays: HolidayFn): number {
  let d = DateTime.fromISO(fromIso, { zone: "UTC" });
  const end = DateTime.fromISO(toIso, { zone: "UTC" });
  let n = 0;
  while (d < end) {
    d = d.plus({ days: 1 });
    if (isBusinessDayWith(d.toISODate()!, holidays)) n++;
  }
  return n;
}

/** The n-th business day after `isoDate` (n ≥ 1). */
export function addBusinessDays(isoDate: string, n: number, holidays: HolidayFn): string {
  let d = DateTime.fromISO(isoDate, { zone: "UTC" });
  let left = n;
  while (left > 0) {
    d = d.plus({ days: 1 });
    if (isBusinessDayWith(d.toISODate()!, holidays)) left--;
  }
  return d.toISODate()!;
}

/** Calendar days from `fromIso` to `toIso` (negative when to < from). */
export function calendarDiff(fromIso: string, toIso: string): number {
  return Math.round(DateTime.fromISO(toIso, { zone: "UTC" }).diff(DateTime.fromISO(fromIso, { zone: "UTC" }), "days").days);
}

/** A valid IANA zone, else the fallback. */
export function safeZone(zone: string | null | undefined, fallback = "Europe/Athens"): string {
  if (zone && DateTime.local().setZone(zone).isValid) return zone;
  return fallback;
}

export function localDateOf(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

/** Instant of a local wall-clock time on a local date (DST gaps shift forward, as luxon does). */
export function localInstant(isoDate: string, hhmm: string, zone: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return DateTime.fromISO(isoDate, { zone }).set({ hour: h ?? 0, minute: m ?? 0, second: 0, millisecond: 0 }).toJSDate();
}

/** "HH:MM" (00:00–23:59) or null. */
export function parseHhmm(value: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** "24 Sep" */
export function dayMonth(isoDate: string): string {
  const d = DateTime.fromISO(isoDate, { zone: "UTC" });
  return `${d.day} ${EN_MONTHS_SHORT[d.month - 1]}`;
}

/** "Thursday 24 Sep" */
export function weekdayLabel(isoDate: string): string {
  const d = DateTime.fromISO(isoDate, { zone: "UTC" });
  return `${EN_WEEKDAYS[d.weekday - 1]} ${dayMonth(isoDate)}`;
}

/** "Thu 24 Sep" */
export function shortDayLabel(isoDate: string): string {
  const d = DateTime.fromISO(isoDate, { zone: "UTC" });
  return `${EN_WEEKDAYS_SHORT[d.weekday - 1]} ${dayMonth(isoDate)}`;
}

/** Local "YYYY-MM-DD HH:mm" of an instant (digest item dates are shown in the org zone). */
export function localDateTime(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat("yyyy-LL-dd HH:mm");
}

/** "HH:MM" of an instant in the zone. */
export function localTime(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toFormat("HH:mm");
}
