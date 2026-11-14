import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail as MpParsed, type SimpleParserOptions } from "mailparser";
import type { Address, Attachment, BounceInfo, CalendarInfo, ParsedMail } from "../domain/types.js";
import { normalizeMessageId } from "../lib/text.js";
import { htmlToPlainText } from "./html.js";
import { parseICalendar } from "./ical.js";
import {
  decodeHeaderValue,
  decodeTransfer,
  decodeWithRepair,
  flattenParts,
  headerValue,
  looksLikeGreekMojibake,
  parseHeaderBlock,
  splitHeaderBody,
  walkMime,
  type LitePart,
  type RawHeader,
} from "./mime-lite.js";
import { parseQuotedDate } from "./quoted-date.js";

/** Headers kept on messages.headers (lower-cased). Everything else is dropped at ingest. */
export const HEADER_ALLOWLIST = [
  "list-unsubscribe", "list-id", "precedence", "auto-submitted", "x-autoreply", "x-autorespond",
  "x-auto-response-suppress", "x-mailme-kind", "delivered-to", "x-original-to", "return-path",
  "x-mailer", "user-agent", "content-type", "x-ms-exchange-organization-autoreplytype", "x-spam-flag",
  "x-spam-status", "feedback-id", "x-mailchimp-campaign", "x-campaign", "importance", "x-priority",
  "thread-index", "thread-topic", "x-forwarded-to", "x-forwarded-for", "resent-from",
] as const;

const DELIVERY_TRACE = new Set(["delivered-to", "x-original-to", "return-path"]);
/** Parts that carry structure, not user attachments (parsed separately, never listed). */
const STRUCTURAL_TYPES = new Set([
  "message/delivery-status", "message/global-delivery-status", "text/rfc822-headers", "message/global-headers",
  "message/disposition-notification", "message/global-disposition-notification", "application/pkcs7-signature",
  "application/x-pkcs7-signature", "application/pgp-signature", "application/pgp-encrypted",
]);
const MAX_TEXT_CHARS = 1_000_000;
const MAX_HEADER_CHARS = 1000;
const MAX_REFERENCES = 100;
const MAX_EMBED_DEPTH = 2;
const PARSER_OPTIONS = {
  ignoreEmbedded: true,
  keepDeliveryStatus: true,
  keepCidLinks: true,
  skipImageLinks: true,
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipTextLinks: true,
} as SimpleParserOptions;

/** Parse raw RFC 5322 source into ParsedMail. Never throws on malformed mail: records decodeWarnings. */
export async function parseMime(raw: Buffer): Promise<ParsedMail> {
  return parseAt(raw, 0);
}

