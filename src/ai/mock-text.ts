import { EN_MONTHS_SHORT, EN_WEEKDAYS } from "../lib/dates.js";
import { foldForMatch } from "../lib/text.js";
import { findDueHint } from "./due-hints.js";
import type { DueSpec } from "./schema.js";

/**
 * English phrasing for the mock extractor (src/ai/mock.ts): task titles, next steps and summaries that read like a
 * colleague wrote them, following the same rules as the system prompt (src/ai/prompt.ts, “Writing the fields”):
 * - title: the thing itself, from the email's own words (“Quote for 4 JBL PRX915 speakers”), never the company;
 * - next_action: P1's next step in the imperative, ≤ 60 characters, or null;
 * - summary: one sentence, who wants what (and why, when the email says so).
 * Mail is read in Greek, English and Greeklish; the text is always English. An English object is used as written. A
 * Greek or Greeklish one is rebuilt from a small lexicon (the deliverables, a few more nouns and adjectives) plus the
 * quantities, product names and codes as written. It is not a translator: a phrase it cannot read falls back to the
 * subject, then to the name of the deliverable. Heuristics only; deterministic; no wall-clock.
 */

// ── Matching helpers ─────────────────────────────────────────────────────────

/** Compile with Unicode-aware `\b` and `\w` (the ASCII ones never match Greek letters). */
export function U(src: string): RegExp {
  const W = String.raw`[\p{L}\p{N}_]`;
  const body = src.replaceAll(String.raw`\b`, `(?:(?<!${W})(?=${W})|(?<=${W})(?!${W}))`).replaceAll(String.raw`\w`, W);
  return new RegExp(body, "u");
}

const COMBINING = /[̀-ͯ]/g;

