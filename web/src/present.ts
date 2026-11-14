/**
 * How tasks read on screen: the company once, the title without repeating it,
 * one time phrase instead of a pile of chips, people as “you” / their name, the greeting by first name, and the
 * quotes highlighted where they were written. Pure functions (tested under vitest in node).
 * The AI's questions live in triage.ts.
 */
import type { EvidenceView, PersonRef, TaskDetail, TaskEventView, TaskListItem } from "../../src/server/api-types.js";
import { MONTHS_LONG, WEEKDAYS_LONG, addDays, daysBetween, formatDateShort, formatDateTime, isoDateToUtc, plural, zonedParts } from "./format.js";
import { STATUS_LABELS, isOpen } from "./labels.js";

const DEFAULT_ZONE = "Europe/Athens";

type Item = Pick<TaskListItem, "title" | "company" | "counterpartyName" | "counterpartyAddress" | "nextAction">;

/** Lower case, no accents, Greek final sigma folded (names and mail text may be Greek), punctuation → single spaces. */
export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** File names look like domains (“Invoice.pdf”): never treat them as the sender's address. */
const FILE_NAME = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf|odt|ods|zip|rar|7z|jpe?g|png|gif|heic|tiff?|bmp|msg|eml|ics|xml|json|html?)$/i;
const DOMAIN = /^(?:www\.)?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:gr|com|eu|net|org|info|biz|io|co|[a-z]{2})$/iu;

function looksLikeAddress(head: string): boolean {
  const h = head.trim();
  if (FILE_NAME.test(h)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h) || DOMAIN.test(h);
}

/**
 * Title without a leading "<Company> — " (older AI titles repeated the company the row already shows). The head is
 * dropped only when it is that company or person as whole words, or an e-mail address / domain — never a file name
 * or a mere prefix (“ABC meeting — …” stays whole under company “AB”).
 */
export function displayTitle(item: Pick<Item, "title" | "company" | "counterpartyName">): string {
  const title = item.title.trim();
  const m = /^(.{1,80}?)\s+[—–-]\s+(.+)$/u.exec(title);
  if (!m) return title;
  const [, head, rest] = m as unknown as [string, string, string];
  const h = fold(head);
  const who = [item.company, item.counterpartyName]
    .filter((v): v is string => Boolean(v?.trim()))
    .map(fold)
    .filter((w) => w.length > 0);
  const sameName = (w: string) => w === h || (Math.min(w.length, h.length) >= 3 && (w.startsWith(`${h} `) || h.startsWith(`${w} `)));
  if ((h && who.some(sameName)) || looksLikeAddress(head)) return rest.trim();
  return title;
}

/** Who the task is with, shown once above the title: company, else the person, else their address. */
export function whoLabel(item: Pick<Item, "company" | "counterpartyName" | "counterpartyAddress">): string | null {
  return item.company?.trim() || item.counterpartyName?.trim() || item.counterpartyAddress?.trim() || null;
}

/** The next step, unless it only repeats the title or the company (then the title says it all). */
export function usefulNextAction(item: Item): string | null {
  const next = item.nextAction?.trim();
  if (!next) return null;
  const n = fold(next);
  const title = fold(displayTitle(item));
  const who = fold(whoLabel(item) ?? "");
  const stripped = who ? n.replace(who, "").trim() : n;
  const words = (s: string) => new Set(s.split(" ").filter((w) => w.length > 2));
  const nw = words(stripped);
  if (nw.size === 0) return null;
  const tw = words(title);
  let shared = 0;
  for (const w of nw) if ([...tw].some((t) => t.startsWith(w.slice(0, 5)) || w.startsWith(t.slice(0, 5)))) shared++;
  // "Send a quote to ABC" under "Send quote" adds nothing (the 5-letter stems also match inflected Greek words).
  if (shared / nw.size >= 0.5 && nw.size <= 3) return null;
  return next;
}

