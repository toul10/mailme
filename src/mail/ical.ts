import { DateTime } from "luxon";
import type { CalendarInfo } from "../domain/types.js";

/** One content line: NAME;PARAM=V;PARAM2="x":value (RFC 5545 §3.1). */
export interface IcalLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Unfold (CRLF + space/tab continuation) and split into content lines. Tolerates bare LF and junk lines. */
export function parseIcalLines(text: string): IcalLine[] {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  const out: IcalLine[] = [];
  for (const line of unfolded.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseContentLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseContentLine(line: string): IcalLine | null {
  // Walk the line so quoted parameter values may contain ':' and ';'.
  let i = 0;
  const nameMatch = /^[A-Za-z0-9-]+/.exec(line);
  if (!nameMatch) return null;
  const name = nameMatch[0].toUpperCase();
  i = name.length;
  const params: Record<string, string> = {};
  while (i < line.length && line[i] === ";") {
    i++;
    const eq = line.indexOf("=", i);
    if (eq < 0) return null;
    const key = line.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let val = "";
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      if (close < 0) return null;
      val = line.slice(i + 1, close);
      i = close + 1;
      // multi-valued "a","b" → keep the first
      while (line[i] === ",") {
        const next = line[i + 1] === '"' ? line.indexOf('"', i + 2) + 1 : nextDelim(line, i + 1);
        i = next > 0 ? next : line.length;
      }
    } else {
      const end = nextDelim(line, i);
      val = line.slice(i, end);
      i = end;
    }
    params[key] = val;
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

function nextDelim(line: string, from: number): number {
  for (let j = from; j < line.length; j++) if (line[j] === ";" || line[j] === ":") return j;
  return line.length;
}

/** RFC 5545 TEXT unescaping. */
function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();
}

/**
 * Structured summary of the first VEVENT plus the VCALENDAR METHOD. Outlook TZIDs ("GTB Standard Time")
 * are mapped to IANA; unknown TZIDs fall back to `defaultZone`.
 */
export function parseICalendar(text: string, defaultZone = "Europe/Athens", fallbackMethod: string | null = null): CalendarInfo | null {
  const lines = parseIcalLines(text);
  if (!lines.some((l) => l.name === "BEGIN" && l.value.trim().toUpperCase() === "VCALENDAR")) return null;
  let method: string | null = null;
  let depth: string[] = [];
  let inEvent = false;
  let seenEvent = false;
  const ev: Partial<Record<"SUMMARY" | "DTSTART" | "DTEND" | "ORGANIZER" | "LOCATION", IcalLine>> = {};
  for (const l of lines) {
    if (l.name === "BEGIN") {
      const comp = l.value.trim().toUpperCase();
      depth.push(comp);
      if (comp === "VEVENT" && !seenEvent) inEvent = true;
      continue;
    }
    if (l.name === "END") {
      const comp = l.value.trim().toUpperCase();
      const idx = depth.lastIndexOf(comp);
      if (idx >= 0) depth = depth.slice(0, idx);
      if (comp === "VEVENT" && inEvent) {
        inEvent = false;
        seenEvent = true;
      }
      continue;
    }
    if (l.name === "METHOD" && depth.length === 1 && depth[0] === "VCALENDAR") method = l.value.trim().toUpperCase();
    if (inEvent && depth[depth.length - 1] === "VEVENT") {
      if (l.name === "SUMMARY" || l.name === "DTSTART" || l.name === "DTEND" || l.name === "ORGANIZER" || l.name === "LOCATION") {
        ev[l.name] ??= l;
      }
    }
  }
  const start = ev.DTSTART ? icalDate(ev.DTSTART, defaultZone) : null;
  const end = ev.DTEND ? icalDate(ev.DTEND, defaultZone) : null;
  return {
    method: method ?? fallbackMethod?.toUpperCase() ?? "PUBLISH",
    summary: ev.SUMMARY ? unescapeText(ev.SUMMARY.value) || null : null,
    start: start?.iso ?? null,
    end: end?.iso ?? null,
    tzid: ev.DTSTART?.params.TZID ?? null,
    organizer: ev.ORGANIZER ? organizerOf(ev.ORGANIZER) : null,
    location: ev.LOCATION ? unescapeText(ev.LOCATION.value) || null : null,
  };
}

function organizerOf(l: IcalLine): string | null {
  const mail = /^mailto:(.+)$/i.exec(l.value.trim());
  if (mail) return mail[1]!.trim().toLowerCase();
  const cn = l.params.CN?.trim();
  return cn || l.value.trim() || null;
}

/** DATE → "YYYY-MM-DD"; DATE-TIME → ISO instant (UTC). Floating times use TZID or the default zone. */
function icalDate(l: IcalLine, defaultZone: string): { iso: string } | null {
  const v = l.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || l.params.VALUE?.toUpperCase() === "DATE") {
    if (!dateOnly) return null;
    return { iso: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const zone = m[7] ? "UTC" : resolveTzid(l.params.TZID, defaultZone);
  const dt = DateTime.fromObject(
    { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: m[6] ? +m[6] : 0 },
    { zone },
  );
  return dt.isValid ? { iso: dt.toUTC().toISO({ suppressMilliseconds: true })! } : null;
}

/** IANA zone for an iCalendar TZID (IANA names, "/"-prefixed IANA, Windows names). */
export function resolveTzid(tzid: string | undefined, defaultZone: string): string {
  if (!tzid) return defaultZone;
  const t = tzid.trim().replace(/^\/+/, "").replace(/^"|"$/g, "");
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  if (DateTime.local().setZone(t).isValid) return t;
  // "(UTC+02:00) Athens, Bucharest" style
  const off = /UTC\s?([+-])(\d{2}):?(\d{2})/i.exec(t);
  if (off) return `UTC${off[1]}${off[2]}:${off[3]}`;
  return defaultZone;
}

/** Common Windows time-zone ids (CLDR windowsZones, territory 001). */
const WINDOWS_ZONES: Record<string, string> = {
  "GTB Standard Time": "Europe/Athens",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem",
  "Egypt Standard Time": "Africa/Cairo",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Russian Standard Time": "Europe/Moscow",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "Arabian Standard Time": "Asia/Dubai",
  "Arab Standard Time": "Asia/Riyadh",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Atlantic Standard Time": "America/Halifax",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Cyprus Standard Time": "Asia/Nicosia",
};
