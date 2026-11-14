import type { Address, Direction, FilterReason, FolderRole, MessageClass, ParsedMail, Segment } from "../domain/types.js";
import { senderMatches } from "../domain/preferences.js";
import { ignoreRuleFor, spamFilterOn, topicText, type MailRule } from "../domain/rules.js";
import { foldForMatch, PUBLIC_MAIL_DOMAINS } from "../lib/text.js";
import { decodeEntities, htmlToPlainText } from "./html.js";
import { hasReplyOrForwardPrefix, stripSubjectPrefixes } from "./subject.js";

export interface PrefilterInput {
  parsed: ParsedMail;
  direction: Direction;
  folderRole: FolderRole | null;
  flags: string[];
  platformMailDomain: string;
  /** Known APPEND uids / message ids of platform mail for this mailbox. */
  isKnownPlatformMessage: boolean;
  /** Sender/domain deny-list (lower-cased addresses or "@domain"). */
  denyList: string[];
  /** The mailbox owner's "Ignore" list (addresses or "@domain", src/domain/preferences.ts). Optional. */
  mutedList?: string[];
  /** Addresses the owner has corresponded with before (spam-folder rescue). */
  isKnownContact: boolean;
  /** Segments already computed by ingest (used for the EMPTY rule); derived from the parsed body when absent. */
  segments?: Segment[];
  /**
   * The owner's own domains, lower-cased: those of the mailbox address and aliases (free-mail domains excluded) and
   * the organization's internal domains. Used by the PHISHING rule; optional.
   */
  ownDomains?: string[];
  /** From = an owner address on a copy the server delivered and that was never seen in Sent (direction.ts). */
  claimsOwnerSender?: boolean;
  /** The user's own rules (users.mail_rules): a disabled spam rule, ignore rules. Optional; none = no rule filtering. */
  rules?: MailRule[];
}

export interface PrefilterResult {
  /** null → goes to AI. */
  reason: FilterReason | null;
  classification: MessageClass | null;
  /** reason RULE: the id of the user's rule. */
  rule?: string;
}

const CLASS_OF: Record<FilterReason, MessageClass | null> = {
  OWN_MAIL: "AUTOMATED",
  BULK: "MARKETING",
  NOREPLY: "AUTOMATED",
  DENYLIST: "PERSONAL",
  MUTED: null,
  BOUNCE: "AUTOMATED",
  OUT_OF_OFFICE: "AUTOMATED",
  CALENDAR_REPLY: "AUTOMATED",
  SPAM_FOLDER: "SPAM",
  PHISHING: "SPAM",
  RULE: null,
  DRAFT_OR_DELETED: null,
  TOO_OLD: null,
  EMPTY: null,
  ENCRYPTED: null,
};

const hit = (reason: FilterReason): PrefilterResult => ({ reason, classification: CLASS_OF[reason] });

/**
 * Rules only, no AI. Own/platform mail is checked first. Order after that: drafts/deleted,
 * deny-list (privacy), the owner's muted senders, bounce (before noreply: MAILER-DAEMON mail must stay BOUNCE for the engine), out-of-office
 * (before bulk: auto-replies often carry Precedence), calendar replies, bulk, noreply, spam folder, phishing, the user's
 * ignore rules, encrypted, empty. A user's disabled spam rule turns the spam folder and phishing rules off.
 */