/** A colleague's task: “Handled by Nikos Pappas”. */
export function ownerText(item: Pick<TaskListItem, "ownerKind" | "ownerLabel">): string | null {
  if (item.ownerKind !== "INTERNAL") return null;
  const who = item.ownerLabel?.trim();
  return who ? `Handled by ${who}` : "Handled by a colleague";
}

/** “you”, the person's name, or their address. */
export function personLabel(p: PersonRef | null | undefined): string | null {
  if (!p) return null;
  if (p.isOwner) return "you";
  return p.name?.trim() || p.address?.trim() || null;
}

/** The start of a sentence about who wrote something: “You wrote”, “<name> wrote”, or “An email” without an author. */
export function authorSentenceStart(p: PersonRef | null | undefined): string {
  if (!p) return "An email";
  if (p.isOwner) return "You wrote";
  const name = p.name?.trim() || p.address?.trim() || "Someone";
  return `${name} wrote`;
}

/** “Anna Rafailidou, Fri 18 Sep” / “you, Mon 21 Sep”. */
export function attribution(ev: Pick<EvidenceView, "author" | "at">, zone: string, today: string): string | null {
  const who = personLabel(ev.author);
  const when = ev.at ? shortWhen(ev.at, zone, today) : null;
  return [who, when].filter(Boolean).join(", ") || null;
}

/** “today 09:12”, “yesterday 16:40”, “Fri 18 Sep” — lower case, for use inside a phrase. */
export function shortWhen(iso: string, zone: string, today: string): string {
  const p = zonedParts(iso, zone);
  if (!p) return "";
  if (p.date === today) return `today ${p.time}`;
  if (p.date === addDays(today, -1)) return `yesterday ${p.time}`;
  return formatDateShort(p.date, today);
}

/**
 * Snoozed exactly as the server counts it (snoozedSql in src/server/queries.ts): a snooze date after today, or
 * “until they reply” with no fallback date. A passed fallback date wakes an until-reply snooze.
 */
export function isSnoozed(item: Pick<TaskListItem, "snoozedUntil" | "snoozeMode">, today: string): boolean {
  if (item.snoozedUntil) return item.snoozedUntil.slice(0, 10) > today;
  return item.snoozeMode === "until_reply";
}

export type TimeTone = "overdue" | "today" | "soon" | "waiting" | "calm" | "done";

export interface TimePhrase {
  text: string;
  tone: TimeTone;
  /** Longer explanation for title/aria. */
  title: string;
}

type TimeInput = Pick<TaskListItem, "status" | "dueDate" | "duePhrase" | "overdue" | "expectReplyBy" | "businessDaysWaiting" | "snoozedUntil" | "snoozeMode"> & {
  lastMessage?: TaskListItem["lastMessage"];
};

