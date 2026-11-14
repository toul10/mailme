import { DateTime } from "luxon";
import type { DueSpec, Weekday } from "../ai/schema.js";
import { greekHolidays, isBusinessDay } from "../lib/dates.js";
import { foldForMatch } from "../lib/text.js";

export interface DueResolution {
  /** YYYY-MM-DD or null (VAGUE / unresolvable). */
  date: string | null;
  /** Model's date agrees with ours (null when model gave none). */
  agrees: boolean | null;
  reasons: string[];
}

/**
 * Resolution rules. All arithmetic is on the anchor's *local* calendar date in `zone`,
 * so an email sent at 00:40 local belongs to that local day and DST never shifts a day.
 *
 * | kind          | result                                                                                   |
 * |---------------|------------------------------------------------------------------------------------------|
 * | ABSOLUTE      | `absolute_date` (YYYY-MM-DD, must be a real date). If the phrase has no year, the year   |
 * |               | is re-derived from the anchor: the anchor's year, +1 only if the date would be more than |
 * |               | 2 months before the anchor day («15/1» written in December); a recent past date stays   |
 * |               | in the anchor's year (→ before_anchor), whatever year the model chose.                   |
 * | WEEKDAY       | next occurrence strictly after the anchor day; the anchor day itself only if the phrase |
 * |               | says today, σήμερα ("on Friday" said on a Friday = next Friday).                          |
 * | NEXT_WEEKDAY  | that weekday in the ISO week (Mon–Sun) after the anchor's week.                          |
 * | RELATIVE_DAYS | anchor day + n calendar days (0 = today, 1 = tomorrow).                                   |
 * | BUSINESS_DAYS | n-th business day after the anchor day (Mon–Fri minus Greek holidays); n = 0 → the       |
 * |               | anchor day if it is a business day, else the next one.                                    |
 * | END_OF_WEEK   | Friday of the anchor's week; Sat/Sun anchors → next week's Friday.                       |
 * | END_OF_MONTH  | last business day of the anchor's month (the last calendar day if that is already past). |
 * | VAGUE         | null (shown as text).                                                                     |
 *
 * Missing `weekday` / `amount` fall back to the phrase: Greek or English weekday names, and today / tomorrow / the day
 * after tomorrow (Greek σήμερα / αύριο / μεθαύριο).
 * Any result before the anchor day or more than {@link DUE_HORIZON_DAYS} after it → null with a reason.
 * `agrees` = model_date === date (false, plus a reason, if model_date is malformed); for END_OF_MONTH the last
 * calendar day of the month also agrees (the resolver picks the last business day on or before it).
 */
export const DUE_HORIZON_DAYS = 366;