export function prefilter(input: PrefilterInput): PrefilterResult {
  const { parsed, direction } = input;
  const h = parsed.headers;

  if (isOwnPlatformMail(input.isKnownPlatformMessage)) return hit("OWN_MAIL");

  const flags = input.flags.map((f) => f.toLowerCase());
  if (input.folderRole === "drafts" || flags.includes("\\draft") || flags.includes("\\deleted")) return hit("DRAFT_OR_DELETED");

  if (isDenied(parsed, direction, input.denyList)) return hit("DENYLIST");

  // The owner said "Ignore": inbound mail from that sender or domain creates nothing (outbound mail to them still
  // counts: a promise made to a muted sender is still a promise).
  if (direction === "INBOUND" && input.mutedList?.length && senderMatches(parsed.from?.address, input.mutedList)) return hit("MUTED");

  if (parsed.bounce) return hit("BOUNCE");

  if (isOutOfOffice(parsed)) return hit("OUT_OF_OFFICE");

  if (isCalendarReply(parsed)) return hit("CALENDAR_REPLY");

  if (direction === "INBOUND" && isBulk(h)) return hit("BULK");

  // Read receipts (MDN) are automated notifications like no-reply mail.
  if (direction === "INBOUND" && (isNoReply(parsed) || parsed.decodeWarnings.includes("mdn"))) return hit("NOREPLY");

  const rules = input.rules ?? [];
  const spamOn = spamFilterOn(rules);
  const spamFlagged = /^\s*yes\b/i.test(h["x-spam-flag"] ?? "");
  if (spamOn && direction === "INBOUND" && (input.folderRole === "junk" || spamFlagged) && !input.isKnownContact) return hit("SPAM_FOLDER");

  // No known-contact rescue: answering a phisher (or a task naming them) must not let their next mail through.
  if (spamOn && direction === "INBOUND" && isPhishingMail(parsed, input.ownDomains ?? [], input.claimsOwnerSender ?? false)) return hit("PHISHING");

  // The user's own "ignore" rules, both directions: subject + new/forwarded text, recipients in To/Cc.
  if (rules.length) {
    const rule = ignoreRuleFor(rules, { folded: topicText(parsed.subject, newText(parsed, input.segments)), recipients: [...parsed.to, ...parsed.cc].map((a) => a.address) });
    if (rule) return { ...hit("RULE"), rule: rule.id };
  }

  if (parsed.decodeWarnings.some((w) => w === "smime_encrypted" || w === "pgp_encrypted")) return hit("ENCRYPTED");

  if (isEmpty(parsed, input.segments)) return hit("EMPTY");

  return { reason: null, classification: null };
}

/**
 * Platform mail = a report recorded in `digests` (its Message-ID, or the recorded APPEND UID), decided by ingest.
 * Headers alone never count: the platform domain is public and X-MailMe-Kind can be forged, and a
 * forged "own mail" would be dropped without a body, thread or report line. The digest row carries its Message-ID
 * before the report is sent or APPENDed, so a real report is always recognised.
 */
export function isOwnPlatformMail(isKnownPlatformMessage: boolean): boolean {
  return isKnownPlatformMessage;
}

function matchesDeny(address: string, denyList: string[]): boolean {
  const a = address.trim().toLowerCase();
  if (!a) return false;
  const domain = a.slice(a.lastIndexOf("@") + 1);
  return denyList.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith("@") || !e.includes("@")) {
      const d = e.replace(/^@/, "");
      return domain === d || domain.endsWith("." + d);
    }
    return a === e;
  });
}

/** INBOUND: the sender is denied. OUTBOUND: every recipient is denied (mail to one's doctor/bank). */
function isDenied(parsed: ParsedMail, direction: Direction, denyList: string[]): boolean {
  if (!denyList.length) return false;
  if (direction === "INBOUND") {
    return [parsed.from, parsed.sender, ...parsed.replyTo].some((a) => !!a && matchesDeny(a.address, denyList));
  }
  const rcpts = [...parsed.to, ...parsed.cc, ...parsed.bcc];
  return rcpts.length > 0 && rcpts.every((a) => matchesDeny(a.address, denyList));
}

/** Subject prefixes only auto-responders write: enough on their own. */
const AUTO_REPLY_SUBJECT =
  /^(automatic reply|auto[- ]?reply|autoreply|auto response|αυτόματη απάντηση|αυτοματη απαντηση|abwesenheitsnotiz|réponse automatique|respuesta automática)/iu;
/**
 * "Out of office" words, English and Greek: people also write them, e.g. the subject «Εκτός γραφείου 28/9-2/10 —
 * εκκρεμότητες» ("Out of office 28/9-2/10 — tasks").
 */
const AWAY_WORDS =
  "out of (?:the )?office|ooo|away from (?:the )?office|on vacation|εκτός γραφείου|εκτος γραφειου|απουσία από το γραφείο|απουσια απο το γραφειο";
/**
 * The auto-responder form: the words alone, or followed by ':' and the original subject ("Out of office: …",
 * «Εκτός γραφείου: …»).
 */
