import type { Segment, SegmentKind } from "../domain/types.js";
import { foldForMatch, trimSpaceTabEnd, truncate } from "../lib/text.js";
import { htmlToItems, type BodyItem } from "./html.js";
import { parseQuotedDate } from "./quoted-date.js";
import { redactSensitive } from "./redact.js";
import { isForwardSubject } from "./subject.js";

export interface SegmentOptions {
  /** Max chars kept per QUOTED segment (default 1500). NEW/FORWARDED are kept in full up to maxTotal. */
  quotedCap?: number;
  /** Max total chars across segments (default 20000). */
  maxTotal?: number;
  /** Message subject. When its outermost prefix is a forward (FW/FWD, the Greek ΠΡΘ) the first header block is FORWARDED. */
  subject?: string | null;
  /** Zone for quoted header dates written without an offset (default Europe/Athens). */
  zone?: string;
}

/**
 * Split a body into NEW / QUOTED / FORWARDED segments. HTML first (Outlook reply-header div,
 * blockquote, gmail_quote), text markers as fallback (≥3 consecutive EL/EN header-label lines, "On … wrote:",
 * "-----Original Message-----"). Removes signatures/disclaimers from NEW. Ids are "S1", "S2", … in order.
 * Segment text is redacted (IBAN / card / password patterns) before the caps are applied, so a
 * value cut by a cap can never escape the redactor.
 */
export function segmentBody(input: { textPlain: string | null; textHtml: string | null }, opts: SegmentOptions = {}): Segment[] {
  return segmentBodyDetailed(input, opts).segments;
}

/** segmentBody plus the number of redactions applied (for logs). */
export function segmentBodyDetailed(
  input: { textPlain: string | null; textHtml: string | null },
  opts: SegmentOptions = {},
): { segments: Segment[]; redactions: number } {
  const items = bodyItems(input);
  const raw = segmentItems(items, opts.subject ?? null, opts.zone ?? "Europe/Athens");
  return finalize(raw, opts.quotedCap ?? 1500, opts.maxTotal ?? 20000);
}

// ── Input → line items ───────────────────────────────────────────────────────

const MAX_TEXT = 1_000_000;
const MAX_LINES = 20_000;

function bodyItems(input: { textPlain: string | null; textHtml: string | null }): BodyItem[] {
  const plain = input.textPlain ? input.textPlain.slice(0, MAX_TEXT) : "";
  let items: BodyItem[] | null = null;
  if (input.textHtml && input.textHtml.trim()) {
    const fromHtml = htmlToItems(input.textHtml);
    const htmlChars = fromHtml.reduce((n, it) => n + (it.t === "text" ? it.text.trim().length : 0), 0);
    const plainChars = plain.replace(/\s+/g, "").length;
    // An image-only or broken HTML part: fall back to the text part.
    if (htmlChars > 0 && !(plainChars > 200 && htmlChars < plainChars * 0.2)) items = fromHtml;
  }
  items ??= textToItems(plain);
  // "> " prefixes inside text (and plain-text-in-HTML) add to the depth.
  return items.map((it) => {
    if (it.t !== "text") return it;
    const m = /^((?:[ \t]{0,3}>){1,50})[ \t]?/.exec(it.text);
    if (!m) return it;
    const extra = (m[1]!.match(/>/g) ?? []).length;
    return { t: "text", text: it.text.slice(m[0].length), depth: it.depth + extra };
  });
}

function textToItems(text: string): BodyItem[] {
  if (!text) return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .slice(0, MAX_LINES)
    .map((line) => ({ t: "text", text: trimSpaceTabEnd(line), depth: 0 }) as BodyItem);
}

// ── Header-block / marker / attribution detection ───────────────────────────

type Label = "from" | "date" | "to" | "cc" | "bcc" | "subject" | "attach" | "importance" | "replyto";

const LABEL_WORDS: Array<[Label, string[]]> = [
  ["from", ["from", "από", "απο", "αποστολέας", "αποστολεας", "de", "von", "van", "da"]],
  ["date", ["sent", "date", "στάλθηκε", "σταλθηκε", "ημερομηνία", "ημερομηνια", "ημ/νία", "ημ/νια", "εστάλη", "εσταλη", "αποστολή", "αποστολη", "sent on", "στάλθηκε στις", "envoyé", "gesendet", "enviado", "data", "datum"]],
  ["to", ["to", "προς", "παραλήπτης", "παραληπτης", "an", "à", "para", "aan"]],
  ["cc", ["cc", "κοιν.", "κοιν", "κοινοποίηση", "κοινοποιηση", "kopie", "cci"]],
  ["bcc", ["bcc", "κρυφή κοιν.", "κρυφη κοιν.", "κρυφή κοιν", "ιδιαίτερη κοιν.", "ιδιαιτερη κοιν."]],
  ["subject", ["subject", "θέμα", "θεμα", "betreff", "objet", "asunto", "oggetto", "onderwerp"]],
  ["attach", ["attachments", "attachment", "συνημμένα", "συνημμενα", "συνημμένο", "συνημμενο", "anlagen", "pièces jointes"]],
  ["importance", ["importance", "σπουδαιότητα", "σπουδαιοτητα", "priority", "προτεραιότητα", "προτεραιοτητα"]],
  ["replyto", ["reply-to", "reply to", "απάντηση σε", "απαντηση σε"]],
];
/** Label word (lower case, single spaces) → label. Exported for the tests. */
export const LABELS = new Map<string, Label>();
for (const [label, words] of LABEL_WORDS) for (const w of words) LABELS.set(w, label);

