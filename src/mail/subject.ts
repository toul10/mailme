import { foldForSearch } from "../lib/text.js";

/**
 * Reply/forward/auto-response prefix tokens (EN/EL/common European clients). Matched case-insensitively,
 * optionally followed by a counter ("RE[2]:", "RE(2):", "Re^2:", "RE*2:") and a colon (ASCII or full-width).
 */
const PREFIX_TOKENS = [
  // replies
  "re", "aw", "sv", "vs", "antw", "rif", "odp", "ynt", "απ", "απαντ", "απαντηση", "απάντηση", "σχετ", "σχετικα", "σχετικά",
  // forwards
  "fw", "fwd", "fwrd", "wg", "tr", "enc", "rv", "πρθ", "προωθ", "προώθ", "προωθηση", "προώθηση",
  // auto responses & calendar responses (so they thread with the original)
  "automatic reply", "auto reply", "autoreply", "out of office", "αυτόματη απάντηση", "αυτοματη απαντηση",
  "accepted", "declined", "tentative", "αποδεκτό", "αποδεκτο", "απορρίφθηκε", "απορριφθηκε", "με επιφύλαξη", "με επιφυλαξη",
];

/** Bracketed tags added by gateways/filters: "[EXT]", "(External)", "***SPAM***", "[SUSPECTED SPAM]". */
const BRACKET_TAGS = ["ext", "external", "εξωτερικό", "εξωτερικο", "spam", "suspected spam", "possible spam", "πιθανό spam", "πιθανο spam"];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first so "fwd" wins over "fw" and "απαντηση" over "απ".
const tokenAlt = [...PREFIX_TOKENS].sort((a, b) => b.length - a.length).map(esc).join("|");
const PREFIX_RE = new RegExp(`^(${tokenAlt})\\s*(?:\\[\\d+\\]|\\(\\d+\\)|\\^\\d+|\\*\\d+)?\\s*[:：]\\s*`, "iu");
const tagAlt = [...BRACKET_TAGS].sort((a, b) => b.length - a.length).map(esc).join("|");
const TAG_RE = new RegExp(`^(?:\\[\\s*(${tagAlt})\\s*\\]|\\(\\s*(${tagAlt})\\s*\\)|\\*{2,3}\\s*(${tagAlt})\\s*\\*{2,3})\\s*[:：]?\\s*`, "iu");

/** Reply/forward prefixes are stripped repeatedly, case-insensitively (RE: FW: FWD: ΑΠ: ΠΡΘ: ΣΧΕΤ: AW: WG: RE[2]: [EXT] …). */
export function stripSubjectPrefixes(subject: string): { base: string; prefixes: string[] } {
  let s = (subject ?? "").replace(/[\r\n\t]+/g, " ").trim();
  const prefixes: string[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const p = PREFIX_RE.exec(s);
    if (p) {
      prefixes.push(p[1]!.toUpperCase());
      s = s.slice(p[0].length);
      continue;
    }
    const t = TAG_RE.exec(s);
    if (t) {
      prefixes.push((t[1] ?? t[2] ?? t[3] ?? "").toUpperCase());
      s = s.slice(t[0].length);
      continue;
    }
    break;
  }
  return { base: s.trim(), prefixes };
}

/** Prefix-stripped, accent/case-folded subject used for thread matching. */
export function normalizeSubject(subject: string): string {
  return foldForSearch(stripSubjectPrefixes(subject).base);
}

const FORWARD_PREFIXES = new Set(["FW", "FWD", "FWRD", "WG", "TR", "ENC", "RV", "ΠΡΘ", "ΠΡΟΩΘ", "ΠΡΟΏΘ", "ΠΡΟΩΘΗΣΗ", "ΠΡΟΏΘΗΣΗ"]);
const TAG_PREFIXES = new Set(BRACKET_TAGS.map((t) => t.toUpperCase()));

/** True when the outermost reply/forward prefix (ignoring gateway tags like [EXT]) is a forward (FW/FWD/ΠΡΘ…). */
export function isForwardSubject(subject: string): boolean {
  const first = stripSubjectPrefixes(subject).prefixes.find((p) => !TAG_PREFIXES.has(p));
  return first !== undefined && FORWARD_PREFIXES.has(first);
}