/** One time phrase per row, at the right edge, carrying the status colour (principle 3). */
export function timePhrase(item: TimeInput, today: string, zone: string = DEFAULT_ZONE): TimePhrase | null {
  if (item.status === "COMPLETED") return { text: "done", tone: "done", title: "Done" };
  if (item.status === "DISMISSED") return { text: "removed", tone: "done", title: "Removed" };
  if (isSnoozed(item, today)) {
    if (item.snoozeMode === "until_reply") return { text: "until they reply", tone: "calm", title: "Snoozed until they reply" };
    return { text: `snoozed until ${formatDateShort(item.snoozedUntil!.slice(0, 10), today)}`, tone: "calm", title: "Snoozed" };
  }
  if (item.dueDate && isoDateToUtc(item.dueDate) !== null) {
    const diff = daysBetween(today, item.dueDate);
    const label = formatDateShort(item.dueDate, today);
    if (item.overdue || diff < 0) {
      const late = Math.max(1, -diff);
      return { text: `${plural(late, "day", "days")} overdue`, tone: "overdue", title: `It was due ${label}` };
    }
    if (diff === 0) return { text: "today", tone: "today", title: `Due today, ${label}` };
    if (diff === 1) return { text: "tomorrow", tone: "soon", title: `Due tomorrow, ${label}` };
    return { text: `by ${label}`, tone: diff <= 3 ? "soon" : "calm", title: `Due ${label}` };
  }
  if (item.status === "WAITING_FOR_OTHER") {
    // Follow-up from the expected-reply day itself (today.ts compareWaiting and the digest use <= today).
    const late = item.expectReplyBy !== null && isoDateToUtc(item.expectReplyBy) !== null && daysBetween(today, item.expectReplyBy) <= 0;
    const tone: TimeTone = late ? "overdue" : "waiting";
    const title = late ? "No reply yet — time to follow up" : "Waiting for a reply";
    const d = item.businessDaysWaiting;
    if (d !== null && d > 0) return { text: plural(d, "business day", "business days"), tone, title };
    // 0 business days can still be a weekend or more: say since when (the last message is the best proxy).
    const since = item.lastMessage ? (zonedParts(item.lastMessage.at, zone)?.date ?? null) : null;
    if (since && since < today) return { text: `since ${formatDateShort(since, today)}`, tone, title };
    return { text: "since today", tone, title };
  }
  if (item.duePhrase) return { text: item.duePhrase, tone: "calm", title: "Vague due date, as written" };
  return null;
}

/** Status in the user's words (not the system's) — one source with labels.ts. */
export const STATUS_WORDS = STATUS_LABELS;

// ── Greeting ────────────────────────────────────────────────────────────────

/** "Good morning" before 12:00, "Good afternoon" before 18:00, then "Good evening", by the user's local hour. */
export function greeting(nowIso: string, zone: string): string {
  const p = zonedParts(nowIso, zone);
  const hour = p ? Number(p.time.slice(0, 2)) : 9;
  if (hour < 12) return "Good morning";
  return hour < 18 ? "Good afternoon" : "Good evening";
}

/** First name for the greeting (the part before the first space), used as written. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** “Good morning, Maria.” — or just “Good morning.” without a usable name. */
export function greetingLine(name: string, nowIso: string, zone: string): string {
  const hello = greeting(nowIso, zone);
  const who = firstName(name);
  return who ? `${hello}, ${who}.` : `${hello}.`;
}

function joinAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The summary sentence under the greeting: “Today you have 3 to do, 1 promise to keep, you're waiting for 2 replies
 * and the AI has 1 question.” Each number is the count of the section it names.
 */
export function daySentence(c: { doNow: number; promised: number; waiting: number; triage: number }): string {
  const have: string[] = [];
  if (c.doNow > 0) have.push(`${c.doNow} to do`);
  if (c.promised > 0) have.push(`${plural(c.promised, "promise", "promises")} to keep`);
  const parts = have.length ? [`you have ${have[0]}`, ...have.slice(1)] : [];
  if (c.waiting > 0) parts.push(`you're waiting for ${plural(c.waiting, "reply", "replies")}`);
  if (c.triage > 0) parts.push(`the AI has ${plural(c.triage, "question", "questions")}`);
  if (parts.length === 0) return "No tasks right now. Anything new that comes in by email will show up here.";
  return `Today ${joinAnd(parts)}.`;
}

/** “Thursday 24 September”: the date above the greeting, with the month in full. */
export function longDate(iso: string): string {
  const ms = isoDateToUtc(iso);
  if (ms === null) return iso;
  const d = new Date(ms);
  return `${WEEKDAYS_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]}`;
}

// ── Task page ───────────────────────────────────────────────────────────────

/** Evidence of a task event for the quote component (older API responses carry only quote/source). */
export function eventEvidence(e: TaskEventView): EvidenceView | null {
  if (!e.evidenceQuote) return null;
  return { quote: e.evidenceQuote, source: e.evidenceSource, messageId: e.messageId ?? null, author: e.author ?? null, at: e.messageAt ?? null };
}

