/**
 * "Rules": a user's own mail rules (docs/rules/README.md). They are data on users.mail_rules, so one list drives
 * the pre-filter, the extractor, the "Answered" sweep, the daily report and the AI's <owner_rules>, and a new rule
 * of a known kind needs no code. An empty list changes nothing: every behaviour below is opt-in, one rule at a time.
 *
 * Kinds:
 *   spam      disabled → the spam and phishing filters (SPAM_FOLDER, PHISHING) let this user's mail through.
 *   ignore    mail about `topics` (any mail, when there are none) with one of `recipients` in To/Cc (any recipients,
 *             when there are none) creates nothing: pre-filter reason RULE, in both directions.
 *   forward   a new inbound mail from a known external sender whose subject is about `topics`, with `target` in
 *             neither To nor Cc, becomes one task to forward it to `target` (src/ai/rules-extractor.ts) instead of
 *             reaching the AI. The task is completed once a later mail of the organization in the thread involves
 *             `target`.
 *   answered  a later reply in the thread from the owner or a colleague (internal domain) completes the owner's open
 *             requests (ACTION_REQUIRED) and lists them in the report under "Answered". A request the owner
 *             forwards to a colleague becomes the colleague's and stays open until such a reply reaches the requester
 *             (src/engine/answered.ts).
 *   updates   the owner's own new mail (not a reply or forward) whose subject is about `topics` is listed in the
 *             report under "Updates".
 *   summary   the report opens with a summary of the day.
 *   note      text only, for the AI: judgement the code cannot make (e.g. what counts as a service request).
 *
 * Pure functions, shared by the engine, the server and the SPA.
 */
import { foldForMatch } from "../lib/text.js";