/** Deterministic resolution from the segment anchor in the org zone, Greek business calendar. */
export function resolveDue(spec: DueSpec, anchor: Date, zone: string, opts: { holySpirit?: boolean } = {}): DueResolution {
  const reasons: string[] = [];
  const finish = (date: DateTime | null): DueResolution => {
    const iso = date ? date.toISODate() : null;
    return { date: iso, agrees: compareModelDate(spec.model_date, iso, reasons), reasons };
  };

  if (!(anchor instanceof Date) || Number.isNaN(anchor.getTime())) {
    reasons.push("invalid_anchor");
    return finish(null);
  }
  const local = DateTime.fromJSDate(anchor, { zone });
  if (!local.isValid) {
    reasons.push("invalid_zone");
    return finish(null);
  }
  const day = DateTime.fromObject({ year: local.year, month: local.month, day: local.day }, { zone: "UTC" });
  const isBiz = businessDayPredicate(opts.holySpirit ?? false);
  const phrase = foldForMatch(spec.phrase ?? "");

  let date: DateTime | null = null;
  switch (spec.kind) {
    case "VAGUE":
      reasons.push("vague");
      return finish(null);

    case "ABSOLUTE": {
      const parsed = parseIsoDate(spec.absolute_date);
      if (!parsed) {
        reasons.push("invalid_absolute_date");
        return finish(null);
      }
      date = parsed;
      if (!phraseHasYear(spec.phrase ?? "")) {
        // The phrase names no year: ours to derive from the anchor, whatever year the model picked. A recently
        // passed "by 15/9" stays in the anchor's year (→ before_anchor → review: overdue, not next year's).
        const derived = yearFromAnchor(parsed, day);
        if (derived) {
          if (derived.year > day.year) reasons.push("year_rolled_forward");
          if (derived.year !== parsed.year) reasons.push("absolute_year_corrected");
          date = derived;
        }
      }
      break;
    }

    case "WEEKDAY": {
      const wd = weekdayOf(spec.weekday, phrase, reasons);
      if (wd === null) return finish(null);
      let delta = (wd - day.weekday + 7) % 7;
      if (delta === 0 && !saysToday(phrase)) delta = 7;
      date = day.plus({ days: delta });
      break;
    }

    case "NEXT_WEEKDAY": {
      const wd = weekdayOf(spec.weekday, phrase, reasons);
      if (wd === null) return finish(null);
      const monday = day.minus({ days: day.weekday - 1 });
      date = monday.plus({ days: 7 + (wd - 1) });
      break;
    }

    case "RELATIVE_DAYS": {
      const n = spec.amount ?? relativeFromPhrase(phrase);
      if (n === null) {
        reasons.push("missing_amount");
        return finish(null);
      }
      if (spec.amount === null) reasons.push("amount_from_phrase");
      if (!Number.isInteger(n) || n < 0) {
        reasons.push("invalid_amount");
        return finish(null);
      }
      date = day.plus({ days: n });
      break;
    }

    case "BUSINESS_DAYS": {
      const n = spec.amount;
      if (n === null) {
        reasons.push("missing_amount");
        return finish(null);
      }
      if (!Number.isInteger(n) || n < 0) {
        reasons.push("invalid_amount");
        return finish(null);
      }
      date = addBusinessDaysDt(day, n, isBiz, DUE_HORIZON_DAYS + 1);
      if (!date) {
        reasons.push("beyond_horizon");
        return finish(null);
      }
      break;
    }

    case "END_OF_WEEK": {
      const wd = day.weekday;
      date = day.plus({ days: wd <= 5 ? 5 - wd : 12 - wd });
      break;
    }

    case "END_OF_MONTH": {
      const last = day.endOf("month").startOf("day");
      let d = last;
      while (d >= day && !isBiz(d)) d = d.minus({ days: 1 });
      if (d < day) {
        reasons.push("no_business_day_left_in_month");
        d = last;
      }
      date = d;
      break;
    }

    default: {
      reasons.push("unknown_kind");
      return finish(null);
    }
  }

  if (date < day) {
    reasons.push("before_anchor");
    return finish(null);
  }
  if (date > day.plus({ days: DUE_HORIZON_DAYS })) {
    reasons.push("beyond_horizon");
    return finish(null);
  }
  if (spec.kind === "END_OF_MONTH" && spec.model_date) {
    // "By the end of the month" read literally (the last calendar day) is the same deadline, not a disagreement.
    const calendarEnd = day.endOf("month").startOf("day").toISODate();
    if (spec.model_date === calendarEnd && calendarEnd >= date.toISODate()!) {
      return { date: date.toISODate(), agrees: true, reasons };
    }
  }
  return finish(date);
}

/**
 * Month/day of `parsed` in the anchor's year, or the next year when that is more than 2 months before the anchor day
 * («15/1» written in December). Null if the day does not exist in either year (29/2).
 */
function yearFromAnchor(parsed: DateTime, day: DateTime): DateTime | null {
  for (const year of [day.year, day.year + 1]) {
    const d = DateTime.fromObject({ year, month: parsed.month, day: parsed.day }, { zone: "UTC" });
    if (!d.isValid) continue;
    if (year === day.year && d < day.minus({ months: 2 })) continue;
    return d;
  }
  return null;
}

/** n-th business day after a local date (n = 0 → the date itself if a business day, else the next one). */
export function addBusinessDays(fromIso: string, n: number, opts: { holySpirit?: boolean } = {}): string | null {
  const from = parseIsoDate(fromIso);
  if (!from || !Number.isInteger(n) || n < 0) return null;
  const d = addBusinessDaysDt(from, n, businessDayPredicate(opts.holySpirit ?? false), DUE_HORIZON_DAYS * 4);
  return d ? d.toISODate() : null;
}