async function parseAt(raw: Buffer, depth: number): Promise<ParsedMail> {
  const warnings = new Set<string>();
  const latin = raw.toString("latin1");
  const rawHeaders = parseHeaderBlock(splitHeaderBody(latin).head);
  let tree: LitePart | null = null;
  try {
    tree = walkMime(latin);
  } catch {
    warnings.add("mime_structure_error");
  }
  let mp: MpParsed | null = null;
  try {
    mp = await simpleParser(raw, PARSER_OPTIONS);
  } catch {
    warnings.add("parse_error");
  }
  // Past its header size limit (about 1 MB) mailparser resolves with neither headers nor text. Count that as a failed
  // parse, so the fallbacks below read the message instead of throwing on mp.headers (a message that throws here is
  // retried on every pass and never processed).
  if (mp && !(mp.headers instanceof Map)) {
    mp = null;
    warnings.add("parse_error");
  }
  const parts = tree ? flattenParts(tree) : [];
  const get = (name: string) => headerValue(rawHeaders, name);

  // ── Envelope ───────────────────────────────────────────────────────────────
  const from = mp ? firstAddress(mp.from) : fallbackAddresses(get("from"))[0] ?? null;
  const sender = mp ? firstAddress(asAddressObject(mp.headers.get("sender"))) : fallbackAddresses(get("sender"))[0] ?? null;
  const to = mp ? addressList(mp.to) : fallbackAddresses(get("to"));
  const cc = mp ? addressList(mp.cc) : fallbackAddresses(get("cc"));
  const bcc = mp ? addressList(mp.bcc) : fallbackAddresses(get("bcc"));
  const replyTo = mp ? addressList(mp.replyTo) : fallbackAddresses(get("reply-to"));

  let subject = (mp?.subject ?? "").trim();
  const rawSubject = get("subject");
  if (rawSubject !== null && (!mp || /\u{FFFD}/u.test(subject) || looksLikeGreekMojibake(subject))) {
    const repaired = decodeHeaderValue(rawSubject).replace(/\s+/g, " ").trim();
    if (!/\u{FFFD}/u.test(repaired) && repaired !== subject) {
      if (mp && subject) warnings.add("charset_repaired:subject");
      subject = repaired;
    }
  }

  const messageIds = extractIds(get("message-id"));
  const references = capReferences(dedupe(extractIds(get("references"))));
  const inReplyTo = extractIds(get("in-reply-to"))[0] ?? null;
  const dateHeader = parseDateHeader(get("date"));
  if (get("date") !== null && dateHeader === null) warnings.add("date_unparseable");

  const headers: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) {
    const v = get(name);
    if (v !== null) headers[name] = decodeHeaderValue(v).replace(/\s+/g, " ").trim().slice(0, MAX_HEADER_CHARS);
  }

  // ── Bodies ─────────────────────────────────────────────────────────────────
  let textPlain: string | null = mp ? mp.text || null : null;
  let textHtml: string | null = mp ? (typeof mp.html === "string" && mp.html ? mp.html : null) : null;
  if (!mp && tree) {
    textPlain = joinTextParts(parts, "text/plain", "\n");
    textHtml = joinTextParts(parts, "text/html", "<br/>\n");
  }
  if (tree) {
    const needsRepair = (t: string | null) =>
      !!t && (/\u{FFFD}/u.test(t) || looksLikeGreekMojibake(t.slice(0, 50_000).replace(/<[^<>]*>|&[#\w]+;/g, " ")));
    for (const [type, sep] of [["text/plain", "\n"], ["text/html", "<br/>\n"]] as const) {
      const current = type === "text/plain" ? textPlain : textHtml;
      if (!needsRepair(current)) continue;
      const leaves = textLeaves(parts, type);
      if (leaves.length === 0) continue;
      const decoded = leaves.map((p) => decodeWithRepair(decodeTransfer(p), p.params.charset));
      const repairedAs = decoded.find((d) => d.repairedAs)?.repairedAs;
      if (!repairedAs) continue;
      const text = decoded.map((d) => d.text.replace(/\r\n/g, "\n")).join(sep);
      if (type === "text/plain") textPlain = text;
      else textHtml = text;
      warnings.add(`charset_repaired:${repairedAs}`);
    }
  }

  // ── Structure: S/MIME, PGP, TNEF, MDN ─────────────────────────────────────
  for (const p of parts) {
    const ct = p.contentType;
    if (ct === "application/pkcs7-mime" || ct === "application/x-pkcs7-mime") {
      const st = (p.params["smime-type"] ?? "").toLowerCase();
      warnings.add(st === "signed-data" || st === "certs-only" ? "smime_signed_opaque" : "smime_encrypted");
    }
    if (ct === "multipart/encrypted") warnings.add("pgp_encrypted");
    if (ct === "application/ms-tnef" || ct === "application/vnd.ms-tnef" || /^winmail\.dat$/i.test(p.params.name ?? "")) warnings.add("tnef");
    if (ct === "multipart/report" && (p.params["report-type"] ?? "").toLowerCase() === "disposition-notification") warnings.add("mdn");
  }
  if (textPlain && /-----BEGIN PGP MESSAGE-----/.test(textPlain)) warnings.add("pgp_encrypted");

  // ── Calendar ───────────────────────────────────────────────────────────────
  let calendar: CalendarInfo | null = null;
  const calPart = parts.find(
    (p) => p.children.length === 0 && (p.contentType === "text/calendar" || p.contentType === "application/ics" || /\.ics$/i.test(p.params.name ?? "")),
  );
  if (calPart) {
    try {
      calendar = parseICalendar(decodeWithRepair(decodeTransfer(calPart), calPart.params.charset).text, "Europe/Athens", calPart.params.method ?? null);
    } catch {
      warnings.add("calendar_unparseable");
    }
  }

  // ── Bounce (RFC 3464 or heuristic) ────────────────────────────────────────
  const isReport = parts.some((p) => p.contentType === "multipart/report");
  let bounce = parseReport(parts);
  if (!bounce && !isReport) bounce = heuristicBounce(from, subject, textPlain ?? (textHtml ? htmlToPlainText(textHtml) : ""));

  // ── Attachments (metadata only) & embedded messages ───────────────────────
  const attachments: Attachment[] = [];
  const embedded: Buffer[] = [];
  for (const a of mp?.attachments ?? []) {
    const ct = (a.contentType || "application/octet-stream").toLowerCase();
    if (STRUCTURAL_TYPES.has(ct)) continue;
    if ((ct === "text/calendar" || ct === "application/ics") && !a.filename) continue;
    if (ct === "message/rfc822" || ct === "message/global") {
      if (!isReport && Buffer.isBuffer(a.content)) embedded.push(a.content);
      continue;
    }
    const isImage = ct.startsWith("image/");
    attachments.push({
      filename: (a.filename ?? "").trim() || "unnamed",
      contentType: ct,
      size: typeof a.size === "number" ? a.size : Buffer.isBuffer(a.content) ? a.content.length : 0,
      inline: (!!a.related && !!a.cid) || (a.contentDisposition === "inline" && isImage),
    });
  }
  if (!mp && tree) attachments.push(...fallbackAttachments(parts));

  // Forward-as-attachment: the embedded message becomes a "Forwarded message" block (→ FORWARDED segment).
  for (const buf of embedded) {
    if (depth >= MAX_EMBED_DEPTH) {
      attachments.push({ filename: "forwarded.eml", contentType: "message/rfc822", size: buf.length, inline: false });
      continue;
    }
    const inner = await parseAt(buf, depth + 1);
    warnings.add("embedded_message");
    const block = forwardBlock(inner);
    textPlain = (textPlain ? textPlain.trimEnd() + "\n\n" : "") + block.text;
    if (textHtml) textHtml = `${textHtml}\n${block.html}`;
    attachments.push(...inner.attachments);
  }

  if (textPlain && textPlain.length > MAX_TEXT_CHARS) {
    textPlain = textPlain.slice(0, MAX_TEXT_CHARS);
    warnings.add("text_truncated");
  }
  if (textHtml && textHtml.length > MAX_TEXT_CHARS) {
    textHtml = textHtml.slice(0, MAX_TEXT_CHARS);
    warnings.add("html_truncated");
  }

  return {
    messageIdHeader: messageIds[0] ?? null,
    from,
    sender,
    to,
    cc,
    bcc,
    replyTo,
    subject,
    dateHeader,
    inReplyTo,
    references,
    threadIndex: (get("thread-index") ?? "").trim() || null,
    headers,
    textPlain: textPlain?.replace(/\r\n/g, "\n") ?? null,
    textHtml,
    attachments,
    calendar,
    bounce,
    decodeWarnings: [...warnings],
    hasDeliveryTrace: rawHeaders.some((h) => DELIVERY_TRACE.has(h.name)),
    sizeBytes: raw.length,
  };
}

// ── Addresses ────────────────────────────────────────────────────────────────

function asAddressObject(v: unknown): AddressObject | undefined {
  return v && typeof v === "object" && Array.isArray((v as AddressObject).value) ? (v as AddressObject) : undefined;
}

function flatten(list: EmailAddress[]): EmailAddress[] {
  return list.flatMap((e) => (e.group ? flatten(e.group) : [e]));
}

function toAddress(e: EmailAddress): Address | null {
  const address = (e.address ?? "").trim().toLowerCase();
  if (!address) return null;
  const name = (e.name ?? "").replace(/\s+/g, " ").trim();
  return { address, name: name || null };
}

function addressList(v: AddressObject | AddressObject[] | undefined): Address[] {
  if (!v) return [];
  const objs = Array.isArray(v) ? v : [v];
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const o of objs) {
    for (const e of flatten(o.value ?? [])) {
      const a = toAddress(e);
      if (a && !seen.has(a.address)) {
        seen.add(a.address);
        out.push(a);
      }
    }
  }
  return out;
}

function firstAddress(v: AddressObject | undefined): Address | null {
  return addressList(v)[0] ?? null;
}

/**
 * Split a header value at the commas outside double quotes: those with an even number of `"` after them, which is
 * what `/,(?=(?:[^"]*"[^"]*")*[^"]*$)/` matched. One pass; that lookahead re-read the rest of the value at every
 * comma, which is quadratic on a header of many commas. Exported for the tests.
 */
export function splitAddressList(v: string): string[] {
  let quotesAfter = 0;
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 0x22) quotesAfter++;
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x22) {
      quotesAfter--;
    } else if (c === 0x2c && quotesAfter % 2 === 0) {
      out.push(v.slice(start, i));
      start = i + 1;
    }
  }
  out.push(v.slice(start));
  return out;
}

