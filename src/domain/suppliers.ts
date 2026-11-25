/**
 * "Suppliers": writing the supplier rules of a user's list (src/domain/rules.ts, kind "supplier"). Pure functions,
 * shared by the server (PUT /api/rules/suppliers) and the SPA (the card on the "Suppliers" screen), so a typed or
 * pasted list means the same thing on both sides.
 *
 * A supplier is a name and the addresses or "@domain" entries its mail comes from. A sender belongs to one supplier
 * only, is never the user's own address or the organization's domain, and a public mail domain (gmail.com) is only
 * accepted as a whole address.
 */
import { PUBLIC_MAIL_DOMAINS } from "../lib/text.js";
import { companyKey, forbiddenMute, parseEntry } from "./preferences.js";
import { normalizeRules, RULE_LIMITS, senderClash, type MailRule } from "./rules.js";

export interface SupplierEntry {
  name: string;
  senders: string[];
}

export const SUPPLIER_LIMITS = { entries: 100, listChars: 20_000 } as const;

export interface ParsedSupplierList {
  entries: SupplierEntry[];
  /** Names that came without an address or domain (a table's header row, usually): nothing is made of them. */
  ignored: string[];
  errors: string[];
}

/**
 * A typed or pasted list of suppliers. A name is followed by its addresses or "@domain" entries, on the same line
 * ("NORTHWIND @northwind.example", as copied from a sheet: tabs, commas and semicolons separate too) or on the lines after it
 * (a table copied cell by cell). Whatever holds an "@" is a sender; the rest of a line is a name.
 */