/** Business-day test honouring the Holy Spirit Monday option (lib/dates' default omits it). */
export function isBusinessDate(isoDate: string, opts: { holySpirit?: boolean } = {}): boolean {
  const d = parseIsoDate(isoDate);
  return d !== null && businessDayPredicate(opts.holySpirit ?? false)(d);
}

// ── internals ────────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAY_NUM: Record<Weekday, number> = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };

/** Folded Greek stems and English names → ISO weekday. Used only when the model left `weekday` null. */
const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/δευτερα|\bmon(day)?\b/, 1],
  [/τριτη|\btue(s|sday)?\b/, 2],
  [/τεταρτη|\bwed(nesday)?\b/, 3],
  [/πεμπτη|\bthu(rs|rsday)?\b/, 4],
  [/παρασκευη|\bfri(day)?\b/, 5],
  [/σαββατ|\bsat(urday)?\b/, 6],
  [/κυριακη|\bsun(day)?\b/, 7],
];

function parseIsoDate(s: string | null | undefined): DateTime | null {
  const m = s ? ISO_DATE.exec(s) : null;
  if (!m) return null;
  const d = DateTime.fromObject({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, { zone: "UTC" });
  return d.isValid ? d : null;
}

function compareModelDate(modelDate: string | null, ours: string | null, reasons: string[]): boolean | null {
  if (modelDate === null || modelDate === undefined) return null;
  if (!parseIsoDate(modelDate)) {
    reasons.push("model_date_invalid");
    return false;
  }
  if (modelDate !== ours) {
    reasons.push("model_date_disagrees");
    return false;
  }
  return true;
}

function businessDayPredicate(holySpirit: boolean): (d: DateTime) => boolean {
  const cache = new Map<number, Set<string>>();
  const holidays = (year: number): Set<string> => {
    let set = cache.get(year);
    if (!set) {
      set = greekHolidays(year, { includeHolySpirit: holySpirit });
      cache.set(year, set);
    }
    return set;
  };
  return (d) => isBusinessDay(d.toISODate()!, holidays);
}

function addBusinessDaysDt(from: DateTime, n: number, isBiz: (d: DateTime) => boolean, maxDays: number): DateTime | null {
  let d = from;
  if (n === 0) {
    while (!isBiz(d)) {
      d = d.plus({ days: 1 });
      if (d.diff(from, "days").days > maxDays) return null;
    }
    return d;
  }
  let count = 0;
  while (count < n) {
    d = d.plus({ days: 1 });
    if (d.diff(from, "days").days > maxDays) return null;
    if (isBiz(d)) count++;
  }
  return d;
}

function weekdayOf(weekday: Weekday | null, foldedPhrase: string, reasons: string[]): number | null {
  if (weekday) return WEEKDAY_NUM[weekday];
  const hits = new Set(WEEKDAY_WORDS.filter(([re]) => re.test(foldedPhrase)).map(([, n]) => n));
  if (hits.size === 1) {
    reasons.push("weekday_from_phrase");
    return [...hits][0]!;
  }
  reasons.push(hits.size > 1 ? "ambiguous_weekday" : "missing_weekday");
  return null;
}

function saysToday(foldedPhrase: string): boolean {
  return /σημερα|αποψε|\btoday\b|\btonight\b/.test(foldedPhrase);
}

function relativeFromPhrase(foldedPhrase: string): number | null {
  if (/μεθαυριο|day after tomorrow/.test(foldedPhrase)) return 2;
  if (/αυριο|\btomorrow\b/.test(foldedPhrase)) return 1;
  if (saysToday(foldedPhrase)) return 0;
  return null;
}

/** "15/10/2026", "15.10.26", "October 2026", "'26" → the phrase states a year. */
function phraseHasYear(phrase: string): boolean {
  return (
    /(?:^|\D)(?:19|20)\d{2}(?:\D|$)/.test(phrase) ||
    /\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2}(?:\D|$)/.test(phrase) ||
    /['’]\s?\d{2}(?:\D|$)/.test(phrase)
  );
}