const AWAY_SUBJECT_AUTO = new RegExp(`^(?:${AWAY_WORDS})(?:\\s*\\(?auto[- ]?reply\\)?)?\\s*(?::|$)`, "iu");
const AWAY_SUBJECT_ANY = new RegExp(`^(?:${AWAY_WORDS})(?=[\\s:,.!()\\-–—]|$)`, "iu");

/**
 * RFC 3834 Auto-Submitted: auto-replied, X-Autoreply/X-Autorespond, Exchange OOF, or an OOO subject.
 * Bare "out of office" words count only in the auto-responder form or with some automation hint, so a colleague's
 * handover mail titled "Out of office 28/9-2/10 — tasks" (in Greek or English) still reaches the AI.
 */
function isOutOfOffice(parsed: ParsedMail): boolean {
  const h = parsed.headers;
  const auto = (h["auto-submitted"] ?? "").trim().toLowerCase();
  if (auto.startsWith("auto-replied")) return true;
  if (h["x-autoreply"] !== undefined || h["x-autorespond"] !== undefined) return true;
  const oof = (h["x-ms-exchange-organization-autoreplytype"] ?? "").toLowerCase();
  if (oof.includes("oof") || oof.includes("autoreply")) return true;
  const subj = parsed.subject.trim();
  if (AUTO_REPLY_SUBJECT.test(subj) || AWAY_SUBJECT_AUTO.test(subj)) return true;
  if (AWAY_SUBJECT_ANY.test(subj) && hasAutomationHint(h)) return true;
  // "ΑΠ: Εκτός γραφείου" ("RE: Out of office") style: check the base too, but only when the message is automated.
  const base = stripSubjectPrefixes(subj).base;
  return auto.startsWith("auto-generated") && (AUTO_REPLY_SUBJECT.test(base) || AWAY_SUBJECT_ANY.test(base));
}

/** Headers auto-responders set (a human mail has none of them). */
function hasAutomationHint(h: Record<string, string>): boolean {
  const auto = (h["auto-submitted"] ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return true;
  const prec = (h["precedence"] ?? "").trim().toLowerCase();
  if (prec === "auto_reply" || prec === "bulk" || prec === "junk" || prec === "list") return true;
  if (h["x-auto-response-suppress"] !== undefined) return true;
  return /^\s*<\s*>\s*$/.test(h["return-path"] ?? "");
}

const CAL_REPLY_SUBJECT = /^(accepted|declined|tentative|tentatively accepted|αποδεκτό|αποδεκτο|απορρίφθηκε|απορριφθηκε|με επιφύλαξη|με επιφυλαξη|προσωρινά αποδεκτό|προσωρινα αποδεκτο|angenommen|abgelehnt)\s*:/iu;

function isCalendarReply(parsed: ParsedMail): boolean {
  if (parsed.calendar?.method === "REPLY") return true;
  return parsed.calendar !== null && CAL_REPLY_SUBJECT.test(parsed.subject.trim());
}

function isBulk(h: Record<string, string>): boolean {
  if (h["list-unsubscribe"]) return true;
  const prec = (h["precedence"] ?? "").trim().toLowerCase();
  if (prec === "bulk" || prec === "junk") return true;
  return !!(h["feedback-id"] || h["x-mailchimp-campaign"] || h["x-campaign"]);
}

const NOREPLY_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noreply[-_.+].*|no[-_.]?reply[-_.+].*|mailer-daemon|postmaster|bounces?([-_.+].*)?|notifications?([-_.+].*)?|notify|alerts?|auto[-_.]?(reply|confirm|mailer)|automailer|system|ne[-_.]?pas[-_.]?repondre)$/i;

function isNoReply(parsed: ParsedMail): boolean {
  const addrs = [parsed.from, parsed.sender].filter((a): a is NonNullable<typeof a> => !!a);
  if (addrs.some((a) => NOREPLY_LOCAL.test(a.address.split("@")[0] ?? ""))) return true;
  return parsed.replyTo.length > 0 && parsed.replyTo.every((a) => NOREPLY_LOCAL.test(a.address.split("@")[0] ?? "") && /^no/i.test(a.address));
}

