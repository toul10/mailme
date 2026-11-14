/**
 * "What matters to me": a user's own rules for what matters. Pure functions shared by the engine (ingest filter,
 * reconciler), the server (validation, list flags) and the SPA (form hints), so a rule means the same thing
 * everywhere.
 *
 * Entries are one of:
 *   - an address          maria@abc-gr.example   (matches that sender exactly)
 *   - a domain            @abc-gr.example        (matches abc-gr.example and its subdomains; "abc-gr.example" is accepted and stored as "@abc-gr.example")
 *   - a company name      ABC Audio      (important only: matches a task's company, accent- and case-insensitive)
 * Muted entries are addresses or domains only: the filter runs before the AI, when no company is known yet.
 */

export const CC_POLICIES = ["ask", "create", "ignore"] as const;
export type CcPolicy = (typeof CC_POLICIES)[number];

export const PREFERENCE_LIMITS = { entries: 200, entryChars: 120, profileChars: 600 } as const;

export type EntryKind = "address" | "domain" | "company";

export interface ParsedEntry {
  kind: EntryKind;
  /** Stored form: lower-cased address, "@domain", or the company name as typed (trimmed, spaces collapsed). */
  value: string;
}

const ADDRESS = /^[^\s@]+@([a-z0-9-]+\.)+[a-z]{2,}$/;
const DOMAIN = /^([a-z0-9-]+\.)+[a-z]{2,}$/;

/** Accent- and case-insensitive key for company names ("Délta Events" ≈ "delta events"). */
export function companyKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Parses one typed entry, or explains why it is not usable (shown to the user). */
export function parseEntry(raw: string, list: "important" | "muted"): { ok: true; entry: ParsedEntry } | { ok: false; error: string } {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "Enter an email address, a domain or a company name." };
  if (text.length > PREFERENCE_LIMITS.entryChars) return { ok: false, error: `Up to ${PREFERENCE_LIMITS.entryChars} characters.` };
  const lower = text.toLowerCase().replace(/^mailto:/, "");
  if (ADDRESS.test(lower)) return { ok: true, entry: { kind: "address", value: lower } };
  const domain = lower.startsWith("@") ? lower.slice(1) : lower.startsWith("*.") ? lower.slice(2) : lower;
  if (DOMAIN.test(domain)) return { ok: true, entry: { kind: "domain", value: `@${domain}` } };
  if (list === "muted") return { ok: false, error: "This list takes an email address (e.g. info@example.com) or a domain (e.g. @example.com)." };
  if (text.includes("@") || !/\p{L}/u.test(text)) return { ok: false, error: "Enter an email address, a domain (e.g. @example.com) or a company name." };
  return { ok: true, entry: { kind: "company", value: text } };
}

export function entryKind(value: string): EntryKind {
  return value.startsWith("@") ? "domain" : value.includes("@") ? "address" : "company";
}

/** Normalizes a whole list: drops blanks and duplicates, keeps the first spelling; the first error wins. */
export function normalizeEntries(raw: readonly string[], list: "important" | "muted"): { ok: true; values: string[] } | { ok: false; error: string; entry: string } {
  if (raw.length > PREFERENCE_LIMITS.entries) return { ok: false, error: `Up to ${PREFERENCE_LIMITS.entries} entries.`, entry: "" };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r.trim()) continue;
    const p = parseEntry(r, list);
    if (!p.ok) return { ok: false, error: p.error, entry: r };
    const key = p.entry.kind === "company" ? `c:${companyKey(p.entry.value)}` : p.entry.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.entry.value);
  }
  return { ok: true, values: out };
}

/** Does this sender address match an address or "@domain" entry (subdomains included)? */
export function senderMatches(address: string | null | undefined, entries: readonly string[]): boolean {
  const a = address?.trim().toLowerCase();
  if (!a || !a.includes("@")) return false;
  const host = a.slice(a.lastIndexOf("@") + 1);
  for (const e of entries) {
    if (e.startsWith("@")) {
      const d = e.slice(1);
      if (host === d || host.endsWith(`.${d}`)) return true;
    } else if (e.includes("@") && e === a) return true;
  }
  return false;
}

/** A task is important when its counterparty's address/domain or its company is on the list. */
export function isImportant(task: { counterpartyAddress: string | null; company: string | null }, entries: readonly string[]): boolean {
  if (entries.length === 0) return false;
  if (senderMatches(task.counterpartyAddress, entries)) return true;
  if (!task.company) return false;
  const key = companyKey(task.company);
  return key.length > 0 && entries.some((e) => entryKind(e) === "company" && companyKey(e) === key);
}

/**
 * Entries that must never be muted: the user's own addresses, the organization's domains and any address at them
 * (muting a colleague would silently drop their requests). Returns the offending entry, if any.
 */
export function forbiddenMute(entries: readonly string[], own: { addresses: readonly string[]; internalDomains: readonly string[] }): string | null {
  const addresses = own.addresses.map((a) => a.toLowerCase());
  const domains = own.internalDomains.map((d) => d.toLowerCase().replace(/^@/, ""));
  const internalHost = (host: string) => domains.some((d) => host === d || host.endsWith(`.${d}`));
  for (const e of entries) {
    if (e.startsWith("@")) {
      const d = e.slice(1);
      if (domains.some((x) => x === d || x.endsWith(`.${d}`)) || internalHost(d)) return e;
      if (addresses.some((a) => a.endsWith(`@${d}`) || a.endsWith(`.${d}`))) return e;
    } else if (addresses.includes(e) || internalHost(e.slice(e.lastIndexOf("@") + 1))) return e;
  }
  return null;
}

/** Profile note as stored: trimmed, inner whitespace kept, capped; null when empty. */
export function normalizeProfile(raw: string | null | undefined): string | null {
  const t = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t) return null;
  return t.slice(0, PREFERENCE_LIMITS.profileChars);
}