export function parseSupplierList(text: string): ParsedSupplierList {
  const entries: SupplierEntry[] = [];
  const pending = new Map<string, SupplierEntry>();
  const errors: string[] = [];
  const order: SupplierEntry[] = [];
  let current: SupplierEntry | null = null;
  for (const line of text.slice(0, SUPPLIER_LIMITS.listChars).split(/\r?\n/)) {
    const tokens = line.split(/[\s,;|]+/u).filter(Boolean);
    if (!tokens.length) continue;
    const nameText = tokens
      .filter((t) => !t.includes("@"))
      .join(" ")
      .trim();
    if (nameText) {
      if (nameText.length > RULE_LIMITS.name) {
        errors.push(`“${nameText.slice(0, 30)}…”: a name holds up to ${RULE_LIMITS.name} characters.`);
        current = null;
      } else {
        const key = companyKey(nameText) || nameText.toLowerCase();
        current = pending.get(key) ?? null;
        if (!current) {
          current = { name: nameText, senders: [] };
          pending.set(key, current);
          order.push(current);
        }
      }
    }
    for (const raw of tokens.filter((t) => t.includes("@"))) {
      const token = raw.replace(/^[<(["']+|[>)\]"'.]+$/g, "");
      if (!current) {
        errors.push(`“${token}”: write the supplier's name first.`);
        continue;
      }
      const p = parseEntry(token, "muted");
      if (!p.ok) {
        errors.push(`${current.name}: “${token}”: ${p.error}`);
        continue;
      }
      if (!current.senders.includes(p.entry.value)) current.senders.push(p.entry.value);
    }
  }
  const ignored: string[] = [];
  for (const e of order) {
    if (e.senders.length) entries.push(e);
    else ignored.push(e.name);
  }
  if (entries.length > SUPPLIER_LIMITS.entries) errors.push(`Up to ${SUPPLIER_LIMITS.entries} suppliers at a time.`);
  return { entries, ignored, errors };
}

/** A rule id for a new supplier: "supplier-northwind"; numbered when taken, "supplier-x" when the name has no Latin letter or digit. */
export function supplierRuleId(name: string, taken: ReadonlySet<string>): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const base = `supplier-${slug || "x"}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const idOf = (r: unknown): string => (r && typeof r === "object" ? String((r as { id?: unknown }).id ?? "").trim().toLowerCase() : "");

export type SupplierWrite = { ok: true; next: unknown[]; ids: string[] } | { ok: false; error: string };

/**
 * The stored list with these suppliers written into it. A supplier that exists already (the same name, whatever its
 * accents and case) keeps its id and its on/off state: "add" joins the new senders to the ones it has and leaves its
 * name as it is written, "replace" leaves it with exactly these senders and this spelling of the name. Every other
 * stored rule, the unusable ones included, stays as it is.
 * Refused, with the reason: an entry that is no address or domain, the user's own or the organization's,
 * a whole public mail domain, or a sender another supplier holds.
 */
export function upsertSuppliers(
  stored: readonly unknown[],
  entries: readonly SupplierEntry[],
  opts: { mode: "add" | "replace"; own: { addresses: readonly string[]; internalDomains: readonly string[] } },
): SupplierWrite {
  if (!entries.length) return { ok: false, error: "Write a supplier and their email address or @domain." };
  if (entries.length > SUPPLIER_LIMITS.entries) return { ok: false, error: `Up to ${SUPPLIER_LIMITS.entries} suppliers at a time.` };
  const next: unknown[] = [...stored];
  const usable = normalizeRules(stored).rules;
  const taken = new Set(next.map(idOf).filter(Boolean));
  const byName = new Map(usable.filter((r) => r.kind === "supplier").map((r) => [companyKey(r.name ?? "") || (r.name ?? "").toLowerCase(), r]));
  const touched = new Map<string, MailRule>();

  for (const e of entries) {
    const name = e.name.trim().replace(/\s+/g, " ");
    if (!name) return { ok: false, error: "Write the supplier's name." };
    if (name.length > RULE_LIMITS.name) return { ok: false, error: `“${name.slice(0, 30)}…”: a name holds up to ${RULE_LIMITS.name} characters.` };
    const senders: string[] = [];
    for (const raw of e.senders) {
      if (!raw.trim()) continue;
      const p = parseEntry(raw, "muted");
      if (!p.ok) return { ok: false, error: `${name}: “${raw.trim().slice(0, 80)}”: ${p.error}` };
      if (!senders.includes(p.entry.value)) senders.push(p.entry.value);
    }
    const key = companyKey(name) || name.toLowerCase();
    const before = touched.get(key) ?? byName.get(key) ?? null;
    const all = opts.mode === "add" && before ? [...new Set([...(before.senders ?? []), ...senders])] : touched.has(key) ? [...new Set([...(before?.senders ?? []), ...senders])] : senders;
    if (!all.length) return { ok: false, error: `${name}: write an email address (e.g. info@example.com) or a domain (e.g. @example.com).` };
    if (all.length > RULE_LIMITS.senders) return { ok: false, error: `${name}: up to ${RULE_LIMITS.senders} email addresses or domains.` };
    const own = forbiddenMute(all, opts.own);
    if (own) return { ok: false, error: `“${own}” is your own address or your organization's: it is not a supplier.` };
    const open = all.find((s) => s.startsWith("@") && PUBLIC_MAIL_DOMAINS.has(s.slice(1)));
    if (open) return { ok: false, error: `“${open}” is a public mail service: write the supplier's full address.` };

    const id = before?.id ?? supplierRuleId(name, taken);
    taken.add(id);
    // One more sender for "NORTHWIND", typed as "northwind", does not rename it.
    const written = opts.mode === "add" && before?.name ? before.name : name;
    // The rule's sentence follows the name unless somebody wrote their own (an imported file).
    const text = before && before.text !== before.name ? before.text : written;
    touched.set(key, { id, kind: "supplier", enabled: before?.enabled ?? true, text, name: written, senders: all });
  }

  for (const rule of touched.values()) {
    const at = next.findIndex((r) => idOf(r) === rule.id);
    if (at >= 0) next[at] = rule;
    else next.push(rule);
  }
  if (next.length > RULE_LIMITS.rules) return { ok: false, error: `Up to ${RULE_LIMITS.rules} rules in total.` };

  // A sender belongs to one supplier: against the stored ones and against each other.
  const suppliers = [...usable.filter((r) => r.kind === "supplier" && ![...touched.values()].some((t) => t.id === r.id)), ...touched.values()];
  for (const rule of touched.values()) {
    const clash = senderClash(rule, suppliers);
    if (clash) return { ok: false, error: `“${clash.entry}” already belongs to the supplier ${clash.rule.name}.` };
  }
  const after = normalizeRules(next);
  const lost = [...touched.values()].find((t) => !after.rules.some((r) => r.id === t.id));
  if (lost) return { ok: false, error: `${lost.name}: ${after.skipped.find((s) => s.id === lost.id)?.error ?? "cannot be saved"}` };
  return { ok: true, next, ids: [...touched.values()].map((t) => t.id) };
}

const isSupplier = (r: unknown): boolean => !!r && typeof r === "object" && (r as { kind?: unknown }).kind === "supplier";

/** The stored list without one supplier (a usable one or not); null when `id` is not a supplier of this list. */
export function removeSupplier(stored: readonly unknown[], id: string): unknown[] | null {
  const key = id.trim().toLowerCase();
  if (!key || !stored.some((r) => isSupplier(r) && idOf(r) === key)) return null;
  return stored.filter((r) => !(isSupplier(r) && idOf(r) === key));
}