/** Lower-case, accent-free, ς→σ, one UTF-16 unit for one: offsets in the result are offsets in `s`. */
export function foldAligned(s: string): string {
  let out = "";
  for (const ch of s) {
    let f = ch.normalize("NFD").replace(COMBINING, "").toLowerCase();
    if (f === "ς") f = "σ";
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

const ABBREVIATIONS = new Set(["τεμ", "κα", "κ", "κοσ", "κυρ", "αρ", "τηλ", "οδ", "πχ", "κλπ", "λ", "χλμ", "ευρ", "μηχ", "μ", "mr", "mrs", "ms", "dr", "no", "nr", "tel", "st", "etc", "approx", "pcs", "vs"]);

/** Word right before a period is a common abbreviation or an initial ("τεμ.", "κα.", "Α.Ε."). */
export function isAbbreviation(before: string): boolean {
  const word = foldForMatch(before.match(/([\p{L}.]+)$/u)?.[1] ?? "").replace(/\./g, "");
  return word.length === 1 || ABBREVIATIONS.has(word);
}

const GREEK = /\p{Script=Greek}/gu;
/** Greek text (vs English or Greeklish): a few Greek letters are enough, product codes are Latin anyway. */
export function isGreek(text: string): boolean {
  return (text.match(GREEK)?.length ?? 0) >= 3;
}
/** A word with any Greek letter is never copied into the English text. */
const GREEK_LETTER = /\p{Script=Greek}/u;

/** Upper-case the first letter. */
export function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

const QUOTE_PAIRS: Array<[string, string]> = [
  ["«", "»"],
  ["“", "”"],
  ["(", ")"],
  ["[", "]"],
];

/**
 * Drop unpaired quotes and brackets: a phrase cut out of a sentence may keep the closing half of «…» or (…) whose
 * opening half sat on a dropped article («στείλετε «το νέο τιμολόγιο»;» → «νέο τιμολόγιο»).
 */
export function balanceQuotes(s: string): string {
  return balanceTokens(wordsOf(s)).filter(Boolean).join(" ");
}

/** {@link balanceQuotes} over words, keeping word positions (a word that was only a quote mark becomes ""). */
function balanceTokens(tokens: string[]): string[] {
  let chars = tokens.flatMap((t, w) => [...t].map((c) => ({ c, w })));
  for (const [open, close] of QUOTE_PAIRS) {
    const drop = new Set<number>();
    const opens: number[] = [];
    chars.forEach((x, i) => {
      if (x.c === open) opens.push(i);
      else if (x.c === close && opens.pop() === undefined) drop.add(i);
    });
    for (const i of opens) drop.add(i);
    chars = chars.filter((_, i) => !drop.has(i));
  }
  const straight = chars.filter((x) => x.c === '"').length;
  if (straight % 2 === 1) chars.splice(chars.map((x) => x.c).lastIndexOf('"'), 1);
  const out = tokens.map(() => "");
  for (const x of chars) out[x.w] += x.c;
  return out;
}

// ── Objects and verbs ────────────────────────────────────────────────────────

/** The language an object phrase is written in: English is used as written, Greek and Greeklish are rebuilt. */
export type Lang = "el" | "greeklish" | "en";
/** “the” or “a”, from the article in the email. */
type Det = "def" | "indef";
/** Greek declension, enough to tell singular from plural by the ending. */
type Decl = "a" | "o" | "ma" | "os" | "is" | "inv";

interface ObjectNoun {
  re: RegExp;
  /** English singular and plural. */
  en: string;
  pl: string;
  decl: Decl;
  /** Uncountable: no “a”, never plural. */
  mass?: boolean;
  /** Named in the plural when nothing says how many (“Certificates”). */
  many?: boolean;
  /** Plural endings, when one entry covers two declensions (συμβόλαιο / σύμβαση). */
  plural?: RegExp;
}

/** Common deliverables (folded stems, Greek / English / Greeklish). First match wins, so specific stems come first. */
const NOUNS: ObjectNoun[] = [
  { re: /τιμοκαταλογ|price ?list|timokatalog/, en: "price list", pl: "price lists", decl: "os" },
  { re: /προσφορ|quot(e|ation)|\boffer\b|prosfor/, en: "quote", pl: "quotes", decl: "a" },
  { re: /τιμολογ|invoice|timologi/, en: "invoice", pl: "invoices", decl: "o" },
  { re: /πιστοποιητικ|certificat|pistopoihtik|pistopoiitik/, en: "certificate", pl: "certificates", decl: "o", many: true },
  { re: /δειγμα|sample|deigma/, en: "sample", pl: "samples", decl: "ma", many: true },
  { re: /συμβολαι|συμβασ|contract|symvolai|symbolai/, en: "contract", pl: "contracts", decl: "o", plural: /(α|ων|εισ)$/u },
  { re: /παραγγελι|\border\b|paraggeli|paragkeli/, en: "order", pl: "orders", decl: "a" },
  { re: /παραδοσ|delivery|paradosi|paradosh/, en: "delivery", pl: "deliveries", decl: "a" },
  { re: /αντιγραφ|\bcopy\b|antigraf/, en: "copy", pl: "copies", decl: "o" },
  { re: /καταλογ|catalog/, en: "catalogue", pl: "catalogues", decl: "os" },
  { re: /διαθεσιμοτ|availability/, en: "availability", pl: "availability", decl: "a", mass: true },
  { re: /καλωδι|kalwdi|kalodi|cable/, en: "cable", pl: "cables", decl: "o", many: true },
  { re: /πληρωμ|εξοφλ|payment|plirwm|plhrwm/, en: "payment", pl: "payments", decl: "a" },
  { re: /φυλλαδι|brochure|datasheet|fylladi/, en: "brochure", pl: "brochures", decl: "o", many: true },
  { re: /μικροφων|microphone|mikrofwn|mikrofon/, en: "microphone", pl: "microphones", decl: "o", many: true },
  { re: /ηχει|speaker|hxei|ixei/, en: "speaker", pl: "speakers", decl: "o", many: true },
  { re: /εξοπλισμ|equipment|eksoplism|exoplism/, en: "equipment", pl: "equipment", decl: "os", mass: true },
  { re: /(?<!\p{L})τιμ(η|εσ)(?!\p{L})|\bprice\b|\btim[hi]\b/u, en: "price", pl: "prices", decl: "a" },
  { re: /στοιχει|details/, en: "detail", pl: "details", decl: "o", many: true },
  { re: /ραντεβου|συναντησ|meeting|appointment|rantevou/, en: "meeting", pl: "meetings", decl: "a" },
];

/** The Greeklish stems of {@link NOUNS}: a Latin word that has one is Greek written in Latin letters. */
const GREEKLISH_STEMS = /timokatalog|prosfor|timologi|pistopoihtik|pistopoiitik|deigma|symvolai|symbolai|paraggeli|paragkeli|paradosi|paradosh|antigraf|kalwdi|kalodi|plirwm|plhrwm|fylladi|mikrofwn|mikrofon|hxei|ixei|eksoplism|exoplism|rantevou|\btim[hi]\b/u;
/** Greeklish function words (“tha”, “na”, “mou”): Latin text that has them is Greek too. */
const GREEKLISH_WORDS = /(?<![a-z])(tha|na|mou|sou|mas|sas|kai|gia|tin|thn|tis|tou|twn|einai|exete|exeis|mporeis|mporeite|mporouses|mporousate|parakalw|parakalo|steilte|steileis|steilete|kalimera|kalhmera|geia|ena|mia|thelw|theloume|xreiazomaste|kratiseis|avrio|aurio)(?![a-z])/u;

/** Latin text: Greeklish or English. */
function latinLang(text: string): Lang {
  const f = foldForMatch(text);
  return GREEKLISH_WORDS.test(f) || GREEKLISH_STEMS.test(f) ? "greeklish" : "en";
}

/** The language a text is written in. */
export function langOf(text: string): Lang {
  return isGreek(text) ? "el" : latinLang(text);
}

/** The deliverable a whole text is about (first known noun anywhere). */
export function nounIn(text: string): ObjectNoun | null {
  const f = foldForMatch(text);
  return NOUNS.find((n) => n.re.test(f)) ?? null;
}

/** The deliverable a single word names. */
function nounOf(word: string): ObjectNoun | null {
  const f = foldForMatch(word);
  return f.length >= 3 ? (NOUNS.find((n) => n.re.test(f)) ?? null) : null;
}

interface Verb {
  re: RegExp;
  /** P1's imperative (“Send”); null for verbs that only introduce a wait. */
  imperative: string | null;
  /** The action itself, when the ask is not simply “send it”: a title can lead with it (“Reserve 10 XLR cables”). */
  action: string | null;
}

/** Verb endings after a σ-aorist stem (future, subjunctive, imperative), so nouns such as «επιβεβαίωση» never match. */
const SUBJ = "(σετε|σεισ|σει|σω|σουμε|στε|σε)";

/** Request / promise verbs (folded). The object follows the earliest one in the sentence. */
const VERBS: Verb[] = [
  { re: U(String.raw`\bπαρακαλ(ω|ουμε) για\b`), imperative: "Send", action: null },
  { re: U(String.raw`\bεπιβεβαιω${SUBJ}\b`), imperative: "Confirm", action: "Confirm" },
  { re: U(String.raw`\bκρατη${SUBJ}\b`), imperative: "Reserve", action: "Reserve" },
  { re: U(String.raw`\b(εξοφλη${SUBJ}|πληρω${SUBJ})\b`), imperative: "Pay", action: "Pay" },
  { re: U(String.raw`\b(παραδω${SUBJ}|φερ(ετε|εισ|ω|ουμε|τε))\b`), imperative: "Deliver", action: "Deliver" },
  { re: U(String.raw`\bετοιμα${SUBJ}\b`), imperative: "Prepare", action: null },
  { re: U(String.raw`\bκανονι${SUBJ}\b`), imperative: "Arrange", action: null },
  { re: U(String.raw`\bκλει${SUBJ}\b`), imperative: "Book", action: null },
  { re: U(String.raw`\bπροωθη${SUBJ}\b`), imperative: "Forward", action: null },
  { re: U(String.raw`\b(πειτε|πεισ|ενημερω${SUBJ}|απαντη${SUBJ})\b`), imperative: "Reply", action: null },
  {
    re: U(String.raw`\b(στειλ\w*|αποστειλ\w*|στελν(ετε|εισ)|δωσ(ετε|εισ|τε)|χρειαζ(ομαστε|ομαι)|χρειαστ(ουμε|ω)|ζητ(αμε|ουμε|ω)|θελ(ουμε|ω))\b`),
    imperative: "Send",
    action: null,
  },
  { re: U(String.raw`\bπεριμεν(ω|ουμε)\b|\blooking forward to\b|\bperimen(w|oume)\b`), imperative: null, action: null },
  // English and Greeklish.
  { re: U(String.raw`\b(kratis\w*|krathse\w*|reserve|book)\b`), imperative: "Reserve", action: "Reserve" },
  { re: U(String.raw`\b(confirm|epivevaiws\w*|epibebaiws\w*)\b`), imperative: "Confirm", action: "Confirm" },
  { re: U(String.raw`\b(pay|settle|eksofl\w*|exofl\w*)\b`), imperative: "Pay", action: "Pay" },
  { re: U(String.raw`\b(tell|let (me|us) know|advise)\b`), imperative: "Reply", action: null },
  { re: U(String.raw`\b(send|share|provide|forward|need|steil\w*|stil\w*|stel\w*)\b`), imperative: "Send", action: null },
];

const CLITICS = new Set(["μου", "μασ", "σασ", "σου", "του", "τησ", "mou", "mas", "sas", "sou", "us", "me", "him", "her"]);
const FILLERS = new Set(["παρακαλω", "παρακαλουμε", "και", "επισησ", "ξανα", "επειγοντωσ", "οπωσδηποτε", "λοιπον", "please", "kindly", "also", "again", "parakalw", "parakalo", "kai", "episis", "ksana", "xana"]);
const ARTICLES = new Set(["τον", "την", "τη", "το", "τα", "τισ", "τουσ", "ενα", "εναν", "μια", "the", "a", "an", "tin", "thn", "ti", "ton", "to", "ta", "tis"]);
const DEFINITE_ARTICLES = new Set(["ο", "η", "οι", "τον", "την", "τη", "το", "τα", "τισ", "τουσ", "the", "tin", "thn", "ti", "ton", "to", "ta", "tis", "tous"]);
const INDEFINITE_ARTICLES = new Set(["ενα", "εναν", "μια", "a", "an", "ena", "enan", "mia"]);
const detOf = (f: string): Det | null => (DEFINITE_ARTICLES.has(f) ? "def" : INDEFINITE_ARTICLES.has(f) ? "indef" : null);
/** An object that is really a clause («πείτε μου αν έχετε…») says nothing a title can use. */
const CLAUSE = new Set(["αν", "εαν", "ποτε", "πωσ", "τι", "ποιο", "ποια", "ποιοσ", "ποιεσ", "οτι", "να", "που", "αυτο", "αυτα", "if", "whether", "when", "what", "how", "which", "that", "it", "this", "them", "pote", "pws"]);
const SUBORDINATORS = new Set(["γιατι", "επειδη", "ωστε", "αφου", "καθωσ", "οπωσ", "διοτι", "οταν", "because", "since", "as", "so", "when", "giati", "epeidh"]);
/** Words a phrase must not end on. */
const DANGLING = new Set(["και", "για", "με", "σε", "στο", "στη", "στην", "στον", "στα", "στισ", "του", "τησ", "των", "την", "τη", "το", "τα", "τον", "τισ", "τουσ", "απο", "ωσ", "εωσ", "μεχρι", "η", "ή", "ο", "and", "or", "for", "with", "to", "of", "the", "by", "a", "an", "in", "on"]);
const PURPOSE_ARTICLES = new Set(["την", "τη", "το", "τον", "τισ", "τα", "τουσ"]);

interface Tok {
  raw: string;
  /** Folded, trailing punctuation removed. */
  f: string;
}

const tok = (raw: string): Tok => ({ raw, f: foldAligned(raw).replace(/(?<![.,;;:!?)»"'])[.,;;:!?)»"']+$/u, "").replace(/^[(«"']+/u, "") });

/** The object a request or promise sentence names, cut into usable pieces. */
export interface ObjectPhrase {
  imperative: string | null;
  action: string | null;
  lang: Lang;
  /** The leading article, as “the” or “a”, when there is one. */
  det: Det | null;
  /** The object as written, with its article, for English sentences (“the invoice for the August rental”). */
  asWritten: string;
  /** The object's words as written, without the leading article (genitive articles kept). */
  objectWords: string[];
  /** A purpose clause cut off the end («για την παράσταση»), for the summary's “why”. */
  purpose: string | null;
}

/** Find the request/promise verb in `text` and the object that follows it. */
export function objectPhrase(text: string): ObjectPhrase | null {
  const folded = foldAligned(text);
  let best: { verb: Verb; index: number; end: number } | null = null;
  for (const verb of VERBS) {
    const m = verb.re.exec(folded);
    if (m && (!best || m.index < best.index)) best = { verb, index: m.index, end: m.index + m[0].length };
  }
  if (!best) return null;

  let rest = text.slice(best.end);
  const due = findDueHint(rest);
  if (due) rest = rest.slice(0, due.index);
  let toks = rest.split(/\s+/).filter(Boolean).map(tok);

  // Clitics and fillers between the verb and the object: «στείλτε μου σας παρακαλώ και τον…».
  for (;;) {
    const t = toks[0];
    if (!t) break;
    if (CLITICS.has(t.f) || FILLERS.has(t.f)) toks = toks.slice(1);
    else if (t.f === "τουσ" && toks[1] && ARTICLES.has(toks[1].f)) toks = toks.slice(1);
    else break;
  }
  const article = toks[0] && ARTICLES.has(toks[0].f) ? toks[0] : null;
  const body = article ? toks.slice(1) : toks;
  if (!body.length || CLAUSE.has(body[0]!.f)) return null;

  // Cut at the end of the clause: punctuation, a subordinate clause, or a purpose «για την …» after ≥ 3 words.
  let kept: Tok[] = [];
  let purpose: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const t = body[i]!;
    const next = body[i + 1];
    if (SUBORDINATORS.has(t.f)) break;
    if (t.f === "για" && next && PURPOSE_ARTICLES.has(next.f) && kept.length >= 3) {
      purpose = cutAtClauseEnd(body.slice(i)).map((x) => x.raw).join(" ");
      break;
    }
    const endsClause = /[?;;!:]$/u.test(t.raw) || (/\.$/u.test(t.raw) && !isAbbreviation(t.raw.slice(0, -1))) || (/,$/u.test(t.raw) && !!next && (SUBORDINATORS.has(next.f) || CLAUSE.has(next.f) || next.f === "θα"));
    if (endsClause) {
      kept.push({ raw: t.raw.replace(/(?<![?;;!:.,])[?;;!:.,]+$/u, ""), f: t.f });
      break;
    }
    kept.push(t);
  }
  while (kept.length && (DANGLING.has(kept[kept.length - 1]!.f) || !kept[kept.length - 1]!.raw)) kept.pop();
  if (!kept.length) return null;
  const lastRaw = kept[kept.length - 1]!.raw.replace(/(?<![,;:])[,;:]+$/u, "");
  kept[kept.length - 1] = { ...kept[kept.length - 1]!, raw: lastRaw };
  // The article may carry the opening «, the object the closing one: pair them as written, drop the orphans.
  const asWritten = balanceTokens([article?.raw ?? "", ...kept.map((t) => t.raw)]).filter(Boolean).join(" ");
  const balanced = balanceTokens(kept.map((t) => t.raw));
  kept = kept.map((t, i) => ({ ...t, raw: balanced[i]! })).filter((t) => t.raw);
  if (!kept.length) return null;

  const objectWords = kept.map((t) => t.raw);
  const lang: Lang = isGreek(objectWords.join(" ")) ? "el" : latinLang(text);
  // English mail keeps its own verb (“Book …”, “Settle …”) in the title and the next step.
  const verbWord = folded.slice(best.index, best.end);
  const own = lang === "en" && /^(reserve|book|confirm|pay|settle)$/u.test(verbWord) ? cap(verbWord) : null;
  return {
    imperative: own ?? best.verb.imperative,
    action: best.verb.action && (own ?? best.verb.action),
    lang,
    det: article ? detOf(article.f) : null,
    asWritten,
    objectWords,
    purpose,
  };
}

function cutAtClauseEnd(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (const t of toks) {
    if (/[?;;!:.]$/u.test(t.raw) && !isAbbreviation(t.raw.slice(0, -1))) {
      out.push({ raw: t.raw.replace(/(?<![?;;!:.,])[?;;!:.,]+$/u, ""), f: t.f });
      break;
    }
    if (SUBORDINATORS.has(t.f)) break;
    out.push(t);
  }
  return out;
}

// ── Greek and Greeklish noun phrases in English ──────────────────────────────

/** Plural endings, folded (προσφορές, καλώδια, δείγματα, κατάλογοι, ενισχυτές), and the same in Greeklish. */
const PLURAL_EL: Record<Decl, RegExp> = { a: /(εσ|εισ|ων)$/u, o: /(α|ων)$/u, ma: /(ατα|ατων)$/u, os: /(οι|ουσ|ων)$/u, is: /(εσ|εισ|ων)$/u, inv: /(?!)/u };
const PLURAL_GL: Record<Decl, RegExp> = { a: /(es|eis|wn|on)$/u, o: /(a|wn|on)$/u, ma: /(ata|atwn|aton)$/u, os: /(oi|ous|wn|on)$/u, is: /(es|eis|wn|on)$/u, inv: /(?!)/u };

interface Gloss {
  re: RegExp;
  en: string;
  pl: string;
  decl: Decl;
  mass?: boolean;
}

/** More nouns, only for writing Greek phrases in English (the deliverables the mock recognises are {@link NOUNS}). */
const MORE_NOUNS: Gloss[] = [
  { re: /^χαρακτηριστικ/u, en: "specification", pl: "specifications", decl: "o" },
  { re: /^ενισχυτ/u, en: "amplifier", pl: "amplifiers", decl: "is" },
  { re: /^προβολε/u, en: "spotlight", pl: "spotlights", decl: "is" },
  { re: /^φωτιστικ/u, en: "light", pl: "lights", decl: "o" },
  { re: /^φωτισμ/u, en: "lighting", pl: "lighting", decl: "os", mass: true },
  { re: /^κονσολ/u, en: "console", pl: "consoles", decl: "a" },
  { re: /^μικτ(ησ|η|εσ|ων)$/u, en: "mixer", pl: "mixers", decl: "is" },
  { re: /^βασ(η|ησ|εισ|εων)$/u, en: "stand", pl: "stands", decl: "a" },
  { re: /^οροφ/u, en: "ceiling", pl: "ceilings", decl: "a" },
  { re: /^ημερομηνι/u, en: "date", pl: "dates", decl: "a" },
  { re: /^διευθυνσ/u, en: "address", pl: "addresses", decl: "a" },
  { re: /^καταστασ/u, en: "statement", pl: "statements", decl: "a" },
  { re: /^πελατ/u, en: "customer", pl: "customers", decl: "is" },
  { re: /^ενοικιασ/u, en: "rental", pl: "rentals", decl: "a" },
  { re: /^ενοικι/u, en: "rent", pl: "rent", decl: "o", mass: true },
  { re: /^εκδηλωσ/u, en: "event", pl: "events", decl: "a" },
  { re: /^καλυψ/u, en: "coverage", pl: "coverage", decl: "a", mass: true },
  { re: /^παραστασ/u, en: "show", pl: "shows", decl: "a" },
  { re: /^συνεδρι/u, en: "conference", pl: "conferences", decl: "o" },
  { re: /^βλαβ/u, en: "fault", pl: "faults", decl: "a" },
  { re: /^ερωτησ/u, en: "question", pl: "questions", decl: "a" },
  { re: /^ερωτημα/u, en: "query", pl: "queries", decl: "ma" },
  { re: /^ηχ(οσ|ου|ο)$/u, en: "sound", pl: "sound", decl: "os", mass: true },
  { re: /^επιβεβαιωσ/u, en: "confirmation", pl: "confirmations", decl: "a" },
  { re: /^παραλαβ/u, en: "receipt", pl: "receipts", decl: "a" },
  { re: /^πισιν/u, en: "pool", pl: "pools", decl: "a" },
  { re: /^επιστροφ/u, en: "return", pl: "returns", decl: "a" },
  { re: /^υπογραφ/u, en: "signature", pl: "signatures", decl: "a" },
  { re: /^αποθηκ/u, en: "warehouse", pl: "warehouses", decl: "a" },
  { re: /^αποστολ/u, en: "shipment", pl: "shipments", decl: "a" },
  { re: /^προιον/u, en: "product", pl: "products", decl: "o" },
  { re: /^αρχει/u, en: "file", pl: "files", decl: "o" },
  { re: /^εγγραφ/u, en: "document", pl: "documents", decl: "o" },
  { re: /^τεμαχι/u, en: "piece", pl: "pieces", decl: "o" },
  { re: /^απαντησ/u, en: "reply", pl: "replies", decl: "a" },
  { re: /^καναλι/u, en: "channel", pl: "channels", decl: "o" },
  { re: /^τιμ(ησ|ων)$/u, en: "price", pl: "prices", decl: "a" },
  { re: /^splitters?$/u, en: "splitter", pl: "splitters", decl: "inv" },
];

interface Adjective {
  re: RegExp;
  en: string;
  /** Says what kind of thing (“sound”, “digital”): it goes right before the noun. */
  kind?: boolean;
  /** Left out before this noun, which says it already («οικονομική προσφορά» is a quote). */
  skipBefore?: string;
}

const ADJECTIVES: Adjective[] = [
  { re: /^(τεχνικ|texnik|tehnik)/u, en: "technical" },
  { re: /^(αναλυτικ|analytik|analitik)/u, en: "detailed" },
  { re: /^(ανανεωμεν|ananewmen|ananeomen)/u, en: "updated" },
  { re: /^αναθεωρημεν/u, en: "revised" },
  { re: /^(τελικ|telik)/u, en: "final" },
  { re: /^(ετησι|etisi|ethsi)/u, en: "annual" },
  { re: /^μηνιαι/u, en: "monthly" },
  { re: /^(οικονομικ|oikonomik)/u, en: "financial", skipBefore: "quote" },
  { re: /^(νε(ο|α|οσ|ου|ων|εσ|η|ησ|οι|ουσ)|ne(o|a|os|ou|wn|es|oi|ous))$/u, en: "new" },
  { re: /^πληρ(ησ|η|ουσ|εισ|ων|εσ)$/u, en: "full" },
  { re: /^(ηχητικ|hxhtik|ixitik)/u, en: "sound", kind: true },
  { re: /^ψηφιακ/u, en: "digital", kind: true },
  { re: /^ασυρματ/u, en: "wireless", kind: true },
];

const AND = new Set(["και", "kai"]);
const FOR = new Set(["για", "gia"]);
/** Genitive articles: «της εκδήλωσης» → “of the event” (Greeklish “ton”/“tis” count only after a noun). */
const OF = new Set(["του", "τησ", "των", "tou", "ths", "twn", "ton", "tis"]);
/** After these, «για» is “about” (“Customer reply about the speakers”). */
const ABOUT_HEADS = new Set(["reply", "question", "query", "meeting"]);
/** A unit between a number and its noun: «500 μ. καλώδιο» → “500 m of cable”; «20 τεμ.» is just 20. */
const UNITS: Record<string, string> = { μ: "m", m: "m", τεμ: "" };
const NUMBER = /^\d+([.,]\d+)?$/u;
const NUMERIC_ID = /^\d[\d\-/.]*$/u;
const YEAR = /^(19|20)\d{2}$/u;
const ORDINAL = /^(\d{1,2})(ησ|η|ου)$/u;
const MONTH_STEMS = ["ιανουαρ", "φεβρουαρ", "μαρτ", "απριλ", "μα", "ιουν", "ιουλ", "αυγουστ", "σεπτεμβρ", "οκτωβρ", "νοεμβρ", "δεκεμβρ"];
const MONTH_EL = new RegExp(`^(${MONTH_STEMS.join("|")})(ιοσ|ιου|οσ|ου)$`, "u");

interface GTok {
  /** As written, without quotes, brackets and trailing punctuation. */
  out: string;
  /** {@link out} folded. */
  f: string;
  /** A comma follows: the end of an item in a list. */
  comma: boolean;
  greek: boolean;
}

function gtok(raw: string): GTok {
  const out = raw.replace(/^[«“"'([]+/u, "").replace(/(?<![»”"')\].,;;:!?·])[»”"')\].,;;:!?·]+$/u, "");
  return { out, f: foldAligned(out), comma: /,[»”"')\]]*$/u.test(raw), greek: GREEK_LETTER.test(out) };
}

interface NounHit {
  en: string;
  pl: string;
  mass: boolean;
  /** Plural as written. */
  plural: boolean;
  /** One of the deliverables the mock recognises ({@link NOUNS}). */
  known: boolean;
}

/** The noun a word is, in English: Greek and Greeklish from the lexicon, an English word as written. */
function nounAt(t: GTok, lang: Lang): NounHit | null {
  if (t.greek) {
    const n = t.f.length >= 3 ? NOUNS.find((x) => x.re.test(t.f)) : undefined;
    if (n) return { en: n.en, pl: n.pl, mass: !!n.mass, plural: (n.plural ?? PLURAL_EL[n.decl]).test(t.f), known: true };
    const g = MORE_NOUNS.find((x) => x.re.test(t.f));
    return g ? { en: g.en, pl: g.pl, mass: !!g.mass, plural: PLURAL_EL[g.decl].test(t.f), known: false } : null;
  }
  // A capitalised Latin word in Greek mail is a name (“Shure”); in Greeklish it may start the phrase.
  if (t.f.length < 3 || (lang === "el" && /^\p{Lu}/u.test(t.out))) return null;
  const n = NOUNS.find((x) => x.re.test(t.f));
  const g = n ? undefined : MORE_NOUNS.find((x) => x.re.test(t.f));
  if (g) return { en: g.en, pl: g.pl, mass: !!g.mass, plural: /[^s]s$/u.test(t.f), known: false };
  if (!n) return null;
  if (lang === "greeklish" && GREEKLISH_STEMS.test(t.f)) return { en: n.en, pl: n.pl, mass: !!n.mass, plural: PLURAL_GL[n.decl].test(t.f), known: true };
  // An English word in Greek or Greeklish mail («το datasheet») stays as written.
  const plural = /[^s]s$/u.test(t.f);
  return { en: t.out, pl: plural ? t.out : /(s|x|ch|sh)$/u.test(t.f) ? `${t.out}es` : `${t.out}s`, mass: !!n.mass, plural, known: true };
}

/** “JBL”, “PRX915”, “Shure”: a product name or code, kept as written. */
const isCode = (raw: string) => /\d/u.test(raw) || /^[\p{Lu}\d][\p{Lu}\d-]+$/u.test(raw);

function isName(t: GTok, lang: Lang): boolean {
  if (t.greek || !/[\p{L}\p{N}]/u.test(t.out)) return false;
  if (isCode(t.out)) return true;
  if (lang === "greeklish" && !/^\p{Lu}/u.test(t.out)) return false;
  return !nounAt(t, lang);
}

const adjectiveAt = (t: GTok) => ADJECTIVES.find((a) => a.re.test(t.f)) ?? null;

interface Group {
  det: Det | null;
  qty: string | null;
  unit: string | null;
  adjs: Adjective[];
  /** Names and codes, which English puts before the noun (“Shure SM58 microphones”). */
  names: string[];
  noun: NounHit | null;
  /** Numbers that identify the thing (“invoice 1234”). */
  ids: string[];
  /** A year, which English puts first (“2027 prices”). */
  year: string | null;
  /** Genitive modifiers as English compounds, in the order written («κονσόλα ήχου 16 καναλιών»: sound, 16-channel). */
  mods: string[];
}

/** One noun group: [article] [number [unit]] adjectives and names, the noun, then names, numbers and modifiers. */
function parseGroup(toks: GTok[], start: number, lang: Lang, det: Det | null, head: boolean): { g: Group; next: number } | null {
  const g: Group = { det, qty: null, unit: null, adjs: [], names: [], noun: null, ids: [], year: null, mods: [] };
  let i = start;
  const open = () => i < toks.length && (i === start || !toks[i - 1]!.comma);
  const article = open() ? detOf(toks[i]!.f) : null;
  if (article) {
    g.det ??= article;
    i++;
  }
  if (open() && NUMBER.test(toks[i]!.f)) {
    g.qty = toks[i]!.out;
    i++;
    if (open() && Object.hasOwn(UNITS, toks[i]!.f)) {
      g.unit = UNITS[toks[i]!.f] || null;
      i++;
    }
  }
  for (; open(); i++) {
    const t = toks[i]!;
    const a = adjectiveAt(t);
    if (a) g.adjs.push(a);
    else if (isName(t, lang) && !NUMERIC_ID.test(t.f)) g.names.push(t.out);
    else break;
  }
  const noun = open() ? nounAt(toks[i]!, lang) : null;
  if (!noun) return g.names.length || (!head && g.qty && !g.adjs.length) ? { g, next: i } : null;
  g.noun = noun;
  i++;
  while (open()) {
    const t = toks[i]!;
    if (NUMERIC_ID.test(t.f)) {
      // «16 καναλιών» is a modifier, «1234» an id, «2027» a year.
      const mod = NUMBER.test(t.f) && !t.comma ? parseMod(toks, i, lang) : null;
      if (mod) {
        g.mods.push(mod.text);
        i = mod.next;
        continue;
      }
      if (YEAR.test(t.f) && !g.year) g.year = t.out;
      else g.ids.push(t.out);
      i++;
      continue;
    }
    if (!g.mods.length && isName(t, lang)) {
      g.names.push(t.out);
      i++;
      continue;
    }
    const mod = parseMod(toks, i, lang);
    if (!mod) break;
    g.mods.push(mod.text);
    i = mod.next;
  }
  return { g, next: i };
}

/** A genitive modifier without an article («οροφής», «ηχητικής κάλυψης», «κονσόλας Yamaha», «16 καναλιών») as a compound. */
function parseMod(toks: GTok[], start: number, lang: Lang): { text: string; next: number } | null {
  let i = start;
  const open = () => i < toks.length && (i === start || !toks[i - 1]!.comma);
  let qty: string | null = null;
  if (open() && NUMBER.test(toks[i]!.f)) {
    qty = toks[i]!.out;
    i++;
  }
  const adjs: Adjective[] = [];
  for (let a = open() ? adjectiveAt(toks[i]!) : null; a; a = open() ? adjectiveAt(toks[i]!) : null) {
    adjs.push(a);
    i++;
  }
  if (!open() || (!toks[i]!.greek && lang !== "greeklish")) return null;
  const noun = nounAt(toks[i]!, lang);
  if (!noun) return null;
  i++;
  const names: string[] = [];
  for (; open() && isName(toks[i]!, lang) && !NUMERIC_ID.test(toks[i]!.f); i++) names.push(toks[i]!.out);
  const word = qty ? `${qty}-${noun.en}` : noun.en;
  const text = [...adjs.filter((a) => !a.kind).map((a) => a.en), ...names, ...adjs.filter((a) => a.kind).map((a) => a.en), word].join(" ");
  return { text, next: i };
}

/** «της 10ης Οκτωβρίου» → “10 Oct” (the article already read). */
function dateAt(toks: GTok[], i: number): { text: string; next: number } | null {
  const day = ORDINAL.exec(toks[i]?.f ?? "");
  const month = MONTH_EL.exec(toks[i + 1]?.f ?? "");
  if (!day || !month || toks[i]!.comma) return null;
  return { text: `${Number(day[1])} ${EN_MONTHS_SHORT[MONTH_STEMS.indexOf(month[1]!)] ?? ""}`, next: i + 2 };
}

function nounForm(g: Group): { word: string | null; plural: boolean } {
  const counted = !!g.qty && !g.unit;
  if (!g.noun) return { word: null, plural: counted && g.qty !== "1" };
  const plural = !g.noun.mass && (counted ? g.qty !== "1" : g.noun.plural);
  return { word: plural ? g.noun.pl : g.noun.en, plural };
}

const adjWords = (g: Group, kind: boolean) => g.adjs.filter((a) => !!a.kind === kind && !(a.skipBefore && a.skipBefore === g.noun?.en)).map((a) => a.en);

/** The group in English word order; with its determiner (“the”, “a”) for a sentence, without it for a title. */
function renderGroup(g: Group, withDet: boolean): string {
  const { word, plural } = nounForm(g);
  const body = [g.qty && (g.unit ? `${g.qty} ${g.unit} of` : g.qty), g.year, ...adjWords(g, false), ...g.names, ...[...g.mods].reverse(), ...adjWords(g, true), word, ...g.ids]
    .filter((w): w is string => !!w)
    .join(" ");
  if (!withDet || g.qty || g.ids.length) return body;
  if (g.det === "def") return `the ${body}`;
  if (g.det !== "indef" && (plural || !g.noun || g.noun.mass)) return body;
  return `${/^[aeio]/iu.test(body) ? "an" : "a"} ${body}`;
}

interface Glossed {
  /** Title words: the head without its determiner. */
  title: string[];
  /** The phrase with determiners, for a sentence (“a quote for 4 JBL PRX915 speakers”). */
  text: string;
  /** The object of P1's next step (“the quote”), when the head is a noun. */
  ref: string | null;
  plural: boolean;
  /** The head is a known deliverable without adjectives, so a title can lead with the action (“Pay invoice 1234”). */
  plainHead: boolean;
}

/** A Greek or Greeklish noun phrase in English; null when its head is not in the lexicon. Unknown words end it. */
function glossPhrase(words: string[], lang: Lang, det: Det | null): Glossed | null {
  const toks = words.map(gtok).filter((t) => t.out);
  const first = parseGroup(toks, 0, lang, det, true);
  if (!first) return null;
  const head = first.g;
  let rest = "";
  let last = head;
  let i = first.next;
  while (i < toks.length) {
    const t = toks[i]!;
    let sep = ", ";
    let next: { g: Group; next: number } | null;
    if (toks[i - 1]!.comma) next = parseGroup(toks, i, lang, null, false);
    else if (AND.has(t.f)) {
      sep = " and ";
      next = parseGroup(toks, i + 1, lang, null, false);
    } else if (FOR.has(t.f)) {
      sep = ABOUT_HEADS.has(last.noun?.en ?? "") ? " about " : " for ";
      next = parseGroup(toks, i + 1, lang, null, false);
    } else if (OF.has(t.f) && (t.greek || lang === "greeklish")) {
      const date = dateAt(toks, i + 1);
      if (date) {
        rest += ` on ${date.text}`;
        i = date.next;
        continue;
      }
      sep = " of ";
      next = parseGroup(toks, i + 1, lang, "def", false);
    } else break;
    if (!next) break;
    rest += sep + renderGroup(next.g, true);
    last = next.g;
    i = next.next;
  }
  const { word, plural } = nounForm(head);
  // A known deliverable is named by itself (“the brochures”); another noun keeps what says which one (“the delivery address”).
  const which = head.noun?.known ? [] : [...adjWords(head, false), ...[...head.mods].reverse(), ...adjWords(head, true)];
  return {
    title: wordsOf(renderGroup(head, false) + rest),
    text: renderGroup(head, true) + rest,
    ref: word ? ["the", ...which, word].join(" ") : null,
    plural,
    plainHead: !!head.noun?.known && !head.adjs.length,
  };
}

/** «για την παράσταση» → “for the show”, or null. */
function glossPurpose(purpose: string, lang: Lang): string | null {
  const [first, ...rest] = wordsOf(purpose);
  if (!first || !FOR.has(bare(first))) return null;
  const g = glossPhrase(rest, lang, null);
  return g ? `for ${g.text}` : null;
}

// ── Matching across languages ────────────────────────────────────────────────

/** Codes, model names and ids that read the same in any language (“CE”, “LED”, “PRX915”, “SM58”, “5m”, “2026-1187”). */
const MATCH_CODE = /^([A-Z]{2,}[A-Z\d-]*|(?=[A-Za-z\d-]*\d)(?=[A-Za-z\d-]*[A-Za-z])[A-Za-z\d-]{2,}|\d{3,}([-/.]\d+)*)$/u;

/**
 * What a text is about, whatever its language: the deliverables it names (“quote”, «προσφορά» and “prosfora” are one
 * key), the other nouns of the lexicon, and its codes. The mock matches an English task title to Greek mail with it.
 */
export function conceptKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const f = foldForMatch(text);
  for (const n of NOUNS) if (n.re.test(f)) keys.add(n.en);
  for (const raw of text.split(/[^\p{L}\p{N}\-/.]+/u)) {
    const w = raw.replace(/^[-/.]+|(?<![-/.])[-/.]+$/gu, "");
    if (!w) continue;
    if (MATCH_CODE.test(w)) keys.add(w.toLowerCase());
    const t = foldAligned(w);
    const g = GREEK_LETTER.test(w) ? MORE_NOUNS.find((x) => x.re.test(t)) : MORE_NOUNS.find((x) => x.en === t || x.pl === t);
    if (g) keys.add(g.en);
  }
  return keys;
}

