import { eq, inArray, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { DbOrTx } from "../db/client.js";
import { companyDomains, threads } from "../db/schema.js";
import { greekHolidays, isBusinessDay } from "../lib/dates.js";
import { OUTPUT_LIMITS } from "../ai/schema.js";
import { PUBLIC_MAIL_DOMAINS, domainOf, foldForMatch } from "../lib/text.js";

/**
 * Small DB/calendar helpers shared by the engine's DB modules (context, apply, pipeline, user actions).
 * Everything here is driver-agnostic (node-postgres and PGlite): no `now()`/`current_date` in SQL,
 * timestamps passed as ISO strings, arrays via `inArray`/`sql.join`.
 */

/** SQLSTATE of a driver error (drizzle wraps driver errors in DrizzleQueryError with `cause`). */
export function pgErrorCode(err: unknown): string | null {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== "23505") return false;
  if (!constraint) return true;
  const e = err as { constraint?: unknown; cause?: { constraint?: unknown } };
  const c = e.cause?.constraint ?? e.constraint;
  return c === undefined || c === constraint;
}

/** Serialization failure, deadlock, connection loss, admin shutdown, too many connections: retry later. */
export function isTransientDbError(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (!code) return false;
  return code === "40001" || code === "40P01" || code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03" || code === "53300";
}

/** Holiday provider for the org's calendar (Holy Spirit Monday optional). */
export function holidayFn(holySpirit: boolean): (year: number) => Set<string> {
  return (year) => greekHolidays(year, { includeHolySpirit: holySpirit });
}

/** `n` business days after the local date `isoDate` (n ≥ 0; n = 0 → the date itself). */
export function addBusinessDays(isoDate: string, n: number, holySpirit = false): string {
  const holidays = holidayFn(holySpirit);
  let d = DateTime.fromISO(isoDate, { zone: "UTC" });
  let left = n;
  while (left > 0) {
    d = d.plus({ days: 1 });
    if (isBusinessDay(d.toISODate()!, holidays)) left--;
  }
  return d.toISODate()!;
}

/** Default follow-up threshold for WAITING_FOR_OTHER: +3 business days from the local date of `instant`. */
export const DEFAULT_EXPECT_REPLY_BUSINESS_DAYS = 3;
export function defaultExpectReplyBy(instant: Date, zone: string, holySpirit = false): string {
  const local = DateTime.fromJSDate(instant, { zone }).toISODate()!;
  return addBusinessDays(local, DEFAULT_EXPECT_REPLY_BUSINESS_DAYS, holySpirit);
}

/** Start of the local day (in `zone`) containing `instant`, as an instant. */
export function localDayStart(instant: Date, zone: string): Date {
  return DateTime.fromJSDate(instant, { zone }).startOf("day").toJSDate();
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(s: string): boolean {
  return ISO_DATE.test(s) && DateTime.fromISO(s, { zone: "UTC" }).isValid;
}

/** Tolerates both a Date (node-postgres) and a string (PGlite raw rows). */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** Clamp free text coming from the model or the user; empty → null. */
export function clampText(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)];
}

/** Append new items (accent/case-insensitive dedupe), clamped to the output limits. */
export function mergeItems(current: string[], add: string[]): string[] {
  const out = [...current];
  const seen = new Set(current.map(foldForMatch));
  for (const raw of add) {
    const item = clampText(raw, OUTPUT_LIMITS.maxItemLength);
    if (!item || seen.has(foldForMatch(item)) || out.length >= OUTPUT_LIMITS.maxItems) continue;
    seen.add(foldForMatch(item));
    out.push(item);
  }
  return out;
}

/** Internal = one of the org's domains or a subdomain of one. */
export function isInternalDomain(domain: string | null, internalDomains: readonly string[]): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return internalDomains.some((x) => {
    const i = x.toLowerCase();
    return d === i || d.endsWith("." + i);
  });
}

/** Domain usable for company matching: not a public free-mail domain and not internal. */
export function companyDomainOf(address: string | null | undefined, internalDomains: readonly string[]): string | null {
  const d = domainOf(address);
  if (!d || PUBLIC_MAIL_DOMAINS.has(d) || isInternalDomain(d, internalDomains)) return null;
  return d;
}

/** company_domains map of one org (domain → company). The table is small (editable list). */
export async function loadCompanyMap(db: DbOrTx, orgId: string): Promise<Map<string, string>> {
  const rows = await db.select({ domain: companyDomains.domain, company: companyDomains.company }).from(companyDomains).where(eq(companyDomains.orgId, orgId));
  return new Map(rows.map((r) => [r.domain.toLowerCase(), r.company]));
}

/** Company for a domain via the map, trying parent domains (mail.abc-gr.example → abc-gr.example). */
export function lookupCompany(map: Map<string, string>, domain: string | null): string | null {
  if (!domain) return null;
  let d = domain.toLowerCase();
  for (;;) {
    const hit = map.get(d);
    if (hit) return hit;
    const dot = d.indexOf(".");
    if (dot < 0 || d.indexOf(".", dot + 1) < 0) return null;
    d = d.slice(dot + 1);
  }
}

/**
 * All thread ids that belong together after merges: the root of `threadId`'s merge chain plus every thread
 * merged (directly or transitively) into it. Threads are merge-only, so this is the "same conversation" set.
 */
export async function threadFamily(db: DbOrTx, threadId: string | null): Promise<string[]> {
  if (!threadId) return [];
  const seen = new Set<string>([threadId]);
  let root = threadId;
  for (let i = 0; i < 20; i++) {
    const [row] = await db.select({ mergedIntoId: threads.mergedIntoId }).from(threads).where(eq(threads.id, root));
    if (!row?.mergedIntoId || seen.has(row.mergedIntoId)) break;
    root = row.mergedIntoId;
    seen.add(root);
  }
  const family = new Set<string>([root, ...seen]);
  let frontier = [root];
  for (let i = 0; i < 20 && frontier.length; i++) {
    const children = await db.select({ id: threads.id }).from(threads).where(inArray(threads.mergedIntoId, frontier));
    frontier = children.map((c) => c.id).filter((id) => !family.has(id));
    frontier.forEach((id) => family.add(id));
  }
  return [...family];
}

/** `(a, b, c)` list for raw SQL `in` clauses; callers must not pass an empty array. */
export function sqlList(values: readonly string[]) {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}