/** Up to two "*" (Markdown bold) off the start of `s`, or off its end. */
function stripStars(s: string, side: "start" | "end"): string {
  let n = 0;
  if (side === "start") {
    while (n < 2 && s[n] === "*") n++;
    return s.slice(n);
  }
  while (n < 2 && s[s.length - 1 - n] === "*") n++;
  return s.slice(0, s.length - n);
}

/**
 * A header-style line, "From: X" or "**Θέμα:** Y": the label and its value. Up to two "*" around the label and after
 * the colon are allowed; the value is the rest of the line. Exported for the tests.
 *
 * A scan, not one regex: `^\s*\*{0,2}\s*([^:：*]{1,32}?)\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(.*)$` backtracked so badly that a
 * line of a few hundred spaces took seconds. The result is the same (the tests check it against that regex).
 */
export function matchLabel(text: string): { label: Label; value: string } | null {
  if (text.length > 2000) return null;
  const colon = text.search(/[:：]/u); // the label can't contain a colon, so it ends at the first one
  if (colon < 0) return null;
  const core = stripStars(stripStars(text.slice(0, colon).trimStart(), "start").trimStart().trimEnd(), "end").trimEnd();
  if (core.length === 0 || core.length > 32 || core.includes("*")) return null;
  const label = LABELS.get(core.toLowerCase().replace(/\s+/g, " "));
  if (!label) return null;
  const value = stripStars(text.slice(colon + 1).trimStart(), "start").trimStart();
  if (/[\n\r\u2028\u2029]/u.test(value)) return null; // the value is the rest of ONE line
  return { label, value: value.replace(/(?<!\*)\*+$/, "").trim() };
}

const INLINE_LABEL = /(?:^|\s)\*{0,2}(from|sent|date|to|cc|subject|από|στάλθηκε|ημερομηνία|προς|κοιν\.|θέμα)\*{0,2}\s*:/giu;

/** "From: X Sent: Y To: Z Subject: W" collapsed onto one line (some mobile/text conversions). */
function matchInlineHeader(text: string): Partial<Record<Label, string>> | null {
  if (text.length > 1000 || !matchLabel(text)) return null;
  const hits = [...text.matchAll(INLINE_LABEL)];
  if (hits.length < 3) return null;
  const fields: Partial<Record<Label, string>> = {};
  hits.forEach((h, k) => {
    const label = LABELS.get(h[1]!.toLowerCase());
    const start = h.index! + h[0].length;
    const end = k + 1 < hits.length ? hits[k + 1]!.index! : text.length;
    if (label && fields[label] === undefined) fields[label] = text.slice(start, end).trim();
  });
  const distinct = Object.keys(fields).length;
  return distinct >= 3 && fields.from !== undefined ? fields : null;
}

type TextItem = Extract<BodyItem, { t: "text" }>;
const textAt = (items: BodyItem[], i: number): TextItem | null => {
  const it = items[i];
  return it && it.t === "text" ? it : null;
};

/** ≥ 3 distinct label lines (one of them From/Από) at the same depth, starting at i. */
function scanHeaderBlock(items: BodyItem[], i: number): { next: number; fields: Partial<Record<Label, string>> } | null {
  const first = textAt(items, i);
  if (!first || !matchLabel(first.text)) return null;
  const fields: Partial<Record<Label, string>> = {};
  let last: Label | null = null;
  let lastIdx = -1;
  let continuations = 0;
  for (let j = i; j < items.length && j - i < 16; j++) {
    const it = textAt(items, j);
    if (!it || it.depth !== first.depth) break;
    const l = matchLabel(it.text);
    if (l) {
      if (fields[l.label] !== undefined) break;
      fields[l.label] = l.value;
      last = l.label;
      lastIdx = j;
      continuations = 0;
      continue;
    }
    if (!it.text.trim()) break;
    // Wrapped To/Cc/From/attachment lists.
    if (last && (last === "to" || last === "cc" || last === "bcc" || last === "from" || last === "attach") && continuations < 3 && it.text.length < 300) {
      fields[last] = `${fields[last]} ${it.text.trim()}`;
      continuations++;
      lastIdx = j;
      continue;
    }
    break;
  }
  const distinct = Object.keys(fields).length;
  if (distinct < 3 || fields.from === undefined) return null;
  return { next: lastIdx + 1, fields };
}