/**
 * A forward by its subject: {@link isForwardSubject}, or ΠΡ: — the forward prefix of Greek Outlook, which is not in
 * PREFIX_TOKENS (thread matching does not strip it).
 */
export function isForwardLike(subject: string): boolean {
  return isForwardSubject(subject) || /^\s*πρ\s*[:：]/iu.test(subject ?? "");
}

/** True when the subject carries any reply/forward prefix (ignoring gateway tags). */
export function hasReplyOrForwardPrefix(subject: string): boolean {
  return stripSubjectPrefixes(subject).prefixes.some((p) => !TAG_PREFIXES.has(p));
}

/** Folded words that carry no identifying information on their own. */
const GENERIC_WORDS = new Set([
  // Greek (folded: no accents, ς→σ)
  "προσφορα", "προσφορεσ", "παραγγελια", "παραγγελιεσ", "τιμοκαταλογοσ", "τιμοκαταλογοι", "τιμοκαταλογου", "τιμολογιο",
  "τιμολογια", "τιμεσ", "τιμη", "ερωτηση", "ερωτησεισ", "αιτημα", "πληροφοριεσ", "πληροφορια", "επικοινωνια", "ενημερωση",
  "καλημερα", "καλησπερα", "γεια", "χαιρετε", "ευχαριστω", "ευχαριστουμε", "συναντηση", "ραντεβου", "θεμα", "δοκιμη",
  "επισυναπτομενα", "επισυναπτομενο", "συνημμενο", "συνημμενα", "αρχειο", "αρχεια", "εγγραφο", "εγγραφα", "σαρωση",
  "φωτογραφιεσ", "φωτογραφια", "νεα", "νεο", "νεοσ", "επειγον", "σημαντικο", "υπενθυμιση", "παραστατικα", "παραστατικο",
  "αποστολη", "πληρωμη", "εξοφληση", "κατασταση", "στοιχεια", "ζητημα", "ερωτημα", "χωρισ",
  // English
  "offer", "offers", "quote", "quotation", "order", "orders", "invoice", "invoices", "price", "prices", "pricelist", "list",
  "question", "questions", "request", "info", "information", "hello", "hi", "meeting", "update", "subject", "no", "test",
  "document", "documents", "scan", "scanned", "file", "files", "attachment", "attachments", "attached", "photo", "photos",
  "urgent", "important", "reminder", "payment", "status", "details", "new", "untitled", "fyi",
]);

/** Function words ignored when judging genericity. */
const STOP_WORDS = new Set([
  "για", "την", "τη", "το", "τον", "τα", "τησ", "του", "των", "και", "σε", "στο", "στη", "στην", "στα", "απο", "με", "μασ",
  "σασ", "η", "ο", "οι", "ενα", "μια", "νεα", "the", "a", "an", "for", "of", "to", "and", "your", "our", "my", "re", "fw",
]);

const MONTHS_FOLDED = new Set([
  "ιανουαριοσ", "φεβρουαριοσ", "μαρτιοσ", "απριλιοσ", "μαιοσ", "ιουνιοσ", "ιουλιοσ", "αυγουστοσ", "σεπτεμβριοσ", "οκτωβριοσ",
  "νοεμβριοσ", "δεκεμβριοσ", "ιανουαριου", "φεβρουαριου", "μαρτιου", "απριλιου", "μαιου", "ιουνιου", "ιουλιου", "αυγουστου",
  "σεπτεμβριου", "οκτωβριου", "νοεμβριου", "δεκεμβριου", "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
]);

/** True for subjects too generic to link threads by subject alone ("προσφορα" offer, "παραγγελια" order, empty, …). Input: normalizeSubject output. */
export function isGenericSubject(normalized: string): boolean {
  const s = (normalized ?? "").trim();
  if (s.length <= 3) return true;
  const words = s.split(/\s+/).filter((w) => w && !STOP_WORDS.has(w));
  if (words.length === 0) return true;
  return words.every(
    (w) => GENERIC_WORDS.has(w) || MONTHS_FOLDED.has(w) || /^(19|20)\d\d$/.test(w) || /^\d{1,2}$/.test(w) || /^[\p{P}\p{S}]+$/u.test(w),
  );
}
