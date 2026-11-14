import { DateTime } from "luxon";

/**
 * Calendar helpers. All "business" logic is evaluated in the organization's timezone
 * (Europe/Athens by default) so DST and late-evening emails land on the right day.
 */

/** English display names, Monday first (index = Luxon's weekday - 1). Own arrays, so output never depends on ICU. */
export const EN_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const EN_WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
/** English month abbreviations, January first (index = Luxon's month - 1). */
export const EN_MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Orthodox Easter Sunday (Gregorian date) — Meeus Julian algorithm + Julian→Gregorian offset (valid 1900–2099). */
export function orthodoxEaster(year: number): DateTime {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  return DateTime.fromObject({ year, month, day }, { zone: "UTC" }).plus({ days: 13 });
}

/**
 * Greek public holidays observed by most private businesses.
 * Holy Spirit Monday (Whit Monday) is optional because not every business closes.
 */
export function greekHolidays(year: number, opts: { includeHolySpirit?: boolean } = {}): Set<string> {
  const easter = orthodoxEaster(year);
  const fixed = ["01-01", "01-06", "03-25", "05-01", "08-15", "10-28", "12-25", "12-26"].map((md) => `${year}-${md}`);
  const movable = [
    easter.minus({ days: 48 }), // Clean Monday
    easter.minus({ days: 2 }), // Good Friday
    easter.plus({ days: 1 }), // Easter Monday
  ];
  if (opts.includeHolySpirit) movable.push(easter.plus({ days: 50 }));
  return new Set([...fixed, ...movable.map((d) => d.toISODate()!)]);
}

export function isBusinessDay(isoDate: string, holidays: (year: number) => Set<string> = greekHolidays): boolean {
  const d = DateTime.fromISO(isoDate, { zone: "UTC" });
  if (d.weekday >= 6) return false;
  return !holidays(d.year).has(isoDate);
}

/** Local calendar date (YYYY-MM-DD) of an instant in the given zone. */
export function localDate(instant: Date, zone: string): string {
  return DateTime.fromJSDate(instant, { zone }).toISODate()!;
}

/**
 * Number of business days strictly after `fromIso` up to and including `toIso`.
 * Example: Fri → next Mon = 1; same day = 0; to < from = 0.
 */
export function businessDaysBetween(fromIso: string, toIso: string): number {
  let d = DateTime.fromISO(fromIso, { zone: "UTC" });
  const end = DateTime.fromISO(toIso, { zone: "UTC" });
  let n = 0;
  while (d < end) {
    d = d.plus({ days: 1 });
    if (isBusinessDay(d.toISODate()!)) n++;
  }
  return n;
}

/** Calendar days between two local dates (to - from), never negative. */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  const diff = DateTime.fromISO(toIso).diff(DateTime.fromISO(fromIso), "days").days;
  return Math.max(0, Math.round(diff));
}

/** Human anchor for the AI prompt, e.g. "Friday 2026-09-11 13:44 (Europe/Athens)". */
export function describeInstant(instant: Date, zone: string): string {
  const dt = DateTime.fromJSDate(instant, { zone });
  return `${EN_WEEKDAYS[dt.weekday - 1]} ${dt.toFormat("yyyy-LL-dd HH:mm")} (${zone})`;
}

/** Next business day on or after the given local date. */
export function nextBusinessDay(isoDate: string): string {
  let d = DateTime.fromISO(isoDate, { zone: "UTC" });
  while (!isBusinessDay(d.toISODate()!)) d = d.plus({ days: 1 });
  return d.toISODate()!;
}
