import { DateTime } from "luxon";
import { isBusinessDay } from "../lib/dates.js";
import type { DueKind, DueSpec, Weekday } from "./schema.js";

/**
 * Deadline-phrase spotting and a simple local resolver, used by the mock extractor and the eval scorer.
 * The production resolver is src/engine/due.ts (Greek holidays, zone-aware anchors); this one only needs to
 * agree with it on ordinary cases.
 */

export interface DueHint {
  /** Verbatim substring of the scanned text. */
  phrase: string;
  index: number;
  kind: DueKind;
  weekday: Weekday | null;
  amount: number | null;
  absolute_date: string | null;
  /** Day/month as written, for ABSOLUTE (resolved against the anchor). */
  dayMonth: { day: number; month: number; year: number | null } | null;
}

const NOT_LETTER_BEFORE = "(?<![\\p{L}\\p{N}])";
const NOT_LETTER_AFTER = "(?![\\p{L}\\p{N}])";

const WEEKDAYS: Array<[Weekday, string]> = [
  ["MON", "δευτ[έε]ρα|monday|deutera|deftera"],
  ["TUE", "τρ[ίι]τη|tuesday|triti|trith"],
  ["WED", "τετ[άα]ρτη|wednesday|tetarti|tetarth"],
  ["THU", "π[έε]μπτη|thursday|pempti|pempth"],
  ["FRI", "παρασκευ[ήη]|friday|paraskevi|paraskeuh|paraskeyh|paraskeui"],
  ["SAT", "σ[άα]ββατο|saturday|savvato|sabbato"],
  ["SUN", "κυριακ[ήη]|sunday|kyriaki|kuriakh"],
];

const PREP = "(?:(?:μ[έε]χρι|[έε]ως|ως|by|until|till|before|on|mexri|ews)\\s+)?";
const ART = "(?:(?:την|τη|το|τις|tin|thn|ti|the)\\s+)?";
const NEXT = "(?:επ[όο]μενη|next|epomenh|epomeni)";

interface Rule {
  re: RegExp;
  build(m: RegExpExecArray): Omit<DueHint, "phrase" | "index">;
}

const none = { weekday: null, amount: null, absolute_date: null, dayMonth: null } as const;

function rx(body: string): RegExp {
  return new RegExp(`${NOT_LETTER_BEFORE}(?:${body})${NOT_LETTER_AFTER}`, "giu");
}

const RULES: Rule[] = [
  ...WEEKDAYS.map(
    ([wd, names]): Rule => ({
      re: rx(`${PREP}${ART}${NEXT}\\s+(?:${names})|${PREP}${ART}(?:${names})\\s+(?:της\\s+)?(?:επ[όο]μενης\\s+εβδομ[άα]δας|next\\s+week)`),
      build: () => ({ ...none, kind: "NEXT_WEEKDAY", weekday: wd }),
    }),
  ),
  ...WEEKDAYS.map(
    ([wd, names]): Rule => ({
      re: rx(`${PREP}${ART}(?:${names})`),
      build: () => ({ ...none, kind: "WEEKDAY", weekday: wd }),
    }),
  ),
  { re: rx(`${PREP}(?:μεθα[ύυ]ριο|methavrio|methaurio|the day after tomorrow)`), build: () => ({ ...none, kind: "RELATIVE_DAYS", amount: 2 }) },
  { re: rx(`${PREP}(?:α[ύυ]ριο|tomorrow|avrio|ayrio|aurio)`), build: () => ({ ...none, kind: "RELATIVE_DAYS", amount: 1 }) },
  { re: rx(`(?:${PREP})(?:σ[ήη]μερα|today|shmera|simera)`), build: () => ({ ...none, kind: "RELATIVE_DAYS", amount: 0 }) },
  {
    re: rx(`(?:σε|μέσα σε|εντός|within|in)\\s+(\\d{1,2})\\s+(?:εργ[άα]σιμες|εργ[άα]σιμων|εργ[άα]σιμες\\s+ημ[έε]ρες|working\\s+days|business\\s+days)`),
    build: (m) => ({ ...none, kind: "BUSINESS_DAYS", amount: Number(m[1]) }),
  },
  {
    re: rx(`(?:σε|μέσα σε|εντός|within|in)\\s+(\\d{1,2})\\s+(?:μ[έε]ρες|ημ[έε]ρες|ημερών|days)`),
    build: (m) => ({ ...none, kind: "RELATIVE_DAYS", amount: Number(m[1]) }),
  },
  {
    re: rx(`${PREP}(?:το\\s+)?τ[έε]λος\\s+(?:της\\s+)?εβδομ[άα]δας|(?:by\\s+)?(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?week`),
    build: () => ({ ...none, kind: "END_OF_WEEK" }),
  },
  {
    re: rx(`${PREP}(?:το\\s+)?τ[έε]λος\\s+(?:του\\s+)?μ[ήη]να|(?:by\\s+)?(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?month`),
    build: () => ({ ...none, kind: "END_OF_MONTH" }),
  },
  {
    re: rx(`${PREP}(\\d{1,2})[/.](\\d{1,2})(?:[/.](\\d{2,4}))?`),
    build: (m) => {
      const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
      return { ...none, kind: "ABSOLUTE", dayMonth: { day: Number(m[1]), month: Number(m[2]), year } };
    },
  },
  {
    re: rx(`(?:το\\s+)?συντομ[όο]τερο(?:\\s+δυνατ[όο]ν)?|σ[ύυ]ντομα|[άα]μεσα|asap|as\\s+soon\\s+as\\s+possible|to\\s+syntomotero|amesa`),
    build: () => ({ ...none, kind: "VAGUE" }),
  },
];