// ── Titles ───────────────────────────────────────────────────────────────────

const MAX_TITLE_WORDS = 8;
const MAX_TITLE_CHARS = 70;
const TITLE_DANGLING = new Set([...DANGLING, "about", "at", "from"]);

/** At most 8 words / 70 characters, never ending on a preposition, an article or (when cut) a bare number. */
function limitWords(words: string[]): string[] {
  let out = words.slice(0, MAX_TITLE_WORDS);
  while (out.length > 1 && out.join(" ").length > MAX_TITLE_CHARS) out = out.slice(0, -1);
  const cut = out.length < words.length;
  const dangling = (w: string) => {
    const f = foldAligned(w).replace(/(?<![,.;:])[,.;:]+$/u, "");
    return TITLE_DANGLING.has(f) || (cut && /^\d+$/u.test(f));
  };
  while (out.length > 1 && dangling(out[out.length - 1]!)) out = out.slice(0, -1);
  if (out.length) out[out.length - 1] = out[out.length - 1]!.replace(/(?<![,;:])[,;:]+$/u, "");
  return out;
}

const bare = (w: string) => foldAligned(w).replace(/[«»“”"'()[\],.;:!?]+/gu, "");

export interface TitleParts {
  title: string;
  /** The title already states the action (“Reserve 10 XLR cables”), so an imperative next step would only restate it. */
  actionTitle: boolean;
  /** The object for P1's next step (“the quote”), when known. */
  objectRef: string | null;
  /** {@link objectRef} as a pronoun (“you promised them for …”). */
  pronoun: "it" | "them";
  /** What is wanted, for the summary (“a quote for 4 JBL PRX915 speakers”); null when only the subject says it. */
  what: string | null;
  /** The action asked for, for the summary (“confirm the delivery for order 4471”). */
  act: string | null;
  /** Why, from a purpose clause (“for the show”). */
  why: string | null;
  /** The title is the email's subject (no object phrase named the deliverable). */
  fromSubject?: boolean;
}

const POSSESSIVES = new Set(["your", "our", "my", "their", "his", "her", "its"]);
/** Where the object of an English next step ends (“the invoice for the August rental” → “the invoice”). */
const REF_END = new Set(["for", "of", "with", "to", "from", "by", "in", "on", "at", "about", "before", "until", "and", "or", "as"]);

/** An English object, as written. */
function writtenTitle(o: ObjectPhrase): TitleParts | null {
  let words = o.objectWords.filter((w) => !GREEK_LETTER.test(w));
  while (words.length > 1 && POSSESSIVES.has(bare(words[0]!))) words = words.slice(1);
  if (!words.length) return null;
  // “Reserve 10 XLR cables”, “Confirm delivery date for order 4471”; not “Pay balance of invoice 1234”.
  const head = words.findIndex((w) => !!nounOf(w));
  const actionTitle = !!o.action && head >= 0 && head <= 2 && words.slice(0, head).every((w) => !REF_END.has(bare(w)));
  const title = actionTitle ? limitWords([o.action!, ...words]).join(" ") : cap(limitWords(words).join(" "));
  const ref: string[] = [];
  for (const w of words) {
    const f = bare(w);
    if (REF_END.has(f)) break;
    if (!/^\d/u.test(f)) ref.push(w.replace(/(?<![,;:])[,;:]+$/u, ""));
  }
  const written = wordsOf(o.asWritten).filter((w) => !GREEK_LETTER.test(w)).join(" ");
  return {
    title,
    actionTitle,
    objectRef: ref.length ? `the ${ref.join(" ")}` : null,
    pronoun: /[^s]s$/iu.test(ref[ref.length - 1] ?? "") ? "them" : "it",
    what: written || null,
    act: o.action && written ? `${o.action.toLowerCase()} ${written}` : null,
    why: null,
  };
}

/** Title (and the object for P1's next step, and what the summary says) from an object phrase. */
export function titleFromObject(o: ObjectPhrase): TitleParts | null {
  if (o.lang === "en") return writtenTitle(o);
  const g = glossPhrase(o.objectWords, o.lang, o.det);
  if (!g) return null;
  // «εξοφλήσετε το τιμολόγιο 1234» → “Pay invoice 1234”.
  const actionTitle = !!o.action && g.plainHead;
  return {
    title: actionTitle ? limitWords([o.action!, ...g.title]).join(" ") : cap(limitWords(g.title).join(" ")),
    actionTitle,
    objectRef: g.ref,
    pronoun: g.plural ? "them" : "it",
    what: g.text,
    act: o.action ? `${o.action.toLowerCase()} ${g.text}` : null,
    why: o.purpose ? glossPurpose(o.purpose, o.lang) : null,
  };
}

// ── Subjects ─────────────────────────────────────────────────────────────────

const MAX_SUBJECT_CHARS = 70;

/** Subject without reply/forward prefixes, at most `max` characters cut at a word boundary; null when empty. */
export function cleanSubject(subject: string, max = MAX_SUBJECT_CHARS): string | null {
  let s = subject.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 5; i++) s = s.replace(/^\s*(re|fw|fwd|aw|wg|απ|πρθ|σχετ|re\[\d+\]|automatic reply|αυτόματη απάντηση)\s*:\s*/iu, "");
  if (s.length > max) {
    const space = s.lastIndexOf(" ", max);
    s = space >= max / 2 ? s.slice(0, space) : s.slice(0, max);
  }
  s = s.replace(/(?<![\s,;:·\-–—])[\s,;:·\-–—]+$/u, "").trim();
  return s || null;
}

/** Title when neither the text nor the subject names the deliverable. */
const GENERIC_TITLE = "Task from email";

/** Subject openings the prompt forbids in a title («Αίτημα για …», «Θέμα:», «Απάντηση σε …», «Σχετικά με …», “Request for …”). */
const EMPTY_OPENING =
  /^((αιτημα|θεμα|ερωτημα)(\s+(για|σχετικα με))?|απαντηση\s+(σε|για)|σχετικα\s+με|(request|subject|query)(\s+(for|about|regarding))?|reply\s+(to|about)|regarding|about)(\s*[:\-–—]\s*|\s+|$)/u;
/** Where a long subject can end: before a purpose or a topic («… για το συνέδριο …»). */
const SUBJECT_BREAKS = new Set(["για", "σχετικα", "με", "απο", "προσ", "regarding", "for", "about"]);

/**
 * A title from the subject: the forbidden openings dropped, at most 8 words (a long subject ends before «για …» when
 * it can), unpaired quotes removed, a Greek or Greeklish subject in English; null when nothing is left («Θέμα»).
 */
function subjectTitle(subject: string, mailLang: Lang): string | null {
  const m = EMPTY_OPENING.exec(foldAligned(subject));
  let s = m ? subject.slice(m[0].length) : subject;
  s = balanceQuotes(s).replace(/^[«“"](.+)[»”"]$/u, "$1");
  if (!/[\p{L}\p{N}]/u.test(s)) return null;
  let words = wordsOf(s);
  // «Σχετικά με την παραγγελία 4471» → “Order 4471”.
  if (m && words.length > 1 && ARTICLES.has(bare(words[0]!))) words = words.slice(1);
  if (words.length > MAX_TITLE_WORDS) {
    const cut = words.findIndex((w, i) => i >= 3 && SUBJECT_BREAKS.has(bare(w)));
    if (cut > 0 && cut <= MAX_TITLE_WORDS) words = words.slice(0, cut);
  }
  const lang: Lang = isGreek(s) ? "el" : mailLang === "greeklish" ? "greeklish" : latinLang(s);
  if (lang !== "en") {
    const g = glossPhrase(words, lang, null);
    return g ? cap(limitWords(g.title).join(" ")) : null;
  }
  const title = balanceQuotes(limitWords(words.filter((w) => !GREEK_LETTER.test(w))).join(" "));
  return title ? cap(title) : null;
}

/** Drop a leading «<company or person> —/-/:» label that a subject or an old-style title may carry. */
export function stripLabel(title: string, labels: Array<string | null | undefined>): string {
  const m = /^(.+?)\s*(?:\s[—–-]\s|:)\s*(.+)$/u.exec(title);
  if (!m) return title;
  const prefix = labelKey(m[1]!);
  if (!prefix) return title;
  const hit = labels.some((l) => {
    const k = labelKey(l);
    return !!k && (k === prefix || k.startsWith(`${prefix} `) || prefix.startsWith(`${k} `));
  });
  return hit && /[\p{L}\p{N}]/u.test(m[2]!) ? cap(m[2]!.trim()) : title;
}

const LEGAL_SUFFIX = /\s+(α\.?ε\.?|ε\.?π\.?ε\.?|ο\.?ε\.?|ι\.?κ\.?ε\.?|ε\.?ε\.?|ltd\.?|s\.?a\.?|gmbh|inc\.?|llc)$/u;

/** Folded company/person label without a legal-form suffix («ABC Α.Ε.» → «abc»). */
export function labelKey(label: string | null | undefined): string | null {
  if (!label) return null;
  const k = foldForMatch(label).replace(LEGAL_SUFFIX, "").trim();
  return k || null;
}

/** The deliverable a text names, as a title, as the object of a sentence and of P1's next step. */
function fromNoun(noun: ObjectNoun | null): { title: string | null; what: string | null; objectRef: string | null; pronoun: "it" | "them" } {
  if (!noun) return { title: null, what: null, objectRef: null, pronoun: "it" };
  const word = noun.many ? noun.pl : noun.en;
  return {
    title: cap(word),
    what: noun.many || noun.mass ? word : `${/^[aeio]/iu.test(word) ? "an" : "a"} ${word}`,
    objectRef: `the ${word}`,
    pronoun: noun.many ? "them" : "it",
  };
}

/**
 * A title for a task: from the object phrase; a one-word title borrows the subject when the subject names the same
 * thing more precisely (“Quote” + «ΑΠ: Προσφορά ηχείων» → “Speaker quote”); else the cleaned subject.
 */
export function taskTitle(o: ObjectPhrase | null, subject: string, labels: Array<string | null | undefined>, fallbackText: string): TitleParts {
  // The whole subject: subjectTitle picks at most 8 words from it (a pre-cut subject would end mid-phrase).
  const subj = cleanSubject(subject, Number.MAX_SAFE_INTEGER);
  const subjClean = subj ? stripLabel(subj, labels) : null;
  const subjTitle = subjClean ? subjectTitle(subjClean, isGreek(fallbackText) ? "el" : latinLang(fallbackText)) : null;
  let parts = o ? titleFromObject(o) : null;
  if (parts && wordsOf(parts.title).length === 1 && subjTitle && !parts.actionTitle) {
    const stem = foldForMatch(parts.title).slice(0, 5);
    const subjFold = foldForMatch(subjTitle);
    const withSubject = `${parts.title} (${subjTitle})`;
    if (subjFold.includes(stem)) parts = { ...parts, title: subjTitle };
    else if (wordsOf(subjFold).length >= 2 && wordsOf(withSubject).length <= MAX_TITLE_WORDS) parts = { ...parts, title: withSubject };
  }
  if (!parts) {
    const noun = fromNoun(nounIn(fallbackText));
    const common = { actionTitle: false, objectRef: noun.objectRef, pronoun: noun.pronoun, act: null, why: null };
    parts = subjTitle ? { ...common, title: subjTitle, what: null, fromSubject: true } : { ...common, title: noun.title ?? GENERIC_TITLE, what: noun.what };
  }
  return { ...parts, title: stripLabel(parts.title, labels) };
}

// ── Next step and summary ────────────────────────────────────────────────────

/** “Thursday 17 Sep” for a YYYY-MM-DD date (stored text is read days later, so never “tomorrow”). */
export function dayLabel(iso: string | null | undefined): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${EN_WEEKDAYS[(d.getUTCDay() + 6) % 7]} ${Number(m[3])} ${EN_MONTHS_SHORT[Number(m[2]) - 1]}`;
}

/** Which kind of task the next step and the summary describe. */
export type TaskKind =
  | "request" // someone asked P1 (ACTION_REQUIRED)
  | "promise" // P1 promised (WAITING_FOR_ME)
  | "ask" // P1 asked someone and waits (WAITING_FOR_OTHER)
  | "promised_to_me" // the other side promised P1 (WAITING_FOR_OTHER)
  | "handover_in" // a colleague asked P1 to take a request over (ACTION_REQUIRED)
  | "handover_out"; // P1 handed a request over to a colleague (the colleague's task)

export const MAX_NEXT_ACTION = 60;

function fit(options: Array<string | null>): string | null {
  return options.find((x): x is string => !!x && x.length <= MAX_NEXT_ACTION) ?? null;
}

/** P1's next step (imperative, ≤ 60 characters), or null when it would only restate the title. */
export function nextAction(kind: TaskKind, o: ObjectPhrase | null, parts: TitleParts, date: string | null): string | null {
  // Always weekday + date (“Thursday 17 Sep”), never a bare weekday: the text is read for days (prompt “Days in …”).
  const day = dayLabel(date);
  const ref = parts.objectRef;
  // «πείτε μου την τελική τιμή» → “Send the price” (Reply takes no direct object).
  const verb = !o?.imperative || o.imperative === "Reply" ? "Send" : o.imperative;
  const base = ref ? `${verb} ${ref}` : null;
  let out: string | null = null;
  switch (kind) {
    case "request":
    case "handover_in":
      if (parts.actionTitle) return null;
      out = base ?? (o?.imperative === "Reply" ? "Answer their question" : null);
      break;
    case "promise":
      if (!base) return null;
      out = day ? fit([`${base} — you promised ${parts.pronoun} for ${day}`, `${base} you promised`]) : fit([`${base} you promised`, base]);
      break;
    case "ask":
      out = day ? fit([`Follow up if they haven't replied by ${day}`]) : null;
      break;
    case "promised_to_me":
      out = day ? fit([ref ? `Follow up if they haven't sent ${parts.pronoun} by ${day}` : null, `Follow up if they haven't replied by ${day}`]) : null;
      break;
    case "handover_out":
      return null;
  }
  if (!out) return null;
  if (foldForMatch(out) === foldForMatch(parts.title)) return null;
  return fit([out]);
}