const FORWARD_MARKER =
  /^[-_=*\s]*(forwarded message|forwarded e-?mail|begin forwarded message|προωθημένο μήνυμα|προωθημενο μηνυμα|αρχή προωθημένου μηνύματος|αρχη προωθημενου μηνυματος|μήνυμα που προωθήθηκε|weitergeleitete nachricht|message transféré|mensaje reenviado)\s*:?[-_=*\s]*$/iu;
const ORIGINAL_MARKER =
  /^[-_=*\s]*(original message|αρχικό μήνυμα|αρχικο μηνυμα|ursprüngliche nachricht|message d'origine|mensaje original|messaggio originale)\s*:?[-_=*\s]*$/iu;
const RULE_LINE = /^\s*_{10,}\s*$/;

const ATTR_START = /^(on|στις|την|τη|le|am|el|il|op)(?=[\s,])/iu;
// `\s*(?::\s*)?$`, not `\s*:?\s*$`: the same text, without two runs of spaces that backtrack against each other.
const ATTR_END = /(wrote|έγραψε|εγραψε|a écrit|schrieb|escribió|ha scritto|schreef)\s*(?::\s*)?$/iu;

interface BoundaryInfo {
  next: number;
  author: string | null;
  date: string | null;
  forward: boolean;
  /** Header block / marker (vs. attribution line): eligible for FW-subject → FORWARDED. */
  headerLike: boolean;
  type: "header" | "marker" | "attribution" | "none";
}

function skipBlank(items: BodyItem[], i: number, max = 2): number {
  let j = i;
  while (j < items.length && j - i < max) {
    const it = textAt(items, j);
    if (!it || it.text.trim()) break;
    j++;
  }
  return j;
}

function headerInfo(fields: Partial<Record<Label, string>>, zone: string) {
  return { author: cleanAuthor(fields.from ?? null), date: parseQuotedDate(fields.date ?? null, zone) };
}

/**
 * Text-only boundary starting at line i (marker + header block, header block, or attribution).
 * A bare header block (no marker line before it, not right after an HTML boundary) must carry a Sent/Date label:
 * «Από: ABC / Προς: Contoso / Θέμα: Παραγγελία» (From / To / Subject: Order) inside a message is an order or memo
 * layout, not quoted mail.
 */
function detectTextBoundary(items: BodyItem[], i: number, zone: string, bareNeedsDate = true): BoundaryInfo | null {
  const it = textAt(items, i);
  if (!it) return null;
  const t = it.text.trim();
  if (!t || t.length > 400) return null;

  const fwd = FORWARD_MARKER.test(t);
  if (fwd || ORIGINAL_MARKER.test(t) || RULE_LINE.test(t)) {
    const j = skipBlank(items, i + 1);
    const hb = scanHeaderBlock(items, j);
    if (hb) return { next: hb.next, ...headerInfo(hb.fields, zone), forward: fwd, headerLike: true, type: "marker" };
    const inl = textAt(items, j) ? matchInlineHeader(textAt(items, j)!.text) : null;
    if (inl) return { next: j + 1, ...headerInfo(inl, zone), forward: fwd, headerLike: true, type: "marker" };
    if (RULE_LINE.test(t)) return null; // a plain horizontal rule
    return { next: i + 1, author: null, date: null, forward: fwd, headerLike: true, type: "marker" };
  }

  const dated = (fields: Partial<Record<Label, string>>) => !bareNeedsDate || fields.date !== undefined;
  const hb = scanHeaderBlock(items, i);
  if (hb && dated(hb.fields)) return { next: hb.next, ...headerInfo(hb.fields, zone), forward: false, headerLike: true, type: "header" };
  const inl = matchInlineHeader(t);
  if (inl && dated(inl)) return { next: i + 1, ...headerInfo(inl, zone), forward: false, headerLike: true, type: "header" };

  return detectAttribution(items, i, zone);
}

/** "On … wrote:" / "Στις … έγραψε:" possibly wrapped over up to 3 lines. */
function detectAttribution(items: BodyItem[], i: number, zone: string): BoundaryInfo | null {
  const first = textAt(items, i);
  if (!first) return null;
  const starts = ATTR_START.test(first.text.trim());
  let joined = "";
  for (let k = 0; k < 3; k++) {
    const it = textAt(items, i + k);
    if (!it || it.depth !== first.depth || (k > 0 && !it.text.trim())) break;
    joined = (joined ? joined + " " : "") + it.text.trim();
    if (joined.length > 400) break;
    if (ATTR_END.test(joined)) {
      if (!starts) {
        // "John Smith wrote:" without a leading "On": only when quoted lines follow.
        if (k > 0 || joined.length > 120) return null;
        const nd = nextNonBlankDepth(items, i + 1);
        if (nd === null || nd <= first.depth) return null;
      }
      const { author, date } = parseAttribution(joined, zone);
      return { next: i + k + 1, author, date, forward: false, headerLike: false, type: "attribution" };
    }
    if (!starts) break;
  }
  return null;
}

function parseAttribution(s: string, zone: string): { author: string | null; date: string | null } {
  const body = s.replace(ATTR_START, "").replace(ATTR_END, "").trim().replace(/,$/, "").trim();
  // Not inside a dotted/slashed date: "09.09.2026" has no time in it.
  const timeRe = /(?<![\d.\/-])\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?![.\/-]?\d)(?:\s*(?:am|pm|a\.m\.|p\.m\.|π\.?\s?μ\.?|μ\.?\s?μ\.?)(?![\p{L}]))?/giu;
  let splitAt = -1;
  for (const m of body.matchAll(timeRe)) splitAt = m.index! + m[0].length;
  if (splitAt < 0) {
    for (const m of body.matchAll(/\b(19|20)\d\d\b/g)) splitAt = m.index! + m[0].length;
  }
  if (splitAt < 0) splitAt = body.lastIndexOf(",");
  const datePart = splitAt > 0 ? body.slice(0, splitAt) : "";
  let author = splitAt >= 0 ? body.slice(splitAt) : body;
  author = author
    .replace(/^[\s,]+/, "")
    .replace(/^(ο\/η|η\/ο|ο χρήστης|η χρήστρια|ο|η|user)\s+/iu, "")
    .replace(/(?<![\s,])[\s,]+$/, "");
  return { author: cleanAuthor(author), date: parseQuotedDate(datePart, zone) };
}