/** First concrete deadline phrase in `text` (earliest position); a VAGUE phrase only when no concrete one exists. */
export function findDueHint(text: string): DueHint | null {
  const hits: DueHint[] = [];
  RULES.forEach((rule) => {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const base = rule.build(m);
      if (base.kind === "ABSOLUTE" && (!base.dayMonth || base.dayMonth.day < 1 || base.dayMonth.day > 31 || base.dayMonth.month < 1 || base.dayMonth.month > 12)) continue;
      hits.push({ ...base, phrase: m[0].trim(), index: m.index });
    }
  });
  if (hits.length === 0) return null;
  // Prefer concrete kinds; among them the earliest; NEXT_WEEKDAY wins over a WEEKDAY at the same spot.
  const concrete = hits.filter((h) => h.kind !== "VAGUE");
  const pool = concrete.length ? concrete : hits;
  pool.sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length);
  return pool[0]!;
}

const WEEKDAY_NUM: Record<Weekday, number> = { MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6, SUN: 7 };

/** Local calendar date of a human anchor such as "Friday 2026-09-11 13:44 (Europe/Athens)". */
export function anchorDate(anchor: string | null | undefined): string | null {
  const m = anchor?.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

/** Resolve a due spec against the anchor's local date (YYYY-MM-DD). Returns null for VAGUE or unresolvable. */
export function resolveDueLocal(spec: Pick<DueSpec, "kind" | "weekday" | "amount" | "absolute_date"> & { dayMonth?: DueHint["dayMonth"] }, anchorIso: string): string | null {
  const anchor = DateTime.fromISO(anchorIso, { zone: "UTC" });
  if (!anchor.isValid) return null;
  switch (spec.kind) {
    case "WEEKDAY": {
      if (!spec.weekday) return null;
      let delta = (WEEKDAY_NUM[spec.weekday] - anchor.weekday + 7) % 7;
      if (delta === 0) delta = 7;
      return anchor.plus({ days: delta }).toISODate();
    }
    case "NEXT_WEEKDAY": {
      if (!spec.weekday) return null;
      const nextMonday = anchor.plus({ days: 8 - anchor.weekday });
      return nextMonday.plus({ days: WEEKDAY_NUM[spec.weekday] - 1 }).toISODate();
    }
    case "RELATIVE_DAYS":
      return spec.amount === null ? null : anchor.plus({ days: spec.amount }).toISODate();
    case "BUSINESS_DAYS": {
      if (spec.amount === null) return null;
      let d = anchor;
      let left = spec.amount;
      while (left > 0) {
        d = d.plus({ days: 1 });
        if (isBusinessDay(d.toISODate()!)) left--;
      }
      return d.toISODate();
    }
    case "END_OF_WEEK":
      return (anchor.weekday <= 5 ? anchor.plus({ days: 5 - anchor.weekday }) : anchor.plus({ days: 12 - anchor.weekday })).toISODate();
    case "END_OF_MONTH":
      return anchor.endOf("month").toISODate();
    case "ABSOLUTE": {
      if (spec.absolute_date) return DateTime.fromISO(spec.absolute_date).isValid ? spec.absolute_date : null;
      const dm = spec.dayMonth;
      if (!dm) return null;
      let d = DateTime.fromObject({ year: dm.year ?? anchor.year, month: dm.month, day: dm.day }, { zone: "UTC" });
      if (!d.isValid) return null;
      // Same rule as the prompt and src/engine/due.ts: next year only when more than 2 months in the past.
      if (dm.year === null && d < anchor.minus({ months: 2 })) d = d.plus({ years: 1 });
      return d.toISODate();
    }
    default:
      return null;
  }
}

/** Turn a hint into a schema DueSpec (absolute_date and model_date resolved against the anchor). */
export function hintToDueSpec(hint: DueHint, segmentId: string, anchorIso: string | null): DueSpec {
  const resolved = anchorIso ? resolveDueLocal(hint, anchorIso) : null;
  return {
    phrase: hint.phrase,
    kind: hint.kind,
    absolute_date: hint.kind === "ABSOLUTE" ? resolved : null,
    weekday: hint.weekday,
    amount: hint.amount,
    segment_id: segmentId,
    model_date: hint.kind === "VAGUE" ? null : resolved,
  };
}