export interface Party {
  name: string | null;
  company: string | null;
  address: string | null;
}

const who = (p: Party | null) => (p ? (p.name && p.company ? `${p.name} (${p.company})` : (p.name ?? p.company ?? p.address ?? "The sender")) : "The sender");
const whoParen = (p: Party | null) => (p ? [p.name, p.company].filter(Boolean).join(", ") || p.address || "" : "");

/** A VAGUE deadline in English: «σύντομα» is soon; «το συντομότερο», «άμεσα» and ASAP are as soon as possible. */
function vagueWhen(phrase: string): string {
  return /(?<!\p{L})(συντομα|syntoma)(?!\p{L})/u.test(foldForMatch(phrase)) ? "soon" : "as soon as possible";
}

/**
 * One sentence: who wants what (and why), with the deadline. What is wanted is the object (“the final price for 500 m
 * of cable”; with an action, “asks you to confirm the delivery for order 4471”); a title that is only the subject is
 * quoted (“asks for a reply about “Yamaha QL5 console fault””), and the generic title is just “a reply”.
 */
export function summary(kind: TaskKind, parts: TitleParts, due: DueSpec | null, people: { party: Party | null; colleague?: Party | null }): string {
  const day = dayLabel(due?.model_date);
  const by = day ? `, by ${day}` : due?.kind === "VAGUE" ? `, ${vagueWhen(due.phrase)}` : "";
  const forDay = day ? ` for ${day}` : "";
  const party = people.party;
  const paren = whoParen(party) ? ` (${whoParen(party)})` : "";
  const why = parts.why ? ` ${parts.why}` : "";
  const generic = parts.title === GENERIC_TITLE && !parts.what;
  const quoted = `“${parts.title}”`;
  const thing = parts.what ?? (generic ? "a reply" : `a reply about ${quoted}`);
  const handed = parts.act ?? parts.what ?? (generic ? "the request" : quoted);
  switch (kind) {
    case "request":
      return parts.act ? `${who(party)} asks you to ${parts.act}${why}${by}.` : `${who(party)} asks for ${thing}${why}${by}.`;
    case "promise":
      return parts.act ? `You promised to ${parts.act}${forDay}${paren}.` : `You promised ${thing}${forDay}${paren}.`;
    case "ask": {
      const reply = day ? `, with a reply by ${day}` : "";
      if (parts.act) return `You asked them to ${parts.act}${reply}${paren}.`;
      if (parts.what) return `You asked for ${parts.what}${reply}${paren}.`;
      return generic ? `You asked for a reply${day ? ` by ${day}` : ""}${paren}.` : `You asked about ${quoted}${reply}${paren}.`;
    }
    case "promised_to_me":
      return parts.act ? `${who(party)} promised to ${parts.act}${forDay}.` : `${who(party)} promised ${thing}${forDay}.`;
    case "handover_in":
      return `${who(people.colleague ?? null)} asks you to take over: ${handed}${why}${paren}${by}.`;
    case "handover_out":
      return `Handed over to ${people.colleague?.name ?? people.colleague?.address ?? "a colleague"}: ${handed}${why}${paren}${by}.`;
  }
}