/** The NEW and FORWARDED text (not quoted history), from the segments when ingest has them. */
function newText(parsed: ParsedMail, segments: Segment[] | undefined): string {
  if (segments) return segments.filter((s) => s.kind === "NEW" || s.kind === "FORWARDED").map((s) => s.text).join("\n");
  return parsed.textPlain?.trim() || (parsed.textHtml ? htmlToPlainText(parsed.textHtml) : "");
}

/** Nothing new to read: no NEW/FORWARDED text, no real attachment, no calendar, and no own subject either. */
function isEmpty(parsed: ParsedMail, segments: Segment[] | undefined): boolean {
  const hasNewText = segments
    ? segments.some((s) => (s.kind === "NEW" || s.kind === "FORWARDED") && s.text.trim().length > 0)
    : !!(parsed.textPlain?.trim() || (parsed.textHtml ? htmlToPlainText(parsed.textHtml) : ""));
  if (hasNewText) return false;
  if (parsed.attachments.some((a) => !a.inline)) return false;
  if (parsed.calendar) return false;
  const base = stripSubjectPrefixes(parsed.subject).base;
  return !base || hasReplyOrForwardPrefix(parsed.subject);
}

// ── Phishing: impersonation of the owner + a lure ────────────────────────────

/** What the PHISHING rule saw; exported for tests and for checking the rule against stored mail. */
export interface PhishingSignals {
  /**
   * The display name names a sender the address does not belong to: an own domain («contoso.example Support»), another
   * domain («Viva.com – Security Department» <…@gmail.com>, «Gov.gr» <…@govgre.eu>), a bank / payment / state brand
   * sent from elsewhere («EUROBANK», «ᴏᴘᴛɪᴍᴀʙᴀɴᴋ»), or a «bank» writing from free mail.
   */
  displayNameSpoof: boolean;
  /** From is an own-domain or owner address, but the server's SpamAssassin saw neither SPF pass nor an aligned DKIM signature. */
  forgedSender: boolean;
  /** Credential, mailbox-closure or extortion bait in the subject or the text. */
  lure: boolean;
  /** SpamAssassin's own phishing/extortion tests fired, even though its score stayed under the server's threshold. */
  spamAssassinPhish: boolean;
}

export interface PhishingInput {
  from: Address | null;
  subject: string;
  /** Unredacted text: the plain part, else the HTML as text. */
  text: string;
  headers: Record<string, string>;
  ownDomains: readonly string[];
  claimsOwnerSender: boolean;
}

/**
 * PHISHING needs an impersonation (of the owner, or of a brand in the display name) AND a lure (or SpamAssassin's
 * phishing tests). One alone is not enough: a contact form that sends as «contoso.example» from the web host, or a
 * colleague forwarding a suspicious mail ("is this real?"), still reaches the AI.
 */
export function isPhishing(s: PhishingSignals): boolean {
  return (s.displayNameSpoof || s.forgedSender) && (s.lure || s.spamAssassinPhish);
}

export function phishingSignals(m: PhishingInput): PhishingSignals {
  return { ...impersonation(m.from, m.headers, m.ownDomains, m.claimsOwnerSender), lure: hasLure(m.subject, m.text), spamAssassinPhish: spamAssassinPhish(m.headers) };
}

/** The prefilter's form of isPhishing(phishingSignals(…)): the text is only extracted for mail that impersonates the owner. */
function isPhishingMail(parsed: ParsedMail, ownDomains: readonly string[], claimsOwnerSender: boolean): boolean {
  const imp = impersonation(parsed.from, parsed.headers, ownDomains, claimsOwnerSender);
  if (!imp.displayNameSpoof && !imp.forgedSender) return false;
  // A blank plain part with the bait only in the HTML is common in phishing kits.
  return spamAssassinPhish(parsed.headers) || hasLure(parsed.subject, parsed.textPlain?.trim() || (parsed.textHtml ? htmlToPlainText(parsed.textHtml) : ""));
}