function cleanAuthor(v: string | null): string | null {
  if (!v) return null;
  let a = v
    .replace(/\[mailto:([^\]]+)\]/gi, "<$1>")
    .replace(/<mailto:([^>]+)>/gi, "<$1>")
    .replace(/\s+/g, " ")
    .replace(/<\s+/g, "<")
    .replace(/\s+>/g, ">")
    .replace(/^["']|["']$/g, "")
    .trim();
  a = a.replace(/^"([^"]*)"\s*</, "$1 <");
  return a ? a.slice(0, 200) : null;
}

function nextNonBlankDepth(items: BodyItem[], i: number): number | null {
  for (let j = i; j < items.length && j - i < 5; j++) {
    const it = items[j]!;
    if (it.t !== "text") return null;
    if (it.text.trim()) return it.depth;
  }
  return null;
}

/** After an HTML boundary marker: consume an optional marker line + header block or attribution right after it. */
function scanAfterOpen(items: BodyItem[], i: number, zone: string): BoundaryInfo {
  const j = skipBlank(items, i, 3);
  const t = textAt(items, j);
  if (t) {
    // The HTML structure already marks a boundary here: a dateless header block is accepted.
    const b = detectTextBoundary(items, j, zone, false);
    if (b) return b;
  }
  return { next: i, author: null, date: null, forward: false, headerLike: true, type: "none" };
}

// ── State machine ────────────────────────────────────────────────────────────

interface Frame {
  kind: SegmentKind;
  mode: "base" | "rest" | "container" | "depth";
  baseDepth: number;
  author: string | null;
  date: string | null;
  sig: boolean;
}

interface RawSeg {
  kind: SegmentKind;
  author: string | null;
  date: string | null;
  lines: string[];
}

