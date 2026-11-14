/**
 * Text normalization shared by grounding (evidence checks), search and subject matching.
 * Greek-aware: strips tonos/dialytika, folds final sigma, removes invisible characters that
 * Outlook sprinkles into HTML mail (NBSP, soft hyphen, zero-width).
 */

const INVISIBLES = /[­​‌‍⁠﻿]/g;
const SPACES = /[     　\t\r\n\f\v ]+/g;
const QUOTES = /[‘’‚‛′´`]/g;
const DQUOTES = /[“”„‟«»″]/g;
const DASHES = /[‐‑‒–—―−]/g;
const COMBINING = /[̀-ͯ]/g;

/** Canonical form for evidence matching: NFC → invisible removal → quote/dash/space folding → casefold → accent strip → ς→σ. */
export function foldForMatch(input: string): string {
  return input
    .normalize("NFD")
    .replace(COMBINING, "")
    .normalize("NFC")
    .replace(INVISIBLES, "")
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .replace(DASHES, "-")
    .toLowerCase()
    .replace(/ς/g, "σ")
    .replace(SPACES, " ")
    .trim();
}

/** For search/FTS: foldForMatch + punctuation → space. */
export function foldForSearch(input: string): string {
  return foldForMatch(input)
    .replace(/[^\p{L}\p{N}@.\-_ ]+/gu, " ")
    .replace(/ +/g, " ")
    .trim();
}

/** Tokens for fuzzy comparison (letters/digits only, length ≥ 2). */
export function tokens(input: string): string[] {
  return foldForSearch(input)
    .split(" ")
    .map((t) => t.replace(/^[.\-_@]+|(?<![.\-_@])[.\-_@]+$/g, ""))
    .filter((t) => t.length >= 2);
}

/** Token-set containment of `needle` in `haystack` (0..1): share of needle tokens present in haystack. */
export function tokenContainment(needle: string, haystack: string): number {
  const n = new Set(tokens(needle));
  if (n.size === 0) return 0;
  const h = new Set(tokens(haystack));
  let hit = 0;
  for (const t of n) if (h.has(t)) hit++;
  return hit / n.size;
}

/**
 * `s` without trailing spaces and tabs (only those: unlike trimEnd, a no-break space stays). Linear: `/[ \t]+$/`
 * retries from every space of a long run inside a line, which is quadratic and stalls on crafted mail.
 */
export function trimSpaceTabEnd(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09) break;
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

export function truncate(input: string, max: number): { text: string; truncated: boolean } {
  if (input.length <= max) return { text: input, truncated: false };
  return { text: input.slice(0, Math.max(0, max - 1)).trimEnd() + "…", truncated: true };
}

/** Lower-cased bare address, or null. */
export function normalizeAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const a = address.trim().replace(/^<|>$/g, "").toLowerCase();
  return a.includes("@") ? a : null;
}

export function domainOf(address: string | null | undefined): string | null {
  const a = normalizeAddress(address);
  return a ? a.slice(a.lastIndexOf("@") + 1) : null;
}

/** Free-mail / ISP domains that must never be treated as a company. */
export const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.gr",
  "hotmail.com",
  "hotmail.gr",
  "outlook.com",
  "outlook.com.gr",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "otenet.gr",
  "windowslive.com",
  "freemail.gr",
  "in.gr",
  "hol.gr",
  "forthnet.gr",
  "cosmotemail.gr",
  "vodafone.gr",
  "wind.gr",
  "nova.gr",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
]);

/** Normalize a Message-ID for keys: strip <>, whitespace, lower-case the domain part. */
export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const m = id.trim().replace(/^<+|(?<!>)>+$/g, "").trim();
  if (!m) return null;
  const at = m.lastIndexOf("@");
  return at > 0 ? m.slice(0, at) + "@" + m.slice(at + 1).toLowerCase() : m;
}
