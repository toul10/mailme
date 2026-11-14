import { DateTime } from "luxon";

/**
 * Dates as written in quoted-reply header blocks and attribution lines, EN and EL:
 *   "Wednesday, September 9, 2026 10:02 AM" · "Τετάρτη, 9 Σεπτεμβρίου 2026 10:02 π.μ." · "Wed, Sep 9, 2026 at 10:02 AM"
 *   "Τετ, 9 Σεπ 2026 στις 10:02 π.μ." · "9/9/2026 10:02 πμ" · "2026-09-09 10:02" · RFC 5322 dates.
 * Returns an ISO instant (UTC, "…Z") or null. Dates without an explicit offset are read in `zone`.
 */
export function parseQuotedDate(input: string | null | undefined, zone = "Europe/Athens"): string | null {
  if (!input) return null;
  const raw = input.replace(/[\u{00a0}\u{202f}\u{2009}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!raw) return null;

  const rfc = parseRfcLike(raw);
  if (rfc) return rfc;

  const f = fold(raw);
  // The time is looked for outside numeric dates: in "09.09.2026 10:02" the "09.09" is the date, not 09:09.
  const time = findTime(f.replace(NUMERIC_DATES, (m) => " ".repeat(m.length)));
  const offset = findOffset(f);
  const hasLatin = /\b(am|pm|a\.m\.|p\.m\.)\b/.test(f) || /[a-z]{3,}/.test(f.replace(/\b(gmt|utc|at)\b/g, ""));

  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(f);
  if (iso) {
    y = +iso[1]!;
    m = +iso[2]!;
    d = +iso[3]!;
  }

  if (y === null) {
    const tokens = f.split(/[\s,]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const month = MONTHS.get(tokens[i]!.replace(/\.$/, ""));
      if (month === undefined) continue;
      const before = tokens[i - 1] !== undefined ? /^(\d{1,2})(?:η|st|nd|rd|th)?\.?$/.exec(tokens[i - 1]!) : null;
      const after = tokens[i + 1] !== undefined ? /^(\d{1,2})(?:η|st|nd|rd|th)?\.?$/.exec(tokens[i + 1]!) : null;
      const dayTok = before ?? after;
      if (!dayTok) continue;
      m = month;
      d = +dayTok[1]!;
      const yr = /\b(19\d\d|20\d\d)\b/.exec(tokens.slice(i).join(" "));
      if (yr) y = +yr[1]!;
      break;
    }
  }

  if (y === null) {
    const num = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(f);
    if (num) {
      const a = +num[1]!;
      const b = +num[2]!;
      y = num[3]!.length === 2 ? 2000 + +num[3]! : +num[3]!;
      if (a > 12) [d, m] = [a, b];
      else if (b > 12) [m, d] = [a, b];
      else if (hasLatin && !/[α-ω]/.test(f)) [m, d] = [a, b];
      else [d, m] = [a, b];
    }
  }

  if (y === null || m === null || d === null) return null;
  if (y < 1990 || y > 2100) return null;
  const opts = offset !== null ? { zone: offset } : { zone };
  const dt = DateTime.fromObject({ year: y, month: m, day: d, hour: time?.h ?? 0, minute: time?.min ?? 0, second: time?.s ?? 0 }, opts);
  if (!dt.isValid) return null;
  return dt.toUTC().toISO({ suppressMilliseconds: true });
}

/** RFC 5322-ish ("Wed, 9 Sep 2026 10:02:00 +0300", "… GMT") — only when an explicit zone is present. */
function parseRfcLike(s: string): string | null {
  const m = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|gmt|ut|utc|z)\b/i.exec(s);
  if (!m) return null;
  const month = MONTHS.get(m[2]!.toLowerCase())!;
  const zoneTok = m[7]!.toLowerCase();
  const zone = /^[+-]\d{4}$/.test(zoneTok) ? `UTC${zoneTok.slice(0, 3)}:${zoneTok.slice(3)}` : "UTC";
  const dt = DateTime.fromObject({ year: +m[3]!, month, day: +m[1]!, hour: +m[4]!, minute: +m[5]!, second: m[6] ? +m[6] : 0 }, { zone });
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null;
}

/** Numeric dates (d.m.y, d/m/y, d-m-y, ISO y-m-d, y.m.d): blanked out before the time is searched. */
const NUMERIC_DATES = /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b|\b\d{4}[/.-]\d{1,2}[/.-]\d{1,2}\b/g;

function findTime(f: string): { h: number; min: number; s: number } | null {
  // Never a piece of a longer dotted/slashed number ("09.09.2026", "1.250.00").
  const t = /(?<![\d.\/-])\b(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?![.\/-]?\d)(?:\s*(am|pm|a\.m\.|p\.m\.|π\.?\s?μ\.?|μ\.?\s?μ\.?)(?![α-ω]))?/.exec(f);
  if (!t) return null;
  let h = +t[1]!;
  const min = +t[2]!;
  const s = t[3] ? +t[3] : 0;
  if (h > 23 || min > 59 || s > 59) return null;
  const mer = (t[4] ?? "").replace(/[.\s]/g, "");
  const pm = mer === "pm" || mer === "μμ";
  const am = mer === "am" || mer === "πμ";
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  return { h, min, s };
}

/** "GMT+3", "UTC+02:00", "10:02 +0300"; bare "GMT"/"UTC" → UTC. */
function findOffset(f: string): string | null {
  const named = /\b(?:gmt|utc)\s?([+-])(\d{1,2})(?::?(\d{2}))?/.exec(f);
  if (named) return `UTC${named[1]}${named[2]!.padStart(2, "0")}:${named[3] ?? "00"}`;
  const trailing = /\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\s*([+-])(\d{2}):?(\d{2})\b/.exec(f);
  if (trailing) return `UTC${trailing[1]}${trailing[2]}:${trailing[3]}`;
  if (/\b(?:gmt|utc)\b/.test(f)) return "UTC";
  return null;
}

/** Lower-case, strip Greek tonos/dialytika, ς→σ. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u{0300}-\u{036f}]/gu, "").normalize("NFC").toLowerCase().replace(/ς/g, "σ");
}

const MONTHS = new Map<string, number>();
const addMonths = (names: string[][]) => names.forEach((forms, i) => forms.forEach((f) => MONTHS.set(f, i + 1)));
addMonths([
  ["jan", "january"], ["feb", "february"], ["mar", "march"], ["apr", "april"], ["may"], ["jun", "june"], ["jul", "july"],
  ["aug", "august"], ["sep", "sept", "september"], ["oct", "october"], ["nov", "november"], ["dec", "december"],
]);
addMonths([
  ["ιαν", "ιανουαριου", "ιανουαριοσ"],
  ["φεβ", "φεβρ", "φεβρουαριου", "φεβρουαριοσ"],
  ["μαρ", "μαρτ", "μαρτιου", "μαρτιοσ"],
  ["απρ", "απριλ", "απριλιου", "απριλιοσ"],
  ["μαι", "μαιου", "μαιοσ", "μαη"],
  ["ιουν", "ιουνιου", "ιουνιοσ"],
  ["ιουλ", "ιουλιου", "ιουλιοσ"],
  ["αυγ", "αυγουστου", "αυγουστοσ"],
  ["σεπ", "σεπτ", "σεπτεμβριου", "σεπτεμβριοσ"],
  ["οκτ", "οκτωβριου", "οκτωβριοσ"],
  ["νοε", "νοεμ", "νοεμβριου", "νοεμβριοσ"],
  ["δεκ", "δεκεμβριου", "δεκεμβριοσ"],
]);