function segmentItems(items: BodyItem[], subject: string | null, zone: string): RawSeg[] {
  const fwdSubject = subject ? isForwardSubject(subject) : false;
  const stack: Frame[] = [{ kind: "NEW", mode: "base", baseDepth: 0, author: null, date: null, sig: false }];
  const top = () => stack[stack.length - 1]!;
  const segs: RawSeg[] = [];
  let cur: RawSeg = { kind: "NEW", author: null, date: null, lines: [] };
  segs.push(cur);
  let boundaries = 0;
  /** Last attributed quote frame left at each depth: an interleaved ">" block after an inline answer reuses its author. */
  const lastQuoteAt = new Map<number, Frame>();

  const startSeg = () => {
    const f = top();
    cur = { kind: f.kind, author: f.author, date: f.date, lines: [] };
    segs.push(cur);
  };
  const pushBoundary = (atDepth: number, baseDepth: number, mode: Frame["mode"], info: BoundaryInfo) => {
    // A new header at the same level replaces an open "rest" boundary (older message in the same history).
    // An empty one (OWA's `appendonsend` / Outlook's `_MailOriginal` right before the header div) is folded
    // into the new boundary instead of counting as a message of its own.
    let inherited: Frame | null = null;
    let first = true;
    while (stack.length > 1 && top().mode === "rest" && top().baseDepth >= atDepth) {
      const popped = stack.pop()!;
      if (first && !cur.lines.some((l) => l.trim())) {
        inherited = popped;
        boundaries = Math.max(0, boundaries - 1);
      }
      first = false;
    }
    const insideForward = stack.some((f) => f.kind === "FORWARDED");
    const kind: SegmentKind =
      info.forward || inherited?.kind === "FORWARDED" || (!insideForward && boundaries === 0 && fwdSubject && info.headerLike) ? "FORWARDED" : "QUOTED";
    boundaries++;
    stack.push({ kind, mode, baseDepth, author: info.author ?? inherited?.author ?? null, date: info.date ?? inherited?.date ?? null, sig: false });
    startSeg();
  };

  for (let i = 0; i < items.length; ) {
    const it = items[i]!;
    if (it.t === "open") {
      const info = scanAfterOpen(items, i + 1, zone);
      const forward = info.forward || it.hint === "forward" || it.hint === "embedded";
      const attributed = info.type === "attribution" ? nextNonBlankDepth(items, info.next) : null;
      const mode: Frame["mode"] = it.mode === "container" ? "container" : attributed !== null && attributed > it.depth ? "depth" : "rest";
      const baseDepth = mode === "depth" ? attributed! : it.depth;
      pushBoundary(it.depth, baseDepth, mode, { ...info, forward, headerLike: info.type !== "attribution" });
      i = Math.max(info.next, i + 1);
      continue;
    }
    if (it.t === "close") {
      let idx = -1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.mode === "container") {
          idx = k;
          break;
        }
      }
      if (idx > 0) {
        stack.length = idx;
        startSeg();
      }
      i++;
      continue;
    }
    if (it.t === "sig") {
      top().sig = true;
      i++;
      continue;
    }

    if (it.text.trim()) {
      let popped = false;
      while (stack.length > 1 && it.depth < top().baseDepth) {
        const f = stack.pop()!;
        if (f.mode === "depth" && f.kind === "QUOTED") lastQuoteAt.set(f.baseDepth, f);
        popped = true;
      }
      if (popped) startSeg();
      const b = detectTextBoundary(items, i, zone);
      if (b) {
        let mode: Frame["mode"] = "rest";
        let baseDepth = it.depth;
        if (b.type === "attribution") {
          const nd = nextNonBlankDepth(items, b.next);
          if (nd !== null && nd > it.depth) {
            mode = "depth";
            baseDepth = nd;
          }
        }
        pushBoundary(it.depth, baseDepth, mode, b);
        i = b.next;
        continue;
      }
      const f = top();
      if (it.depth > f.baseDepth && (f.mode === "base" || f.mode === "depth")) {
        const prev = lastQuoteAt.get(it.depth);
        stack.push({ kind: "QUOTED", mode: "depth", baseDepth: it.depth, author: prev?.author ?? null, date: prev?.date ?? null, sig: false });
        startSeg();
      }
    }
    if (!top().sig) cur.lines.push(it.text);
    i++;
  }
  return segs;
}

// ── Cleaning, caps, ids ──────────────────────────────────────────────────────

function finalize(raw: RawSeg[], quotedCap: number, maxTotal: number): { segments: Segment[]; redactions: number } {
  const cleaned: RawSeg[] = [];
  let redactions = 0;
  for (const s of raw) {
    let text = normalizeText(s.lines.join("\n"));
    text = s.kind === "NEW" ? stripSignature(text) : stripDisclaimer(text);
    if (!text) continue;
    // Redact the whole segment before any cap: a truncated IBAN would no longer match the redactor.
    const r = redactSensitive(text);
    redactions += r.redactions;
    text = r.text;
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.kind === s.kind && prev.author === s.author && prev.date === s.date) {
      prev.lines = [`${prev.lines[0]}\n\n${text}`];
    } else {
      cleaned.push({ ...s, lines: [text] });
    }
  }

  // Budget: NEW first, then FORWARDED, then QUOTED (each in body order); QUOTED also capped individually.
  const texts = cleaned.map((s) => s.lines[0]!);
  const out: Array<{ text: string; truncated: boolean } | null> = cleaned.map(() => null);
  let remaining = Math.max(0, maxTotal);
  for (const kind of ["NEW", "FORWARDED", "QUOTED"] as const) {
    cleaned.forEach((s, idx) => {
      if (s.kind !== kind || remaining <= 0) return;
      const cap = kind === "QUOTED" ? Math.min(quotedCap, remaining) : remaining;
      const t = truncate(texts[idx]!, cap);
      if (!t.text) return;
      out[idx] = t;
      remaining -= t.text.length;
    });
  }
  const segments: Segment[] = [];
  cleaned.forEach((s, idx) => {
    const t = out[idx];
    if (!t) return;
    segments.push({ id: `S${segments.length + 1}`, kind: s.kind, text: t.text, author: s.author, date: s.date, truncated: t.truncated });
  });
  return { segments, redactions };
}