function impersonation(from: Address | null, headers: Record<string, string>, ownDomains: readonly string[], claimsOwnerSender: boolean): Pick<PhishingSignals, "displayNameSpoof" | "forgedSender"> {
  const own = ownDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  const address = from?.address ?? "";
  const ownFrom = own.length > 0 && senderMatches(address, own.map((d) => `@${d}`));
  const sa = spamAssassinTests(headers);
  return {
    displayNameSpoof: address.includes("@") && !ownFrom && namesAnotherSender(from?.name ?? "", address.slice(address.lastIndexOf("@") + 1), own),
    // Only a complete test list proves a missing SPF_PASS / DKIM_VALID_AU (messages.headers values are capped).
    forgedSender: (ownFrom || claimsOwnerSender) && !!sa?.complete && unauthenticated(sa.tests),
  };
}

/** A domain written in a display name («Viva.com», «info@partner-shop.example», «info.contoso.example»). */
const NAME_DOMAIN = /(?<![\p{L}\p{N}-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:gr|com|net|org|eu|info|biz|io|co|cy|de|it|fr|es|uk|nl|be|at|ch|pl|ro|bg|us|me))(?![\p{L}\p{N}-])/gu;

/** Brands phishing poses as (banks, payments, the state, Microsoft, couriers) → a label their own domains carry. */
const BRANDS: Array<[RegExp, string[]]> = [
  [/eurobank/, ["eurobank"]],
  [/alphabank/, ["alpha", "alphabank"]],
  [/piraeusbank|winbank|τραπεζα πειραιωσ/, ["piraeusbank", "winbank", "piraeusholdings"]],
  [/εθνικη τραπεζα|nationalbankofgreece|\bnbg\b/, ["nbg"]],
  [/optimabank/, ["optimabank"]],
  [/atticabank|τραπεζα αττικησ/, ["atticabank"]],
  [/vivawallet|vivapayments|\bviva com\b/, ["viva", "vivawallet", "vivapayments"]],
  [/paypal/, ["paypal"]],
  [/revolut/, ["revolut"]],
  [/\bgov gr\b|\baade\b|\befka\b|taxisnet|ααδε|εφκα/, ["gov", "aade", "gsis", "efka"]],
  [/microsoft|office365|onedrive|sharepoint/, ["microsoft", "office", "office365", "microsoftonline", "sharepoint", "onmicrosoft", "outlook", "live"]],
  [/docusign/, ["docusign"]],
  [/\bdhl\b/, ["dhl"]],
  [/\belta\b|(?<!\p{L})ελτα(?!\p{L})/u, ["elta", "elta-courier"]],
];

/** Cyrillic / Greek / small-capital letters that pass for Latin ones in a display name («Е u r о b а n k», «ᴏᴘᴛɪᴍᴀʙᴀɴᴋ»). */
const LOOKALIKE: Record<string, string> = Object.fromEntries(
  [
    ["АаΑαᴀ", "a"], ["ВвΒβʙ", "b"], ["СсϹᴄ", "c"], ["ᴅԁ", "d"], ["ЕеΕεᴇ", "e"], ["ꜰ", "f"], ["ɢ", "g"], ["НΗʜ", "h"], ["ІіΙιɪ", "i"],
    ["Јјᴊ", "j"], ["КкΚκᴋ", "k"], ["ʟ", "l"], ["МмΜᴍ", "m"], ["Νɴ", "n"], ["ОоΟοᴏ", "o"], ["РрΡρᴘ", "p"], ["ǫ", "q"], ["ʀ", "r"],
    ["Ѕѕꜱ", "s"], ["ТтΤτᴛ", "t"], ["υᴜ", "u"], ["νᴠ", "v"], ["ᴡ", "w"], ["ХхΧχ", "x"], ["УуΥʏ", "y"], ["Ζᴢ", "z"],
  ].flatMap(([chars, latin]) => [...chars!].map((c) => [c, latin!])),
);

/** The display name names a sender the From domain does not belong to (see PhishingSignals.displayNameSpoof). */
function namesAnotherSender(rawName: string, domain: string, own: readonly string[]): boolean {
  const name = foldForMatch(rawName);
  if (!name) return false;
  if (own.some((d) => name.includes(d))) return true;
  for (const m of name.matchAll(NAME_DOMAIN)) if (!sameSite(m[1]!, domain)) return true;
  // The Latin skeleton, spaced and squashed, catches look-alike letters and «E u r o b a n k».
  const spaced = [...rawName.normalize("NFKC")].map((c) => LOOKALIKE[c] ?? c).join("").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const hay = `${name} | ${spaced} | ${spaced.replace(/ /g, "")}`;
  if (BRANDS.some(([brand, labels]) => brand.test(hay) && !labels.some((l) => domain.split(".").includes(l)))) return true;
  return /\bbank\b|τραπεζ/.test(hay) && PUBLIC_MAIL_DOMAINS.has(domain);
}

