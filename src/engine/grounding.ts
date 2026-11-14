import type { Evidence } from "../ai/schema.js";
import type { Attachment, CalendarInfo, Segment } from "../domain/types.js";
import { foldForMatch, tokenContainment } from "../lib/text.js";

export interface GroundingResult {
  status: "exact" | "fuzzy" | "missing" | "wrong_source";
  /** Actual source kind where the quote was found (may differ from claimed). */
  foundIn: "NEW" | "FORWARDED" | "QUOTED" | "SUBJECT" | "ATTACHMENT_NAME" | "CALENDAR" | null;
  score: number;
}

type SourceKind = NonNullable<GroundingResult["foundIn"]>;

/** Token-set containment at or above this is a fuzzy match (→ review). */
export const FUZZY_THRESHOLD = 0.9;

/**
 * Normalized containment in the claimed source; fuzzy (token-set ≥ 0.9) → review.
 *
 * Precedence (first hit wins):
 * 1. exact match in the claimed source kind → `exact` (any segment of that kind: a wrong `segment_id` is tolerated);
 * 2. exact match in another source → `wrong_source` + `foundIn`;
 * 3. token containment ≥ 0.9 in the claimed kind → `fuzzy` (never for ATTACHMENT_NAME: filenames must match exactly);
 * 4. token containment ≥ 0.9 elsewhere → `wrong_source`;
 * 5. otherwise `missing` (score = best containment seen).
 *
 * "Exact" = contiguous, word-bounded containment after {@link foldForMatch} (a quote never matches inside a longer word:
 * «ok» is not in «look»), or the same whole words in the same order once punctuation is ignored, so a dropped comma is
 * not a fuzzy match. Outer quote marks, ellipses and periods around the quote are ignored.
 * ATTACHMENT_NAME = the whole quote equals a filename (folded). CALENDAR = the invite's summary or location.
 * A quote copied with the prompt's entities (&quot; &lt; &gt;, e.g. an attachment name from an attribute) is also
 * tried decoded; the better result wins.
 */
export function checkEvidence(ev: Evidence, msg: { segments: Segment[]; attachments: Attachment[]; subject: string; calendar: CalendarInfo | null }): GroundingResult {
  const sources = collectSources(msg);
  const result = checkQuote(ev.source, ev.quote ?? "", sources);
  const decoded = decodePromptEntities(ev.quote ?? "");
  if (decoded === (ev.quote ?? "") || result.status === "exact") return result;
  const alt = checkQuote(ev.source, decoded, sources);
  return RANK[alt.status] > RANK[result.status] || (RANK[alt.status] === RANK[result.status] && alt.score > result.score) ? alt : result;
}

const RANK: Record<GroundingResult["status"], number> = { exact: 3, fuzzy: 2, wrong_source: 1, missing: 0 };

/**
 * Undo the entities the prompt renders email text with (src/ai/prompt.ts escapeText/escapeAttr). `&amp;` is not one
 * of them (`&` stays literal in the prompt), so it is left alone.
 */
function decodePromptEntities(quote: string): string {
  return quote.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function checkQuote(claimedKind: Evidence["source"], quote: string, sources: Source[]): GroundingResult {
  const needle = normalizeQuote(quote);
  if (!needle) return { status: "missing", foundIn: null, score: 0 };
  const needleLoose = looseFold(needle);

  const claimed = sources.filter((s) => s.kind === claimedKind);
  const others = sources.filter((s) => s.kind !== claimedKind);

  const exact = (s: Source): boolean =>
    s.kind === "ATTACHMENT_NAME" ? s.folded === needle : containsBounded(s.folded, needle) || (needleLoose.length > 0 && s.loose.includes(` ${needleLoose} `));

  if (claimed.some(exact)) return { status: "exact", foundIn: claimedKind, score: 1 };
  const elsewhere = others.find(exact);
  if (elsewhere) return { status: "wrong_source", foundIn: elsewhere.kind, score: 1 };

  const fuzzy = (list: Source[]): { src: Source | null; score: number } => {
    let best: { src: Source | null; score: number } = { src: null, score: 0 };
    for (const s of list) {
      if (s.kind === "ATTACHMENT_NAME") continue;
      const score = tokenContainment(quote, s.raw);
      if (score > best.score) best = { src: s, score };
    }
    return best;
  };
  const inClaimed = fuzzy(claimed);
  if (inClaimed.src && inClaimed.score >= FUZZY_THRESHOLD) return { status: "fuzzy", foundIn: claimedKind, score: inClaimed.score };
  const inOthers = fuzzy(others);
  if (inOthers.src && inOthers.score >= FUZZY_THRESHOLD) return { status: "wrong_source", foundIn: inOthers.src.kind, score: inOthers.score };

  return { status: "missing", foundIn: null, score: Math.max(inClaimed.score, inOthers.score) };
}

/** Canonical quote form: {@link foldForMatch} without surrounding quote marks, ellipses or periods. Shared with negative-example matching. */
export function normalizeQuote(quote: string): string {
  return foldForMatch(quote ?? "")
    .replace(/^["'\s.…]+|(?<!["'\s.…])["'\s.…]+$/g, "")
    .trim();
}

// ── internals ────────────────────────────────────────────────────────────────

interface Source {
  kind: SourceKind;
  raw: string;
  folded: string;
  loose: string;
}

function source(kind: SourceKind, raw: string): Source {
  const folded = kind === "ATTACHMENT_NAME" ? normalizeQuote(raw) : foldForMatch(raw);
  return { kind, raw, folded, loose: ` ${looseFold(raw)} ` };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * `needle` occurs in `hay` without being part of a longer word: at every edge where the needle starts/ends with a
 * letter or digit, the neighbouring character of `hay` must not be one. Every occurrence is tried.
 */
function containsBounded(hay: string, needle: string): boolean {
  const first = Array.from(needle)[0] ?? "";
  const last = Array.from(needle).at(-1) ?? "";
  const checkStart = WORD_CHAR.test(first);
  const checkEnd = WORD_CHAR.test(last);
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? Array.from(hay.slice(Math.max(0, i - 2), i)).at(-1) ?? "" : "";
    const after = Array.from(hay.slice(i + needle.length, i + needle.length + 2))[0] ?? "";
    if (checkStart && WORD_CHAR.test(before)) continue;
    if (checkEnd && WORD_CHAR.test(after)) continue;
    return true;
  }
  return false;
}

/** Letters and digits only, single-spaced: the punctuation-insensitive form for the second exact test. */
function looseFold(input: string): string {
  return foldForMatch(input)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function collectSources(msg: { segments: Segment[]; attachments: Attachment[]; subject: string; calendar: CalendarInfo | null }): Source[] {
  const out: Source[] = [];
  for (const kind of ["NEW", "FORWARDED", "QUOTED"] as const) {
    for (const seg of msg.segments) if (seg.kind === kind && seg.text) out.push(source(kind, seg.text));
  }
  if (msg.subject) out.push(source("SUBJECT", msg.subject));
  for (const a of msg.attachments) if (a.filename) out.push(source("ATTACHMENT_NAME", a.filename));
  if (msg.calendar?.summary) out.push(source("CALENDAR", msg.calendar.summary));
  if (msg.calendar?.location) out.push(source("CALENDAR", msg.calendar.location));
  return out;
}