function normalizeText(s: string): string {
  return s
    .replace(/[\xa0\u{2007}\u{202f}]/gu, " ")
    .replace(/[\u{200b}\u{200c}\u{200d}\u{2060}\u{feff}\u{ad}]/gu, "")
    .split("\n")
    .map(trimSpaceTabEnd)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Signatures & disclaimers ----------------------------------------------------

/** The phrase a mobile/app footer starts with ("Sent from my iPhone", «Στάλθηκε από το iPhone μου», "Get Outlook for iOS"). */
const MOBILE_FOOTER_HEAD =
  /^(sent from my (iphone|ipad|android|samsung|galaxy|mobile|phone|blackberry|huawei|xiaomi)|sent from (outlook|mail|yahoo mail|gmail)( for| on| app)?|get outlook for (ios|android)|στάλθηκε από (το|τη|την|μου)? ?(iphone|ipad|κινητό|συσκευή|android|samsung)|αποστολή από (το|τη|την)? ?(iphone|ipad|κινητό|συσκευή|android|samsung|outlook)|λήψη του outlook για)/iu;
/**
 * What may follow that phrase on the same line: only «μου» ("my") and device/app words ("Galaxy smartphone", "for iOS"),
 * optional end punctuation and the app's link. «Αποστολή από την Samsung: λείπουν 5 τεμάχια» ("Shipment from Samsung:
 * 5 pieces missing") is content.
 */
const MOBILE_FOOTER_TAIL =
  /^(?:\s+(?:μου|my|for|on|για|smartphone|phone|device|συσκευή|συσκευη|mobile|κινητό|κινητο|tablet|galaxy|samsung|iphone|ipad|android|ios|windows|huawei|xiaomi|blackberry|note|pro|max|plus|ultra|mini|lite|5g|app|mail|outlook|[a-z]?\d{1,3}[a-z]?))*\s*[.!]?(?:\s*<https?:\/\/[^\s>]+>|\s*\[https?:\/\/[^\s\]]+\])?\s*$/iu;
/** Mobile footers are only looked for among the last few non-blank lines of NEW. */
const MOBILE_FOOTER_WINDOW = 3;

function isMobileFooter(line: string): boolean {
  const t = line.trim();
  if (t.length > 80) return false;
  const m = MOBILE_FOOTER_HEAD.exec(t);
  return !!m && MOBILE_FOOTER_TAIL.test(t.slice(m[0].length));
}

/** Starts that are disclaimers by themselves. */
const DISCLAIMER_SURE =
  /^(disclaimer\b|legal notice|confidentiality (notice|note|statement)|please consider the environment|please think before (you )?print|think before you print|consider the environment before|αποποίηση ευθύνης|δήλωση αποποίησης|σημείωση εμπιστευτικότητας|πριν εκτυπώσετε|σκεφτείτε το περιβάλλον|παρακαλούμε σκεφτείτε (το περιβάλλον|πριν)|προστατέψτε το περιβάλλον)/iu;
/**
 * Starts that are disclaimers only with ≥ 2 legal keywords in the paragraph, one of them a strong one
 * ("This e-mail and any attachments are confidential …"). «Αυτό το μήνυμα προορίζεται για το λογιστήριο» ("This
 * message is meant for accounting") is content.
 */
const DISCLAIMER_MAYBE =
  /^(this (e-?mail|message|communication|electronic mail)|the (information|contents?) (contained )?in this|το παρόν (μήνυμα|ηλεκτρονικό|e-?mail)|το μήνυμα αυτό|αυτό το μήνυμα|το περιεχόμενο (του παρόντος|αυτού του)|οι πληροφορίες (που περιέχονται|του παρόντος|αυτού του))/iu;
const DISCLAIMER_KEYWORDS =
  /confidential|intended (solely|only)|privileged|if you (are not|have received)|unauthori[sz]ed|addressee|in error|εμπιστευτικ|απόρρητ|απορρητ|προορίζεται|προοριζεται|αν δεν είστε|εάν δεν είστε|αν λάβατε|εάν λάβατε|κατά λάθος|κατα λαθος|απαγορεύεται|απαγορευεται|αποκλειστικ/giu;
/** Keywords that ordinary business text rarely uses (not "intended only", «προορίζεται» "is meant for", «αποκλειστικά» "only"). */
const DISCLAIMER_STRONG =
  /confidential|privileged|if you (are not|have received)|unauthori[sz]ed|in error|εμπιστευτικ|απόρρητ|απορρητ|αν δεν είστε|εάν δεν είστε|αν λάβατε|εάν λάβατε|κατά λάθος|κατα λαθος|απαγορεύεται|απαγορευεται/iu;