/** Same registrable domain, roughly: equal, one inside the other, or equal last two labels (three under com.gr / co.uk). */
function sameSite(a: string, b: string): boolean {
  const site = (d: string) => {
    const l = d.split(".");
    return l.slice(l.length >= 3 && /^(?:com|co|org|net|gov|edu|ac)$/.test(l[l.length - 2]!) && l[l.length - 1]!.length === 2 ? -3 : -2).join(".");
  };
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`) || site(a) === site(b);
}

/** X-Spam-Status «No, score=4.2 required=5.0 tests=A,B, C autolearn=no version=3.4.6» → its tests; complete = not cut short. */
function spamAssassinTests(headers: Record<string, string>): { tests: string[]; complete: boolean } | null {
  const v = headers["x-spam-status"];
  const m = v ? /\btests=(.*?)(?=\s+(?:autolearn|version)=|$)/i.exec(v) : null;
  if (!v || !m) return null;
  return { tests: m[1]!.split(/[\s,]+/).map((t) => t.toUpperCase()).filter(Boolean), complete: /\bversion=\S/i.test(v) };
}

/**
 * The server's SpamAssassin verdict, complete (not cut by the header cap), shows the sender unauthenticated: no SPF
 * pass, no aligned DKIM, and SPF fail/neutral/none or «To = From, straight to the MX». No verdict proves nothing.
 */
export function senderAuthFailed(headers: Record<string, string> | null | undefined): boolean {
  const sa = headers ? spamAssassinTests(headers) : null;
  return !!sa?.complete && unauthenticated(sa.tests);
}

/** No SPF pass and no aligned DKIM, and SpamAssassin saw SPF fail/neutral/none or «To = From, straight to the MX». */
function unauthenticated(tests: string[]): boolean {
  if (tests.includes("SPF_PASS") || tests.includes("DKIM_VALID_AU")) return false;
  return tests.some((t) => /^(?:SPF_(?:NEUTRAL|SOFTFAIL|FAIL|NONE)|TO_EQ_FM_\w+)$/.test(t));
}

/**
 * SpamAssassin tests that name phishing or extortion. PDS_FROM_NAME_TO_DOMAIN / PDS_FRNOM_TODOM_* are left out on
 * purpose: they are SpamAssassin's own display-name check, the same signal as displayNameSpoof.
 */
const SA_PHISH = /^(?:KAM_MAILBOX\w*|TVD_PH_\w+|URIBL_PH_\w+|BITCOIN_\w+|PDS_BTC\w*|\w*PHISH\w*)$/;

function spamAssassinPhish(headers: Record<string, string>): boolean {
  return spamAssassinTests(headers)?.tests.some((t) => SA_PHISH.test(t)) ?? false;
}

/** Bait, matched on folded text (lower case, no accents, ς → σ; src/lib/text.ts). */
const LURES: RegExp[] = [
  // «Your email password … is scheduled to expire», «Password Expiration Notice», «Keep My Same Password»
  /\bpassword\b.{0,80}?\b(?:expir|reset|confirm|verif|validat|deactivat|suspen|renew)/,
  /\b(?:confirm|verify|validate|update|renew|reset)\s+(?:your|my|the)\s+(?:(?:e-?mail|mailbox|account|current)\s+)?password\b/,
  /\b(?:keep|retain|continue (?:to use|using|with))\s+(?:my|your|the)\s+(?:same|current|old|existing)\s+password\b/,
  // the mailbox is about to be closed, is full or must be verified
  /\b(?:mailbox|e-?mail (?:account|box|address)|webmail|your account)\b.{0,80}?\b(?:deactivat|suspen|terminat|disabl|block|lock|quota|storage|upgrade|verif|validat|re-?activat|expir|shut ?down)/,
  // unusual sign-in, «activity sent from your own account», sextortion
  /\b(?:unusual|suspicious|unauthori[sz]ed|unrecogni[sz]ed)\s+(?:sign[- ]?in|log[- ]?in|login|activity|access)\b/,
  /\bfrom your own (?:e-?mail )?account\b/,
  /\b(?:account|device|computer|system) (?:is|was|has been) (?:hacked|compromised|infected)\b/,
  /\bbitcoin\b|\bbtc (?:wallet|address)\b/,
  // the same in Greek: «ο κωδικός πρόσβασης λήγει» (your password expires), «επιβεβαιώστε τον κωδικό πρόσβασης»
  // (confirm your password), «ο λογαριασμός σας θα απενεργοποιηθεί» (your account will be deactivated)
  /κωδικ\p{L}*\s+(?:\p{L}+\s+){0,2}?προσβασ\p{L}*[^.!?]{0,80}?(?:ληγ|ληξ|εληξ|επιβεβαι|επαληθευ|ανανε|απενεργοποι)/u,
  /(?:ληξ|επιβεβαιω|επαληθευ|ανανεω)\p{L}*\s+(?:\p{L}+\s+){0,3}?κωδικ\p{L}*\s+(?:\p{L}+\s+){0,2}?προσβασ/u,
  /(?:λογαριασμ|γραμματοκιβωτι)\p{L}*[^.!?]{0,80}?(?:ενεργοποι|αναστολ|ανασταλ|αποκλει|κλειδω|επαληθευ|ταυτοποι|διαγραφ|πληρ(?:εσ|ησ)(?!\p{L})|γεματ)/u,
  /(?:ενεργοποι|επαληθευσ|ταυτοποι|αναστολ|κλεισιμο)\p{L}*\s+(?:\p{L}+\s+){0,2}?(?:λογαριασμ|γραμματοκιβωτι)/u,
  /(?:ασυνηθιστ|υποπτ|μη εξουσιοδοτημεν)\p{L}*\s+(?:\p{L}+\s+)?(?:δραστηριοτητ|συνδεσ|προσβασ)/u,
  // bank / state bait: «Απαιτείται άμεση ενέργεια» (immediate action required), «η πρόσβαση … έχει περιοριστεί»
  // (access … has been restricted), «επικαιροποίηση των προσωπικών σας στοιχείων» (update your personal details),
  // «Ταυτότητά σας» (your identity), «Ενημέρωση ασφαλείας» (security update); not «επιβεβαίωση των στοιχείων της
  // παραγγελίας» (confirm the order details)
  /\b(?:action required|immediate action)\b|(?<!\p{L})απαιτειται\s+(?:\p{L}+\s+){0,2}?ενεργεια/u,
  /προσβασ\p{L}*[^.!?]{0,80}?(?:περιορισ|ανασταλ|αναστολ|απενεργοποι|κλειδω)/u,
  /(?:επικαιροποι|επαληθευ|επιβεβαιω|επικυρω|ελεγξ)\p{L}*\s+(?:\p{L}+\s+){0,3}?(?:προσωπικ\p{L}*\s+(?:σασ\s+)?στοιχει|στοιχει\p{L}*\s+σασ)/u,
  /(?<!\p{L})ταυτοτητα\s+σασ(?!\p{L})/u,
  /\bsecurity (?:alert|notice|update|notification)\b|(?:ενημερωση|ειδοποιηση)\s+ασφαλειασ/u,
  // «You have received a document to review and sign», «5 pending messages … blocked by your administrator»
  /\breview and sign\b|\bplease docusign\b|\b(?:review|view|sign|access|open) (?:the |your |shared )?documents?\b|\bshared (?:a |an )?(?:document|file|folder)s? with you\b/,
  /\b(?:pending|blocked|held|quarantined|undelivered|incoming) (?:e-?mails?|messages?)\b|\b(?:e-?mails?|messages?) (?:has|have) been (?:blocked|held|quarantined|suspended|returned)\b/,
];

function hasLure(subject: string, text: string): boolean {
  // Entities too: phishing writes its Greek as «&#922;&#945;…» even in the plain-text part.
  const folded = foldForMatch(decodeEntities(`${subject}. ${text.slice(0, 30_000)}`).slice(0, 8000));
  return LURES.some((re) => re.test(folded));
}