export interface Fact {
  label: string;
  value: string;
}

type AgeInput = Pick<TaskDetail, "status" | "createdAt" | "closedAt" | "closedBy" | "evidence" | "originEvidence">;

/**
 * How long it has been open, counted from the request (the origin message, which for backfill is long before the
 * task row was created) — or, once closed, when and after how long it closed.
 */
export function ageFact(t: AgeInput, zone: string, today: string): Fact {
  const candidates = [t.createdAt, t.originEvidence?.at, t.evidence?.at].filter((v): v is string => Boolean(v) && !Number.isNaN(Date.parse(v!)));
  const start = candidates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a), t.createdAt);
  const startDate = zonedParts(start, zone)?.date ?? today;
  if (!isOpen(t.status)) {
    if (!t.closedAt) return { label: "Closed", value: "—" };
    const endDate = zonedParts(t.closedAt, zone)?.date ?? today;
    const n = daysBetween(startDate, endDate);
    const after = n <= 0 ? "the same day" : `after ${plural(n, "day", "days")}`;
    return { label: "Closed", value: `${shortWhen(t.closedAt, zone, today)}${t.closedBy === "ai" ? ", automatically by the AI" : ""}, ${after}` };
  }
  const n = daysBetween(startDate, today);
  const since = shortWhen(start, zone, today);
  return { label: "Open", value: n <= 0 ? `since ${since}` : `${plural(n, "day", "days")}, since ${since}` };
}

/**
 * The AI summary often just restates the quote (“Request from X: “…””) — then it adds nothing. Only a substantial
 * quote that makes up most of the summary hides it: a one-word subject never hides the quantities and deadline.
 */
export function repeatsQuote(summary: string, quote: string | null): boolean {
  if (!quote) return false;
  const q = fold(quote);
  if (q.length < 25) return false;
  const s = fold(summary);
  return s.includes(q.slice(0, 40)) && q.length >= 0.6 * s.length;
}

type QuoteSource = Pick<TaskDetail, "evidence" | "originEvidence" | "events">;

/**
 * Every evidence sentence of the task, to highlight inside the letters where it was written. Longest first, so the
 * full event quote wins over the list's 220-character clip of the same sentence.
 */
export function collectQuotes(task: QuoteSource): string[] {
  const out: string[] = [];
  const add = (q: string | null | undefined) => {
    const t = q?.replace(/…$/, "").trim();
    if (t && t.length >= 8 && !out.includes(t)) out.push(t);
  };
  add(task.evidence?.quote);
  add(task.originEvidence?.quote);
  for (const e of task.events) if (e.actor === "ai") add(e.evidenceQuote);
  return out.sort((a, b) => b.length - a.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * [start, end) ranges of the first occurrence of each quote in `text`, case-insensitive and tolerant of line breaks
 * between words. Matched on the original text (a lower-cased copy can change length, e.g. “İ”), non-overlapping,
 * in text order; earlier quotes win overlaps.
 */
export function highlightRanges(text: string, quotes: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const q of quotes) {
    const words = q.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let re: RegExp;
    try {
      re = new RegExp(words.map(escapeRe).join("\\s+"), "iu");
    } catch {
      continue;
    }
    const m = re.exec(text);
    if (!m) continue;
    const s = m.index;
    const e = s + m[0].length;
    if (!ranges.some(([a, b]) => s < b && e > a)) ranges.push([s, e]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The origin request is worth showing next to the state's sentence only when it is a different sentence. */
export function distinctOrigin(t: Pick<TaskListItem, "evidence" | "originEvidence">): EvidenceView | null {
  const o = t.originEvidence;
  if (!o?.quote.trim()) return null;
  if (t.evidence && fold(t.evidence.quote) === fold(o.quote)) return null;
  return o;
}

export { formatDateTime };