/** Opening salutations: text before a candidate disclaimer that consists only of these is not "a message above it". */
const SALUTATION =
  /^(?:(?:καλημέρα|καλημερα|καλησπέρα|καλησπερα|γεια|γειά|χαίρετε|χαιρετε|κύριε|κυριε|κυρία|κυρια|dear|hi|hello|hey|good (?:morning|afternoon|evening)|greetings)(?=[\s,.!:]|$)|αγαπητ|αξιότιμ|αξιοτιμ)/iu;

const CLOSINGS = new Set(
  [
    "best regards", "kind regards", "regards", "best", "thanks", "thank you", "many thanks", "cheers", "sincerely",
    "yours sincerely", "best wishes", "warm regards", "br", "rgds", "thanks and regards", "thanks & regards", "with regards",
    "thanks in advance", "all the best", "με εκτίμηση", "με φιλικούς χαιρετισμούς", "φιλικούς χαιρετισμούς", "φιλικά",
    "χαιρετισμούς", "χαιρετώ", "ευχαριστώ", "ευχαριστώ πολύ", "ευχαριστούμε", "ευχαριστούμε πολύ", "με τιμή", "καλή συνέχεια",
    "καλή σας ημέρα", "με εκτίμηση και ευχαριστίες", "ευχαριστώ εκ των προτέρων", "θερμούς χαιρετισμούς",
  ].map((c) => foldForMatch(c)),
);

const CONTACT_LINE =
  /^(t|τ|tel|τηλ|τηλέφωνο|τηλεφωνο|phone|ph|mob|mobile|κιν|κινητό|κινητο|cell|m|f|fax|φαξ|e|email|e-mail|w|web|site|website|διεύθυνση|διευθυνση|address|addr|skype|viber|linkedin|office)\s*\.?\s*[:.]\s*\S|\+?\d[\d\s().\/-]{7,}\d|www\.|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.-]+|\b\d{3}\s?\d{2}\b.*(αθήνα|αθηνα|θεσσαλονίκη|θεσσαλονικη|athens|thessaloniki|greece|ελλάδα|ελλαδα|πειραιάς|πειραιας)|(οδός|οδος|λεωφ\.|λεωφόρος|λεωφορος|str\.|street|avenue|ave\.)/iu;

const NAME_LIKE = /^(\p{Lu}[\p{L}.'’-]*)(\s+\p{Lu}[\p{L}.'’-]*){0,3}$/u;

function stripSignature(text: string): string {
  let lines = text.split("\n");

  // RFC 3676 "-- " delimiter (last one, with a short tail).
  for (let k = lines.length - 1; k > 0; k--) {
    if (/^--\s?$/.test(lines[k]!) && lines.length - k <= 20) {
      lines = lines.slice(0, k);
      break;
    }
  }
  lines = cutMobileFooter(lines);
  lines = cutDisclaimer(lines, true);
  lines = cutAfterClosing(lines);
  lines = cutContactBlock(lines);
  return normalizeText(lines.join("\n"));
}

/**
 * Mobile footers ("Sent from my iPhone", «Στάλθηκε από το iPhone μου»): a whole-line match among the last few
 * non-blank lines, searched from the end. A business line in the middle of NEW is never a footer.
 */
function cutMobileFooter(lines: string[]): string[] {
  let seen = 0;
  for (let k = lines.length - 1; k >= 0 && seen < MOBILE_FOOTER_WINDOW; k--) {
    const t = lines[k]!.trim();
    if (!t) continue;
    seen++;
    if (isMobileFooter(t)) return lines.slice(0, k);
  }
  return lines;
}

function stripDisclaimer(text: string): string {
  return normalizeText(cutDisclaimer(text.split("\n"), false).join("\n"));
}

/**
 * Cut from the first disclaimer paragraph to the end of the segment.
 * - A "sure" start (Disclaimer:, «Αποποίηση ευθύνης») cuts anywhere, except as the very first line of NEW: a body
 *   that is only a disclaimer is kept rather than emptied.
 * - A "maybe" start ("This message …", «Αυτό το μήνυμα …») cuts only when a message is written above it (not just a
 *   salutation), its paragraph reads as legal text (≥ 2 keywords, one strong), and nothing but legal/contact text
 *   follows it: a message that opens with «Αυτό το μήνυμα …» ("This message …") keeps its body.
 */
function cutDisclaimer(lines: string[], isNew: boolean): string[] {
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!.trim();
    if (!l) continue;
    // Must start a paragraph (or follow a short signature-ish line).
    const prev = k > 0 ? lines[k - 1]!.trim() : "";
    if (prev && prev.length > 60 && !/[.:!]$/.test(prev)) continue;
    if (DISCLAIMER_SURE.test(l)) {
      if (!isNew || lines.slice(0, k).some((x) => x.trim())) return lines.slice(0, k);
      continue;
    }
    if (DISCLAIMER_MAYBE.test(l) && hasMessageAbove(lines, k) && isLegalParagraph(lines.slice(k, k + 10).join(" ")) && onlyLegalAfter(lines, k)) {
      return lines.slice(0, k);
    }
  }
  return lines;
}