/** Minimal address-list parser for when mailparser failed. */
function fallbackAddresses(raw: string | null): Address[] {
  if (!raw) return [];
  const v = decodeHeaderValue(raw);
  const out: Address[] = [];
  for (const chunk of splitAddressList(v)) {
    const angle = /^(.*)<([^<>]+)>\s*$/.exec(chunk.trim());
    const address = (angle ? angle[2]! : chunk).trim().toLowerCase();
    if (!address.includes("@")) continue;
    const name = angle ? angle[1]!.replace(/^["\s]+|(?<!["\s])["\s]+$/g, "") : "";
    out.push({ address, name: name || null });
  }
  return out;
}

// ── Header helpers ───────────────────────────────────────────────────────────

/** Message-IDs in a header, normalized (no angle brackets). */
function extractIds(raw: string | null): string[] {
  if (!raw) return [];
  const v = decodeHeaderValue(raw);
  const bracketed = [...v.matchAll(/<([^<>\s]+)>/g)].map((m) => normalizeMessageId(m[1]!)).filter((x): x is string => !!x);
  if (bracketed.length) return bracketed;
  return v
    .split(/[\s,]+/)
    .filter((t) => t.includes("@"))
    .map((t) => normalizeMessageId(t))
    .filter((x): x is string => !!x);
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** Keep the thread root (first) and the most recent ancestors. */
function capReferences(ids: string[]): string[] {
  return ids.length <= MAX_REFERENCES ? ids : [ids[0]!, ...ids.slice(ids.length - (MAX_REFERENCES - 1))];
}

/**
 * `s.replace(/\([^)]*\)/g, " ")`: each "(comment)" becomes a space. One pass; that regex scanned to the end of the
 * value from every "(" that had no ")" after it, which is quadratic on a Date header of many "(". Exported for the tests.
 */
export function dropComments(s: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = s.indexOf("(", from);
    if (open < 0) break;
    const close = s.indexOf(")", open + 1);
    if (close < 0) break; // no ")" after this "(", so none after any later "(" either
    out += s.slice(from, open) + " ";
    from = close + 1;
  }
  return out + s.slice(from);
}

/** mailparser turns an invalid Date into "now"; parse it ourselves and return null instead. */
function parseDateHeader(raw: string | null): Date | null {
  if (!raw) return null;
  const s = dropComments(decodeHeaderValue(raw)).replace(/\s+/g, " ").trim();
  if (!s || !/\d{4}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return null;
  let t = /[+-]\d{4}\b|\b(gmt|ut|utc|z|[ecmp][sd]t)\b/i.test(s) ? Date.parse(s) : Number.NaN;
  if (Number.isNaN(t)) {
    const iso = parseQuotedDate(s, "Europe/Athens");
    t = iso ? Date.parse(iso) : Number.NaN;
  }
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const y = d.getUTCFullYear();
  return y >= 1990 && y <= 2100 ? d : null;
}

// ── Body helpers ─────────────────────────────────────────────────────────────

function textLeaves(parts: LitePart[], type: "text/plain" | "text/html"): LitePart[] {
  return parts.filter((p) => p.contentType === type && p.children.length === 0 && p.disposition !== "attachment");
}

function joinTextParts(parts: LitePart[], type: "text/plain" | "text/html", sep: string): string | null {
  const leaves = textLeaves(parts, type);
  if (!leaves.length) return null;
  return leaves.map((p) => decodeWithRepair(decodeTransfer(p), p.params.charset).text).join(sep) || null;
}

function fallbackAttachments(parts: LitePart[]): Attachment[] {
  return parts
    .filter((p) => p.children.length === 0 && !p.contentType.startsWith("multipart/"))
    .filter((p) => p.disposition === "attachment" || (!p.contentType.startsWith("text/") && !STRUCTURAL_TYPES.has(p.contentType)))
    .map((p) => ({
      filename: decodeHeaderValue(p.params.name ?? "").trim() || "unnamed",
      contentType: p.contentType,
      size: decodeTransfer(p).length,
      inline: p.disposition === "inline" && p.contentType.startsWith("image/"),
    }));
}

function formatAddress(a: Address | null): string {
  if (!a) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text + HTML rendering of an embedded message/rfc822 as a Gmail-style forward block. */
function forwardBlock(inner: ParsedMail): { text: string; html: string } {
  const head: string[] = ["---------- Forwarded message ---------"];
  if (inner.from) head.push(`From: ${formatAddress(inner.from)}`);
  if (inner.dateHeader) head.push(`Date: ${inner.dateHeader.toUTCString()}`);
  head.push(`Subject: ${inner.subject}`);
  if (inner.to.length) head.push(`To: ${inner.to.map(formatAddress).join(", ")}`);
  if (inner.cc.length) head.push(`Cc: ${inner.cc.map(formatAddress).join(", ")}`);
  const body = inner.textPlain ?? (inner.textHtml ? htmlToPlainText(inner.textHtml) : "");
  const text = `${head.join("\n")}\n\n${body}`;
  const htmlBody = inner.textHtml ?? `<div>${escapeHtml(body).replace(/\n/g, "<br>")}</div>`;
  const html = `<div><br></div><div>${head.map(escapeHtml).join("<br>")}<br><br></div><div>${htmlBody}</div>`;
  return { text, html };
}

// ── Delivery reports ─────────────────────────────────────────────────────────

const BOUNCE_ACTIONS = new Set(["failed", "delayed", "delivered", "relayed", "expanded"]);

/** RFC 3464: message/delivery-status + the original's headers (text/rfc822-headers or message/rfc822). */
function parseReport(parts: LitePart[]): BounceInfo | null {
  const dsn = parts.find((p) => p.contentType === "message/delivery-status" || p.contentType === "message/global-delivery-status");
  if (!dsn) return null;
  const text = decodeTransfer(dsn).toString("latin1").replace(/\r\n/g, "\n");
  const blocks = text.split(/\n[ \t]*\n/).map((b) => parseHeaderBlock(b)).filter((b) => b.length);
  const hasField = (b: RawHeader[], n: string) => b.some((h) => h.name === n);
  let recipients = blocks.slice(1).filter((b) => hasField(b, "action") || hasField(b, "final-recipient"));
  if (!recipients.length) recipients = blocks.filter((b) => hasField(b, "action"));
  const pick = recipients.find((b) => /^\s*failed/i.test(headerValue(b, "action") ?? "")) ?? recipients[0] ?? [];
  const actionRaw = (headerValue(pick, "action") ?? "").trim().toLowerCase().split(/[\s(;]/)[0] ?? "";
  const action = (BOUNCE_ACTIONS.has(actionRaw) ? actionRaw : "unknown") as BounceInfo["action"];
  const recipientRaw = headerValue(pick, "final-recipient") ?? headerValue(pick, "original-recipient");
  const recipient = recipientRaw ? stripTypePrefix(recipientRaw).replace(/^<|>$/g, "").trim().toLowerCase() || null : null;
  const diag = headerValue(pick, "diagnostic-code");
  const status = headerValue(pick, "status");
  const diagnostic = diag ? decodeHeaderValue(stripTypePrefix(diag)).replace(/\s+/g, " ").trim().slice(0, 500) : status ? status.trim() : null;

  let originalMessageId: string | null = null;
  const orig = parts.find((p) => ["text/rfc822-headers", "message/rfc822", "message/global", "message/global-headers"].includes(p.contentType));
  if (orig) {
    const src = decodeTransfer(orig).toString("latin1");
    const hdrs = parseHeaderBlock(splitHeaderBody(src).head || src);
    originalMessageId = extractIds(headerValue(hdrs, "message-id"))[0] ?? null;
  }
  return { action, originalMessageId, recipient, diagnostic };
}

function stripTypePrefix(v: string): string {
  const semi = v.indexOf(";");
  return (semi >= 0 && semi < 12 ? v.slice(semi + 1) : v).trim();
}

const DAEMON_LOCAL = /^(mailer-daemon|mailerdaemon|mail-daemon|postmaster|microsoftexchange[0-9a-f]{32})$/i;
const BOUNCE_SUBJECT =
  /^(undeliver(ed|able)|mail delivery (failed|failure|subsystem)|delivery (status notification|failure|has failed|notification|delayed)|returned mail|failure notice|non[- ]?delivery|warning: (could not|message)|μη παραδόσιμο|αδυναμία παράδοσης|αποτυχία παράδοσης|επιστροφή μηνύματος|δεν ήταν δυνατή η παράδοση)/iu;

/** Non-RFC 3464 bounces (qmail/Exim/legacy): daemon sender + bounce subject. */
function heuristicBounce(from: Address | null, subject: string, text: string): BounceInfo | null {
  const local = (from?.address ?? "").split("@")[0] ?? "";
  const daemon = DAEMON_LOCAL.test(local) || /mail delivery (system|subsystem)/i.test(from?.name ?? "");
  if (!daemon || !BOUNCE_SUBJECT.test(subject.trim())) return null;
  const body = text.slice(0, 50_000);
  // Leading space within the line only ([^\S\r\n\u2028\u2029]): `^\s*` with /m also ran over the blank lines after
  // each line start, which is quadratic on a body of empty lines. (`\s*\n?\s*` below was `\s*` plus a second,
  // backtracking copy of it.)
  const idMatch = /^[^\S\r\n\u2028\u2029]*message-id:\s*<([^>\s]+)>/im.exec(body);
  const rcpt =
    /(?:following (?:address(?:\(es\))?|recipients?)[^:\n]*:|could not be delivered to[^:\n]*:?|failed recipient[^:\n]*:)\s*<?([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>?/i.exec(body) ??
    /^[^\S\r\n\u2028\u2029]*<([\w.+-]+@[\w-]+(?:\.[\w-]+)+)>:/m.exec(body);
  const diag = /^.*\b(?:[45]\d\d[ -][45]\.\d{1,3}\.\d{1,3}|[45]\.\d{1,3}\.\d{1,3}|55\d|45\d)\b.*$/m.exec(body);
  return {
    action: /delay|καθυστέρ/iu.test(subject) ? "delayed" : "failed",
    originalMessageId: idMatch ? normalizeMessageId(idMatch[1]!) : null,
    recipient: rcpt ? rcpt[1]!.toLowerCase() : null,
    diagnostic: diag ? diag[0].trim().slice(0, 500) : null,
  };
}
