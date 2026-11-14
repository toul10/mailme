/**
 * Text hygiene for the report: every dynamic string is escaped, AI-written fields lose URLs,
 * e-mail addresses and phone numbers, and remaining link-like text is defanged so mail clients cannot
 * auto-link it. Only LinkFactory links are ever clickable.
 */

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(input: string | null | undefined): string {
  return (input ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** C0/C1 controls, bidi overrides/isolates and zero-width characters (spoofing vectors). */
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Strip control/bidi characters, collapse whitespace, cap length. */
export function cleanText(input: string | null | undefined, max = 300): string {
  const s = (input ?? "").replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + "…" : s;
}

/**
 * Dots that IDNA (UTS #46) maps to "." — full stop, ideographic, full-width and half-width ideographic full stops —
 * so "evil。com" is as linkable as "evil.com" in clients that normalise host names.
 */
const DOT = "[.。．｡]";
const DOTS = /[.。．｡]/g;

const SCHEME_URL = /\b(?:https?|ftp|file|javascript|vbscript|data|mailto|tel|sms|callto|skype|viber|whatsapp):\S+/gi;
const WWW_URL = new RegExp(`\\bwww\\d?${DOT}[^\\s<>"'«»]+`, "giu");
const EMAIL = new RegExp(`[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:${DOT}[\\p{L}\\p{N}-]+)+`, "gu");
const INTL_PHONE = /(?:\+|\b00)\s?\d{1,3}(?:[\s.\-/()]*\d){6,14}/g;
const GR_PHONE = /\b(?:2\d|69)\d(?:[\s.-]?\d){7}\b/g;

/** Optional port and path/query/fragment after a host (the whole token is defanged). */
const AFTER_HOST = `(?::\\d{1,5})?(?:[/?#][^\\s<>"'«»]*)?`;

/**
 * Any dotted host name whose last label looks like a TLD — letters only (Greek/IDN included, ≥ 2 letters) or an
 * `xn--` label — with an optional port and path: "paypal-verify.pl/login", "secure-pay.am", "ελληνικό-site.ελ/πληρωμή".
 * No TLD allow-list: clients linkify with the full IANA list, and new TLDs appear all the time. JS `\b` is ASCII-only,
 * so the host's start is a Unicode lookbehind. Amounts, dates and times never match (the last label must be letters);
 * one-letter abbreviations ("π.χ.", "Α.Ε.": Greek "e.g." and "S.A.") neither.
 */
const LABEL = "[\\p{L}\\p{N}\\p{M}_][\\p{L}\\p{N}\\p{M}_-]*";
const TLD = "(?:\\p{L}[\\p{L}\\p{M}]+|xn--[a-z0-9-]+)";
const HOST = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_-])((?:${LABEL}${DOT})+)(${TLD})(?![\\p{L}\\p{N}\\p{M}_-])(${AFTER_HOST})`, "giu");

/** IPv4 literals, with an optional port and path ("192.168.1.10/admin"). Dates like 24.09.2026 do not match. */
const IPV4 = new RegExp(`(?<![\\p{N}.])(?:\\d{1,3}${DOT}){3}\\d{1,3}(?!\\p{N}|${DOT}\\d)${AFTER_HOST}`, "gu");

/**
 * Attachment-style extensions that are not TLDs: "Prosfora_ABC_v2.pdf" stays as written. Real TLDs that look like
 * extensions (.zip, .mov, .app, …) are not listed, so they are always defanged; a listed one followed by a path or
 * port ("x.pdf/login") is defanged too.
 */
const FILE_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv", "tsv",
  "jpg", "jpeg", "png", "gif", "bmp", "tif", "tiff", "heic", "webp", "svg", "eml", "msg", "ics", "vcf",
  "htm", "html", "xml", "json", "rar", "tar", "gz", "tgz", "mp3", "mp4", "wav", "avi", "dwg", "dxf", "exe", "bak",
]);

/** Break a link-like token so no client auto-links it, while it stays readable ("abc-gr.example" → "abc․gr", "https://" → "https꞉//"). */
function defangToken(token: string): string {
  return token.replace(/:/g, "꞉").replace(DOTS, "․");
}

function defangHosts(s: string): string {
  return s.replace(HOST, (whole: string, labels: string, tld: string, after: string) => {
    if (after === "" && FILE_EXTENSIONS.has(tld.toLowerCase())) {
      // A file name: keep its extension, but the name part may itself hide a host ("evil.com.pdf").
      const name = labels.slice(0, -1);
      return defangHosts(name) + labels.slice(-1) + tld;
    }
    return defangToken(whole);
  });
}

/** Defang every bare host and IPv4 literal (with its path) left in `s`. */
function defangBareLinks(s: string): string {
  return defangHosts(s).replace(IPV4, defangToken);
}

/**
 * For AI-written fields (title, next action, summary, due phrase): remove URLs, e-mail addresses and phone
 * numbers; defang bare domains (company names like "Example.com" stay readable but are not links).
 */
export function sanitizeAiText(input: string | null | undefined, max = 200): string {
  let s = cleanText(input, 4 * max);
  s = s.replace(SCHEME_URL, "[link]").replace(WWW_URL, "[link]");
  s = s.replace(EMAIL, "[email]");
  s = s.replace(INTL_PHONE, "[phone]").replace(GR_PHONE, "[phone]");
  s = defangBareLinks(s);
  return cleanText(s, max);
}

/** For mail-derived fields kept verbatim (subject, sender, company): defang link-like text only (addresses included). */
export function defangText(input: string | null | undefined, max = 200): string {
  let s = cleanText(input, 4 * max);
  s = s.replace(SCHEME_URL, defangToken).replace(WWW_URL, defangToken).replace(EMAIL, defangToken);
  s = defangBareLinks(s);
  return cleanText(s, max);
}