function legalHits(text: string): Set<string> {
  return new Set((text.match(DISCLAIMER_KEYWORDS) ?? []).map((h) => foldForMatch(h)));
}

function isLegalParagraph(text: string): boolean {
  return legalHits(text).size >= 2 && DISCLAIMER_STRONG.test(text);
}

/** Some non-blank line before k that is more than an opening salutation («Καλημέρα σας,», "Hi John,"). */
function hasMessageAbove(lines: string[], k: number): boolean {
  return lines.slice(0, k).some((x) => {
    const t = x.trim();
    if (!t) return false;
    const salutation = wordCount(t) <= 6 && (SALUTATION.test(t) || (wordCount(t) <= 4 && /[,!]$/.test(t)));
    return !salutation;
  });
}

/** Paragraphs after the one starting at k are legal text, contact lines or links only (or there are none). */
function onlyLegalAfter(lines: string[], k: number): boolean {
  let j = k;
  while (j < lines.length && lines[j]!.trim()) j++;
  const rest = lines.slice(j);
  const paras: string[][] = [];
  let cur: string[] = [];
  for (const line of rest) {
    if (line.trim()) cur.push(line.trim());
    else if (cur.length) {
      paras.push(cur);
      cur = [];
    }
  }
  if (cur.length) paras.push(cur);
  return paras.every(
    (p) => DISCLAIMER_SURE.test(p[0]!) || DISCLAIMER_MAYBE.test(p[0]!) || legalHits(p.join(" ")).size >= 1 || p.every((x) => CONTACT_LINE.test(x) || /^\[cid:[^\]]*\]$/i.test(x)),
  );
}

const wordCount = (l: string) => l.trim().split(/\s+/).filter(Boolean).length;
const isSentence = (l: string) => {
  const t = l.trim();
  const words = t.split(/\s+/);
  return words.length >= 4 && /[.!?…]$/.test(t) && /\p{Ll}/u.test(words[words.length - 1]!);
};

/** Keep the closing line («Με εκτίμηση,», "Kind regards,"), drop the name/title/contact lines after it. */
function cutAfterClosing(lines: string[]): string[] {
  for (let k = lines.length - 1; k > 0; k--) {
    const l = foldForMatch(lines[k]!).replace(/(?<![,.!;:\-–—])[,.!;:\-–—]+$/, "").trim();
    if (!l || !CLOSINGS.has(l)) continue;
    if (!lines.slice(0, k).some((x) => x.trim())) return lines; // closing is the first line: not a sign-off
    const tail = lines.slice(k + 1).filter((t) => t.trim());
    if (tail.length === 0 || tail.length > 14) return lines;
    const sigLines = tail.every((t) => {
      const x = t.trim();
      if (x.length > 90 || /\?$/.test(x) || /^(p\.?\s?s\.?|υ\.?\s?γ\.?)(\s|:|$)/iu.test(x)) return false;
      return CONTACT_LINE.test(x) || (wordCount(x) <= 7 && !isSentence(x));
    });
    const anchored = tail.some((t) => CONTACT_LINE.test(t.trim())) || NAME_LIKE.test(tail[0]!.trim());
    return sigLines && anchored ? lines.slice(0, k + 1) : lines;
  }
  return lines;
}

/** Trailing paragraph(s) made mostly of contact lines (phone, fax, web, address…). */
function cutContactBlock(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  let cut = end;
  for (;;) {
    let start = cut;
    while (start > 0 && lines[start - 1]!.trim()) start--;
    if (start === cut) break;
    const para = lines.slice(start, cut).filter((l) => l.trim());
    const contact = para.filter((l) => l.length <= 200 && CONTACT_LINE.test(l.trim())).length;
    const short = para.every((l) => l.trim().length <= 100);
    // "Διεύθυνση παράδοσης:" ("Delivery address:") style introductions mean the details are content, not a signature.
    let above = start - 1;
    while (above >= 0 && !lines[above]!.trim()) above--;
    const introduced = para.some((l) => /[:：]\s*$/.test(l.trim())) || (above >= 0 && /[:：]\s*$/.test(lines[above]!.trim()));
    const isContact = short && !introduced && para.length <= 12 && contact >= 2 && contact * 2 >= para.length;
    if (!isContact) break;
    cut = start;
    while (cut > 0 && !lines[cut - 1]!.trim()) cut--;
  }
  if (cut === end) return lines;
  const kept = lines.slice(0, cut);
  return kept.some((l) => l.trim()) ? kept : lines;
}