export const RULE_KINDS = ["spam", "ignore", "forward", "answered", "updates", "summary", "note"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface MailRule {
  /** Stable id within the user's list («orders-ignore»). */
  id: string;
  kind: RuleKind;
  enabled: boolean;
  /** The rule in the owner's own words. Shown in the UI and given to the AI. */
  text: string;
  /** ignore / forward / updates: keywords, matched accent- and case-insensitively at word starts ("order"). */
  topics?: string[];
  /** ignore / forward / updates: phrases that switch the rule off for a mail ("your order" = our own purchase). */
  except?: string[];
  /** ignore: addresses or "@domain" entries; one of them in To/Cc triggers the rule. */
  recipients?: string[];
  /** forward: the address the mail should have gone to. */
  target?: string;
}

export const RULE_LIMITS = { rules: 50, id: 60, text: 600, topics: 60, topic: 60, recipients: 30 } as const;

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ADDRESS = /^[^\s@]+@([a-z0-9-]+\.)+[a-z]{2,}$/;
const DOMAIN_ENTRY = /^@([a-z0-9-]+\.)+[a-z]{2,}$/;

/**
 * Tolerant reading of a stored or imported list: an unusable rule is skipped and reported by id (or position), never
 * fatal, so one bad rule cannot stop ingest. Strings are trimmed, lists de-duplicated, addresses lower-cased.
 */
export function normalizeRules(raw: unknown): { rules: MailRule[]; skipped: Array<{ id: string; error: string }> } {
  const rules: MailRule[] = [];
  const skipped: Array<{ id: string; error: string }> = [];
  if (!Array.isArray(raw)) return { rules, skipped: raw == null ? [] : [{ id: "*", error: "not a list" }] };
  const seen = new Set<string>();
  raw.slice(0, RULE_LIMITS.rules).forEach((r, i) => {
    const res = normalizeRule(r);
    const id = res.ok ? res.rule.id : typeof (r as { id?: unknown })?.id === "string" ? String((r as { id: string }).id) : `#${i + 1}`;
    if (!res.ok) return skipped.push({ id, error: res.error });
    if (seen.has(res.rule.id)) return skipped.push({ id, error: "duplicate id" });
    seen.add(res.rule.id);
    rules.push(res.rule);
  });
  if (raw.length > RULE_LIMITS.rules) skipped.push({ id: "*", error: `more than ${RULE_LIMITS.rules} rules` });
  return { rules, skipped };
}

function normalizeRule(r: unknown): { ok: true; rule: MailRule } | { ok: false; error: string } {
  if (!r || typeof r !== "object") return { ok: false, error: "not an object" };
  const o = r as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
  if (!ID.test(id) || id.length > RULE_LIMITS.id) return { ok: false, error: "id: lower-case letters, digits and dashes" };
  if (!(RULE_KINDS as readonly unknown[]).includes(o.kind)) return { ok: false, error: `kind: one of ${RULE_KINDS.join(", ")}` };
  const kind = o.kind as RuleKind;
  const text = typeof o.text === "string" ? o.text.trim().replace(/\s+/g, " ") : "";
  if (!text || text.length > RULE_LIMITS.text) return { ok: false, error: `text: 1–${RULE_LIMITS.text} characters` };
  const rule: MailRule = { id, kind, enabled: o.enabled !== false, text };

  const topics = strings(o.topics, RULE_LIMITS.topics).map((t) => t.replace(/\s+/g, " ")).filter((t) => t.length <= RULE_LIMITS.topic);
  const except = strings(o.except, RULE_LIMITS.topics).map((t) => t.replace(/\s+/g, " ")).filter((t) => t.length <= RULE_LIMITS.topic);
  const recipients = strings(o.recipients, RULE_LIMITS.recipients).map((a) => a.toLowerCase());
  if (recipients.some((a) => !ADDRESS.test(a) && !DOMAIN_ENTRY.test(a))) return { ok: false, error: "recipients: e-mail addresses or @domain" };
  const target = typeof o.target === "string" ? o.target.trim().toLowerCase() : "";

  if (except.length && (kind === "ignore" || kind === "forward" || kind === "updates")) rule.except = except;
  if (kind === "ignore") {
    if (!topics.length && !recipients.length) return { ok: false, error: "ignore needs topics or recipients" };
    if (topics.length) rule.topics = topics;
    if (recipients.length) rule.recipients = recipients;
  } else if (kind === "forward") {
    if (!topics.length) return { ok: false, error: "forward needs topics" };
    if (!ADDRESS.test(target)) return { ok: false, error: "forward needs a target address" };
    rule.topics = topics;
    rule.target = target;
  } else if (kind === "updates") {
    if (!topics.length) return { ok: false, error: "updates needs topics" };
    rule.topics = topics;
  }
  return { ok: true, rule };
}

function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** The enabled rule of a kind that takes one per user (answered, updates, summary), if any. */
export function activeRule(rules: readonly MailRule[], kind: "answered" | "updates" | "summary"): MailRule | null {
  return rules.find((r) => r.enabled && r.kind === kind) ?? null;
}

/** The spam and phishing filters stay on unless the user has a spam rule and switched it off. */
export function spamFilterOn(rules: readonly MailRule[]): boolean {
  return !rules.some((r) => r.kind === "spam" && !r.enabled);
}

// ── Matching ─────────────────────────────────────────────────────────────────

const EMAIL = /[^\s<>()"',;:]+@[^\s<>()"',;:]+/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Folded text for topic matching (src/lib/text.ts foldForMatch). E-mail addresses and links are removed first:
 * «orders@contoso.example» in a signature or a quoted «To:» line is not about orders.
 */
export function topicText(...parts: Array<string | null | undefined>): string {
  return foldForMatch(parts.filter(Boolean).join(" . ").replace(EMAIL, " ").replace(URL, " "));
}

/** One of the topics starts a word of `folded` (topicText output): "order" matches "Orders" and "ORDERED". */
export function mentionsTopic(folded: string, topics: readonly string[] | undefined): boolean {
  if (!topics?.length) return false;
  return topics.some((t) => {
    const k = foldForMatch(t);
    if (!k) return false;
    for (let i = folded.indexOf(k); i >= 0; i = folded.indexOf(k, i + 1)) {
      if (i === 0 || !/[\p{L}\p{N}]/u.test(folded[i - 1]!)) return true;
    }
    return false;
  });
}

/** Is one of the entries (address or "@domain", subdomains included) among the recipients (lower-cased addresses)? */
export function hasRecipient(recipients: readonly string[], entries: readonly string[] | undefined): boolean {
  if (!entries?.length) return false;
  return recipients.some((raw) => {
    const a = raw.trim().toLowerCase();
    const host = a.slice(a.lastIndexOf("@") + 1);
    return entries.some((e) => (e.startsWith("@") ? host === e.slice(1) || host.endsWith(`.${e.slice(1)}`) : a === e));
  });
}

/** The first enabled ignore rule that matches: its topics (if any) in the folded text and its recipients (if any) in To/Cc. */
export function ignoreRuleFor(rules: readonly MailRule[], mail: { folded: string; recipients: readonly string[] }): MailRule | null {
  return (
    rules.find(
      (r) =>
        r.enabled &&
        r.kind === "ignore" &&
        (!r.topics?.length || mentionsTopic(mail.folded, r.topics)) &&
        !mentionsTopic(mail.folded, r.except) &&
        (!r.recipients?.length || hasRecipient(mail.recipients, r.recipients)),
    ) ?? null
  );
}

/**
 * The enabled forward rule for a new inbound mail: its topics in the subject, its target in neither To nor Cc. The
 * caller checks the rest (external sender, known to the mailbox, not a reply or forward).
 */
export function forwardRuleFor(rules: readonly MailRule[], mail: { subject: string; recipients: readonly string[] }): MailRule | null {
  const folded = topicText(mail.subject);
  return (
    rules.find((r) => r.enabled && r.kind === "forward" && mentionsTopic(folded, r.topics) && !mentionsTopic(folded, r.except) && !hasRecipient(mail.recipients, [r.target!])) ?? null
  );
}

/** The rules the AI is told about: enabled ones, in the owner's words. */
export function rulesForAi(rules: readonly MailRule[]): Array<{ id: string; text: string }> {
  return rules.filter((r) => r.enabled).map((r) => ({ id: r.id, text: r.text }));
}
