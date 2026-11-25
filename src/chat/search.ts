/**
 * What the chat may read (src/chat/engine.ts): the asking user's own mail and tasks, and nothing else.
 *
 * Every query here starts from the user's own mailboxes or `tasks.user_id`: a handle or an id from the browser or
 * from the model never widens that. The per-mailbox view (`ChatScope.onlyMailbox`) narrows both to one of those
 * mailboxes. On top of it, some of the user's own mail stays out:
 *   - the platform's own mail, drafts and deleted mail, the spam folder and phishing, private folders, and mail to
 *     or from the install's deny-list (DENY_LIST);
 *   - senders on the user's "Ignore" list (users.muted_senders: "never reaches the AI"), also mail that arrived
 *     before they were muted;
 *   - mail the AI classified PERSONAL or SPAM (its text is dropped at once, src/ops/retention.ts), and mail the AI
 *     has not read yet (nobody knows yet that it is neither).
 * None of this is taken from `filter_reason` alone. That column holds the FIRST pre-filter rule that matched, at
 * the time the mail arrived: a phishing mail with an unsubscribe header is stored as BULK, and mail the user moved
 * to the spam folder afterwards keeps the reason it had. So the folders and flags of a message are read as the last
 * syncs saw them, the deny-list and the "Ignore" list as they are now, and the spam and phishing rules are applied
 * here to the mail the pre-filter never tried them on (see {@link SPAM_UNCHECKED_REASONS}).
 *
 * Text is read from `segments` only: the ingest redacts IBANs, card numbers and passwords there, and retention
 * empties it after BODY_RETENTION_DAYS. `text_plain` and `text_html` are never read.
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import type { DbOrTx } from "../db/client.js";
import { mailboxes, messages, organizations, taskLinks, tasks, users } from "../db/schema.js";
import { senderMatches } from "../domain/preferences.js";
import { normalizeRules, spamFilterOn } from "../domain/rules.js";
import type { Address, Attachment, Segment, TaskStatus } from "../domain/types.js";
import { OPEN_STATUSES } from "../domain/types.js";
import { sqlList, threadFamily } from "../engine/db-util.js";
import { domainOf, foldForSearch, PUBLIC_MAIL_DOMAINS } from "../lib/text.js";
import { isPhishing, matchesDeny, phishingSignals, senderAuthFailed } from "../mail/prefilter.js";

// ── Scope ───────────────────────────────────────────────────────────────────

export interface ChatScope {
  userId: string;
  userName: string;
  /** The mailboxes that are read: the user's (any status: mail already fetched stays readable), or the one of {@link onlyMailbox}. */
  mailboxIds: string[];
  /**
   * The per-mailbox view: the user asks about this one mailbox of theirs. Its mail only (`mailboxIds` is just it) and
   * the tasks that belong to it ({@link ownTasks}). Null: everything of the user's.
   */
  onlyMailbox: { id: string; address: string } | null;
  /** The user's own addresses, of every mailbox (the user is the same person in each): addresses and aliases, lower-cased. */
  ownAddresses: string[];
  /** The organization's own domains (colleagues write from them). */
  internalDomains: string[];
  /** The domains mail of the user's own side comes from: those of their addresses (free mail excluded) and the organization's. */
  ownDomains: string[];
  /** users.muted_senders. */
  muted: string[];
  /** The install's deny-list (DENY_LIST: addresses and domains whose mail is private), lower-cased. */
  denyList: string[];
  /** False when the user switched their own spam rule off: the spam folder and phishing are then read like other mail, as in the task pipeline. */
  spamFilter: boolean;
  zone: string;
  now: Date;
}

/**
 * Who asks and what they may read; null when there is no such user — or when `mailboxId` (the per-mailbox view) is
 * not one of that user's own mailboxes: a view can only narrow what is read, so an unknown one reads nothing.
 */
export async function loadChatScope(db: DbOrTx, userId: string, zone: string, now: Date, opts: { denyList?: readonly string[]; mailboxId?: string | null } = {}): Promise<ChatScope | null> {
  const [u] = await db
    .select({ name: users.name, muted: users.mutedSenders, mailRules: users.mailRules, internalDomains: organizations.internalDomains })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(eq(users.id, userId));
  if (!u) return null;
  const boxes = await db.select({ id: mailboxes.id, address: mailboxes.address, aliases: mailboxes.aliases }).from(mailboxes).where(eq(mailboxes.userId, userId)).orderBy(asc(mailboxes.createdAt));
  const only = opts.mailboxId ? boxes.find((b) => b.id === opts.mailboxId!.toLowerCase()) : undefined;
  if (opts.mailboxId && !only) return null;
  const own = new Set<string>();
  for (const b of boxes) for (const a of [b.address, ...(b.aliases ?? [])]) if (a?.trim()) own.add(a.trim().toLowerCase());
  const internalDomains = (u.internalDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  // The same domains the pre-filter's phishing rule gets (src/mail/ingest.ts: loadMailbox).
  const ownerDomains = [...own].map(domainOf).filter((d): d is string => !!d && !PUBLIC_MAIL_DOMAINS.has(d));
  return {
    userId,
    userName: u.name,
    mailboxIds: only ? [only.id] : boxes.map((b) => b.id),
    onlyMailbox: only ? { id: only.id, address: only.address } : null,
    ownAddresses: [...own],
    internalDomains,
    ownDomains: [...new Set([...ownerDomains, ...internalDomains])],
    muted: u.muted ?? [],
    denyList: (opts.denyList ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
    spamFilter: spamFilterOn(normalizeRules(u.mailRules).rules),
    zone,
    now,
  };
}

// ── Folding (a word is matched whatever its case and accents) ───────────────

/**
 * Greek capitals, accented vowels and the final sigma, and the accented Latin letters of European names, and what
 * each becomes. An explicit map instead of the database's own rules: `lower()` follows the database locale (it
 * leaves everything but ASCII alone under "C"), and there is no unaccent extension to rely on. One character for
 * one, always: a position in the folded text stays a position in the original.
 *
 * The words are folded here, in JS; the stored text is not folded at all. A word becomes a pattern that accepts
 * every spelling which folds to it ({@link termPattern}), and the database matches that against the text as it is.
 * (Folding the text in SQL, `translate(lower(…))` over every message, took a second per thousand messages.)
 */
const GREEK_FROM = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΆΈΉΊΌΎΏΪΫάέήίόύώϊϋΐΰς";
const GREEK_TO = "αβγδεζηθικλμνξοπρστυφχψωαεηιουωιυαεηιουωιυιυσ";
const LATIN_FOLDS: ReadonlyArray<readonly [string, string]> = [
  ["ÀÁÂÃÄÅĀĂĄàáâãäåāăą", "a"],
  ["ÇĆČçćč", "c"],
  ["ĎĐďđ", "d"],
  ["ÈÉÊËĒĖĘĚèéêëēėęě", "e"],
  ["ĞĢğģ", "g"],
  ["ÌÍÎÏĪİìíîïīı", "i"],
  ["ĹĽŁĺľł", "l"],
  ["ÑŃŇñńň", "n"],
  ["ÒÓÔÕÖØŌŐòóôõöøōő", "o"],
  ["ŔŘŕř", "r"],
  ["ŚŞŠśşš", "s"],
  ["ŢŤţť", "t"],
  ["ÙÚÛÜŪŮŰùúûüūůű", "u"],
  ["ÝŸýÿ", "y"],
  ["ŹŻŽźżž", "z"],
];
export const FOLD_FROM = GREEK_FROM + LATIN_FOLDS.map(([chars]) => chars).join("");
export const FOLD_TO = GREEK_TO + LATIN_FOLDS.map(([chars, to]) => to.repeat(chars.length)).join("");

const FOLD_MAP: ReadonlyMap<string, string> = new Map([...FOLD_FROM].map((c, i) => [c, [...FOLD_TO][i]!]));
/** A folded letter → the other letters that fold to it. */
const UNFOLD: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [from, to] of FOLD_MAP) m.set(to, (m.get(to) ?? "") + from);
  return m;
})();

/**
 * The same folding in JS, one character at a time, so the result has the length of the input and a position in it
 * is a position in the original (snippets are cut that way).
 */
export function foldText(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const mapped = FOLD_MAP.get(ch);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? (FOLD_MAP.get(lower) ?? lower) : ch;
  }
  return out;
}

/**
 * A folded word as a POSIX regular expression that finds it in text which is not folded: each letter is a bracket
 * expression of every character that folds to it, and everything else stands for itself. "τιμ-7" becomes
 * `[τΤ][ιΙΊΪίϊΐ][μΜ]-7`. No operators survive: the word is matched as a plain piece of text.
 */
export function termPattern(folded: string): string {
  let out = "";
  for (const ch of folded) {
    const upper = ch.toUpperCase();
    // The capital, when it is one character that folds back to this one ("ß" has none of its own).
    const capital = upper !== ch && upper.length === ch.length && foldText(upper) === ch ? upper : "";
    const others = [...new Set(capital + (UNFOLD.get(ch) ?? ""))].filter((c) => c !== ch).join("");
    if (others) out += `[${ch}${others}]`;
    else out += /[\\^$.|?*+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** `expr` holds the folded word, whatever the case and the accents it is written with there. */
const holds = (expr: SQL, folded: string): SQL => sql`${expr} ~ ${termPattern(folded)}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const TERM_LIMITS = { minChars: 2, maxChars: 60, allOf: 6, anyOf: 10 } as const;

/** Search words as the model wrote them → folded, trimmed, de-duplicated, capped. */
export function cleanTerms(raw: readonly string[] | null | undefined, max: number): string[] {
  const out: string[] = [];
  for (const r of raw ?? []) {
    if (typeof r !== "string") continue;
    // Control characters become spaces: the database refuses a NUL in a text, and none of them is ever a word.
    const t = foldText(r.normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, " ")).replace(/\s+/g, " ").trim().slice(0, TERM_LIMITS.maxChars).trim();
    if (t.length < TERM_LIMITS.minChars || out.includes(t)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

// ── What stays out ──────────────────────────────────────────────────────────

/** Filter reasons whose mail the chat never reads (the others are ordinary mail the AI simply did not need). */
export const HIDDEN_FILTER_REASONS = ["OWN_MAIL", "DENYLIST", "MUTED", "SPAM_FOLDER", "PHISHING", "DRAFT_OR_DELETED"] as const;
/**
 * Reasons that say nothing about spam: the pre-filter stops at the first rule that matches, and these come before
 * its spam-folder and phishing rules (src/mail/prefilter.ts); the age rule replaces any reason at all
 * (src/mail/ingest.ts). For mail with one of them those two rules are applied here.
 */
export const SPAM_UNCHECKED_REASONS = ["BOUNCE", "OUT_OF_OFFICE", "CALENDAR_REPLY", "BULK", "NOREPLY", "TOO_OLD"] as const;
const HIDDEN_CLASSES = ["PERSONAL", "SPAM"] as const;
/** IMAP flags of a copy nobody should read (compared in lower case). */
const DEAD_FLAGS = ["\\deleted", "\\draft"] as const;
const SPAM_FLAG_HEADER = "^\\s*yes\\y";

const isUnchecked = (reason: string | null): boolean => !!reason && (SPAM_UNCHECKED_REASONS as readonly string[]).includes(reason);

/** `m.from_address` is not this entry of a sender list: an address, or a domain ("@domain", "domain") with its subdomains. */
function senderIsNot(entry: string): SQL | null {
  const e = entry.trim().toLowerCase();
  const from = sql`coalesce(lower(m.from_address), '')`;
  if (e.startsWith("@") ? e.length > 1 : !!e && !e.includes("@")) {
    const d = escapeLike(e.replace(/^@/, ""));
    return sql`(${from} not like ${`%@${d}`} and ${from} not like ${`%.${d}`})`;
  }
  return e.includes("@") ? sql`${from} <> ${e}` : null;
}

/**
 * The predicate on a `messages m` row: the user's own mailboxes, minus what stays out. Everything a query can tell;
 * {@link hiddenByContent} adds the two checks that need the row itself.
 *
 * Folders and flags come from `message_locations`: one row per copy a sync has seen, never updated and never
 * removed. So "where the message is" means its most recent sighting: mail filed from the inbox into another folder,
 * or a draft that was then sent, is read from the newer copy, and mail that turned up in the trash or the spam
 * folder afterwards is out. What no sync has seen (mail deleted on the server after it was read, in a folder that
 * is not synced) cannot be known here, as it cannot for the task list. A private folder is different: a copy that
 * was ever seen in one keeps the message out for good.
 */
function visibleSql(scope: ChatScope): SQL {
  const unchecked = sql`coalesce(m.filter_reason, '') in (${sqlList(SPAM_UNCHECKED_REASONS)})`;
  // The spam folder, for mail somebody else wrote (as in the pre-filter): when the spam rule was never tried on
  // the message, or when it was seen elsewhere first (it was moved there). A message that arrived in the spam
  // folder and was let through anyway (a known contact) stays: the pre-filter decided that, and it may be a task.
  const junk = scope.spamFilter
    ? sql`or (m.direction = 'INBOUND' and f.role = 'junk' and (${unchecked} or exists (select 1 from message_locations e where e.message_id = m.id and e.first_seen_at < ml.first_seen_at)))`
    : sql``;
  const parts: SQL[] = [
    sql`m.mailbox_id in (${sqlList(scope.mailboxIds)})`,
    // Only what MailMe has read: mail that still waits for the AI, or that it could not read, is not yet known to
    // be neither personal nor spam (notAnalysed() counts it, and the model is told).
    sql`(m.state in ('applied', 'filtered', 'skipped_old') or (m.state = 'extracted' and m.classification is not null))`,
    sql`(m.filter_reason is null or m.filter_reason not in (${sqlList(HIDDEN_FILTER_REASONS)}))`,
    sql`(m.classification is null or m.classification not in (${sqlList(HIDDEN_CLASSES)}))`,
    sql`not exists (
      select 1 from message_locations ml join mailbox_folders f on f.id = ml.folder_id
      where ml.message_id = m.id and (
        f.private
        or (
          not exists (select 1 from message_locations newer where newer.message_id = m.id and newer.first_seen_at > ml.first_seen_at)
          and (
            f.role in ('drafts', 'trash')
            or exists (select 1 from unnest(ml.flags) fl where lower(fl) in (${sqlList(DEAD_FLAGS)}))
            ${junk}
          )
        )
      ))`,
  ];
  // The mail server's own spam verdict, for the mail the spam rule was never tried on.
  if (scope.spamFilter) parts.push(sql`not (m.direction = 'INBOUND' and ${unchecked} and coalesce(m.headers->>'x-spam-flag', '') ~* ${SPAM_FLAG_HEADER})`);
  // The "Ignore" list and the deny-list as they are now, so mail from before an entry was added stays out too.
  // (The first entries of each: hiddenByContent checks every row against the whole lists.)
  for (const entry of [...scope.muted.slice(0, 200), ...scope.denyList.slice(0, 300)]) {
    const cond = senderIsNot(entry);
    if (cond) parts.push(cond);
  }
  return sql.join(parts, sql` and `);
}

/**
 * What only the row itself can tell, for a row {@link visibleSql} let through: the deny-list on the recipients of
 * the user's own mail, and the phishing rule for mail the pre-filter never tried it on.
 */
function hiddenByContent(scope: ChatScope, m: MessageRow): boolean {
  if (senderMatches(m.fromAddress, scope.muted)) return true;
  if (scope.denyList.length) {
    // As the pre-filter reads the list (src/mail/prefilter.ts: isDenied): inbound mail by its sender or the address
    // replies go to, the user's own mail when every recipient is on it.
    const denied = (a: Address | null | undefined): boolean => !!a?.address && matchesDeny(a.address, scope.denyList);
    if (m.direction === "OUTBOUND") {
      const rcpts = [...(m.to ?? []), ...(m.cc ?? []), ...(m.bcc ?? [])];
      if (rcpts.length > 0 && rcpts.every(denied)) return true;
    } else if ((m.fromAddress && matchesDeny(m.fromAddress, scope.denyList)) || (m.replyTo ?? []).some(denied)) return true;
  }
  if (scope.spamFilter && m.direction !== "OUTBOUND" && isUnchecked(m.filterReason)) {
    const text = (Array.isArray(m.segments) ? m.segments : []).map((s) => s.text).join("\n");
    const from = m.fromAddress ? { address: m.fromAddress, name: m.fromName } : null;
    if (isPhishing(phishingSignals({ from, subject: m.subject ?? "", text, headers: m.headers ?? {}, ownDomains: scope.ownDomains, claimsOwnerSender: m.claimsOwnerSender }))) return true;
  }
  return false;
}

/** Mail of the user that MailMe has not read yet (waiting for the AI, or set aside after an error): the chat does not show it, and says so. */
export async function notAnalysed(db: DbOrTx, scope: ChatScope): Promise<{ count: number; newest: Date | null }> {
  if (!scope.mailboxIds.length) return { count: 0, newest: null };
  const res = await db.execute(sql`
    select count(*) as n, max(m.sort_ts) as newest from messages m
    where m.mailbox_id in (${sqlList(scope.mailboxIds)}) and m.state in ('pending', 'failed')`);
  const row = res.rows[0] as { n: number | string; newest: Date | string | null } | undefined;
  const count = Number(row?.n ?? 0);
  return { count, newest: count && row?.newest ? new Date(row.newest) : null };
}

// ── Mail ────────────────────────────────────────────────────────────────────

export interface MailQuery {
  /** Every one of these must appear (subject, people, attachment names or text). */
  allOf: string[];
  /** At least one of these must appear, when any is given. */
  anyOf: string[];
  /** Part of a name, an address or a domain: sender or recipient. */
  person: string | null;
  /** Local dates (the user's zone), inclusive. */
  after: string | null;
  before: string | null;
  sender: "anyone" | "me" | "others";
  limit: number;
}

export interface MailRecord {
  id: string;
  threadId: string | null;
  /**
   * When it was sent or received, as the mail server knows it (messages.sort_ts): what the searches filter and
   * order by. Not the Date header, which the sender writes.
   */
  date: Date;
  /** Written by the user: a Sent copy, or a copy of their own mail that came back to the inbox. */
  own: boolean;
  /** Not the user's own, but from an address of the organization's domains. */
  internal: boolean;
  /**
   * Says it comes from the user or from the organization, but the mail server's checks show the sender was not
   * authenticated (never true for a Sent copy, and not judged for outsiders, who can be anybody anyway).
   */
  unverified: boolean;
  fromName: string | null;
  fromAddress: string | null;
  to: Address[];
  cc: Address[];
  subject: string;
  attachments: string[];
  /** BULK, NOREPLY, RULE, … when the pre-filter set it aside (still the user's mail). */
  filterReason: string | null;
  segments: Segment[];
  /** False once retention has dropped the text. */
  textKept: boolean;
  /** Messages of the same conversation the chat may read. */
  threadSize: number;
  /** Tasks made from this mail or its conversation (open ones first). */
  tasks: TaskRef[];
}

export interface TaskRef {
  id: string;
  ref: number;
  title: string;
  status: TaskStatus;
}

export interface MailSearchResult {
  /** How many messages matched (more than `hits` when the limit cut the list). */
  total: number;
  hits: Array<MailRecord & { snippet: string }>;
}

export const MAIL_SEARCH_MAX = 12;
/** Rows asked for beyond the limit, for the few that only the row itself shows as hidden (hiddenByContent). */
const SEARCH_SPARE = 6;
const SNIPPET_CHARS = 260;

const MESSAGE_COLUMNS = {
  id: messages.id,
  mailboxId: messages.mailboxId,
  threadId: messages.threadId,
  direction: messages.direction,
  claimsOwnerSender: messages.claimsOwnerSender,
  fromAddress: messages.fromAddress,
  fromName: messages.fromName,
  to: messages.to,
  cc: messages.cc,
  // Read for the deny-list only: neither is shown to the model.
  bcc: messages.bcc,
  replyTo: messages.replyTo,
  subject: messages.subject,
  sortTs: messages.sortTs,
  headers: messages.headers,
  segments: messages.segments,
  attachments: messages.attachments,
  bodyPurgedAt: messages.bodyPurgedAt,
  state: messages.state,
  filterReason: messages.filterReason,
  classification: messages.classification,
} as const;

type MessageRow = {
  id: string;
  mailboxId: string;
  threadId: string | null;
  direction: string;
  claimsOwnerSender: boolean;
  fromAddress: string | null;
  fromName: string | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  sortTs: Date;
  headers: Record<string, string>;
  segments: Segment[];
  attachments: Attachment[];
  bodyPurgedAt: Date | null;
  state: string;
  filterReason: string | null;
  classification: string | null;
};

/** Start of a local date (YYYY-MM-DD) in the user's zone, as an instant; null when the text is not a date. */
export function localDayStart(day: string | null | undefined, zone: string, plusDays = 0): Date | null {
  const text = (day ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const d = DateTime.fromISO(text, { zone });
  return d.isValid ? d.plus({ days: plusDays }).startOf("day").toJSDate() : null;
}

export async function searchMail(db: DbOrTx, scope: ChatScope, q: MailQuery): Promise<MailSearchResult> {
  if (!scope.mailboxIds.length) return { total: 0, hits: [] };
  const allOf = cleanTerms(q.allOf, TERM_LIMITS.allOf);
  const anyOf = cleanTerms(q.anyOf, TERM_LIMITS.anyOf).filter((t) => !allOf.includes(t));
  const person = cleanTerms(q.person ? [q.person] : [], 1)[0] ?? null;
  const limit = Math.max(1, Math.min(MAIL_SEARCH_MAX, Math.floor(q.limit) || 8));

  const inner: SQL[] = [visibleSql(scope)];
  const after = localDayStart(q.after, scope.zone);
  const before = localDayStart(q.before, scope.zone, 1);
  // A day that cannot be read never widens the search to all time (the engine refuses such a lookup with a reason).
  if ((q.after?.trim() && !after) || (q.before?.trim() && !before)) return { total: 0, hits: [] };
  if (after) inner.push(sql`m.sort_ts >= ${after.toISOString()}::timestamptz`);
  if (before) inner.push(sql`m.sort_ts < ${before.toISOString()}::timestamptz`);
  const mine = sql`(m.direction = 'OUTBOUND' or m.claims_owner_sender)`;
  if (q.sender === "me") inner.push(mine);
  if (q.sender === "others") inner.push(sql`not ${mine}`);

  const anywhere = (t: string): SQL => sql`(${holds(sql`c.head`, t)} or ${holds(sql`c.people`, t)} or ${holds(sql`c.body`, t)} or ${holds(sql`c.quoted`, t)})`;
  const direct = (t: string): SQL => sql`(${holds(sql`c.head`, t)} or ${holds(sql`c.people`, t)} or ${holds(sql`c.body`, t)})`;
  const outer: SQL[] = allOf.map(anywhere);
  if (anyOf.length) outer.push(sql`(${sql.join(anyOf.map(anywhere), sql` or `)})`);
  if (person) outer.push(holds(sql`c.people`, person));
  const terms = [...allOf, ...anyOf];
  // A word found only in a quoted older message ranks after one in the message itself; then the newest first.
  // (No constant in its place when there are no words: `order by 0` is a column position to Postgres, and an error.)
  const quotedLast = terms.length ? sql`(case when ${sql.join(terms.map(direct), sql` or `)} then 0 else 1 end), ` : sql``;

  const names = (list: SQL): SQL => sql`coalesce((select string_agg(coalesce(a->>'name', '') || ' ' || coalesce(a->>'address', ''), ' ') from jsonb_array_elements(${list}) a), '')`;
  const segText = (cond: SQL): SQL => sql`coalesce((select string_agg(s->>'text', ' ') from jsonb_array_elements(m.segments) s where ${cond}), '')`;
  const found = await db.execute(sql`
    select c.id, count(*) over() as total
    from (
      select m.id, m.sort_ts,
        coalesce(m.subject, '') || ' ' || coalesce((select string_agg(a->>'filename', ' ') from jsonb_array_elements(m.attachments) a), '') as head,
        coalesce(m.from_name, '') || ' ' || coalesce(m.from_address, '') || ' ' || ${names(sql`m."to" || m.cc`)} as people,
        ${segText(sql`s->>'kind' <> 'QUOTED'`)} as body,
        ${segText(sql`s->>'kind' = 'QUOTED'`)} as quoted
      from messages m
      where ${sql.join(inner, sql` and `)}
    ) c
    ${outer.length ? sql`where ${sql.join(outer, sql` and `)}` : sql``}
    order by ${quotedLast}c.sort_ts desc, c.id
    limit ${limit + SEARCH_SPARE}`);
  const rows = found.rows as Array<{ id: string; total: number | string }>;
  if (!rows.length) return { total: 0, hits: [] };

  const order = rows.map((r) => r.id);
  const records = await loadRecords(db, scope, order);
  const byId = new Map(records.map((r) => [r.id, r]));
  const readable = order.flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ ...r, snippet: snippetOf(r.segments, terms) }] : [];
  });
  const hits = readable.slice(0, limit);
  // The count is the query's, less the rows it returned that turned out hidden.
  return { total: Math.max(hits.length, Number(rows[0]!.total) - (order.length - readable.length)), hits };
}

/** Messages by id, restricted to what the user may read, with their conversation size and tasks. Order: as asked. */
export async function loadRecords(db: DbOrTx, scope: ChatScope, ids: readonly string[]): Promise<MailRecord[]> {
  // Ids can come from the browser (sources of earlier answers): anything that is not a uuid finds nothing.
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))];
  if (!wanted.length || !scope.mailboxIds.length) return [];
  // The same rule as every search: an id is no way around it.
  const allowed = await db.execute(sql`select m.id from messages m where m.id in (${sqlList(wanted)}) and ${visibleSql(scope)}`);
  const allowedIds = (allowed.rows as Array<{ id: string }>).map((r) => r.id);
  if (!allowedIds.length) return [];
  const rows = (await db
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(and(inArray(messages.id, allowedIds), inArray(messages.mailboxId, scope.mailboxIds)))) as MessageRow[];
  const visible = rows.filter((r) => !hiddenByContent(scope, r));
  if (!visible.length) return [];

  const threadIds = [...new Set(visible.map((r) => r.threadId).filter((t): t is string => !!t))];
  const sizes = new Map<string, number>();
  if (threadIds.length) {
    const counted = await db.execute(sql`select m.thread_id as id, count(*) as n from messages m where m.thread_id in (${sqlList(threadIds)}) and ${visibleSql(scope)} group by m.thread_id`);
    for (const r of counted.rows as Array<{ id: string; n: number | string }>) sizes.set(r.id, Number(r.n));
  }
  const linked = await linkedTasks(db, scope, visible.map((r) => r.id), threadIds);

  const byId = new Map(visible.map((r) => [r.id, r]));
  return wanted.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const taskList = [...(linked.byMessage.get(r.id) ?? []), ...((r.threadId && linked.byThread.get(r.threadId)) || [])];
    return [toRecord(scope, r, r.threadId ? (sizes.get(r.threadId) ?? 1) : 1, uniqueTasks(taskList))];
  });
}

function toRecord(scope: ChatScope, r: MessageRow, threadSize: number, taskList: TaskRef[]): MailRecord {
  const from = r.fromAddress?.toLowerCase() ?? null;
  const own = r.direction === "OUTBOUND" || r.claimsOwnerSender || (!!from && scope.ownAddresses.includes(from));
  const domain = domainOf(from);
  const internal = !own && !!domain && scope.internalDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
  return {
    id: r.id,
    threadId: r.threadId,
    date: r.sortTs,
    own,
    internal,
    unverified: (own || internal) && r.direction !== "OUTBOUND" && senderAuthFailed(r.headers),
    fromName: r.fromName,
    fromAddress: r.fromAddress,
    to: r.to ?? [],
    cc: r.cc ?? [],
    subject: r.subject ?? "",
    attachments: (r.attachments ?? []).filter((a) => !a.inline).map((a) => a.filename),
    filterReason: r.filterReason,
    segments: Array.isArray(r.segments) ? r.segments : [],
    textKept: r.bodyPurgedAt === null,
    threadSize,
    tasks: taskList,
  };
}

const isOpen = (s: TaskStatus): boolean => (OPEN_STATUSES as readonly string[]).includes(s);

/** The user's tasks (drizzle columns): all of them, or those of the mailbox the question is about. */
function ownTasks(scope: ChatScope): SQL {
  return scope.onlyMailbox ? sql`${tasks.userId} = ${scope.userId} and ${tasks.mailboxId} = ${scope.onlyMailbox.id}` : sql`${tasks.userId} = ${scope.userId}`;
}

function uniqueTasks(list: TaskRef[]): TaskRef[] {
  const seen = new Set<string>();
  const out = list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  return out.sort((a, b) => Number(isOpen(b.status)) - Number(isOpen(a.status)) || b.ref - a.ref);
}

async function linkedTasks(db: DbOrTx, scope: ChatScope, messageIds: string[], threadIds: string[]): Promise<{ byMessage: Map<string, TaskRef[]>; byThread: Map<string, TaskRef[]> }> {
  const byMessage = new Map<string, TaskRef[]>();
  const byThread = new Map<string, TaskRef[]>();
  if (!messageIds.length && !threadIds.length) return { byMessage, byThread };
  const where: SQL[] = [];
  if (messageIds.length) where.push(sql`tl.message_id in (${sqlList(messageIds)})`);
  if (threadIds.length) where.push(sql`tl.thread_id in (${sqlList(threadIds)})`);
  const res = await db.execute(sql`
    select tl.message_id, tl.thread_id, t.id, t.ref, t.title, t.status
    from task_links tl join tasks t on t.id = tl.task_id
    where t.user_id = ${scope.userId} ${scope.onlyMailbox ? sql`and t.mailbox_id = ${scope.onlyMailbox.id}` : sql``} and t.merged_into_id is null and (${sql.join(where, sql` or `)})`);
  for (const r of res.rows as Array<{ message_id: string | null; thread_id: string | null; id: string; ref: number; title: string; status: TaskStatus }>) {
    const task: TaskRef = { id: r.id, ref: Number(r.ref), title: r.title, status: r.status };
    if (r.message_id) byMessage.set(r.message_id, [...(byMessage.get(r.message_id) ?? []), task]);
    if (r.thread_id) byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), task]);
  }
  return { byMessage, byThread };
}

/** The message's own text (not what it quotes), blank-line separated. */
export function ownText(segments: readonly Segment[]): string {
  return segments
    .filter((s) => s.kind !== "QUOTED")
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A window of the message's text around the first search word found in it; its start when none is. */
export function snippetOf(segments: readonly Segment[], foldedTerms: readonly string[], max = SNIPPET_CHARS): string {
  const own = ownText(segments);
  const text = own || segments.map((s) => s.text.trim()).filter(Boolean).join("\n\n");
  if (!text) return "";
  const folded = foldText(text);
  let at = -1;
  for (const t of foldedTerms) {
    const i = folded.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0 && own && text === own) {
    // Found only in what the message quotes: show that part instead of an unrelated opening.
    const quoted = segments.filter((s) => s.kind === "QUOTED").map((s) => s.text.trim()).filter(Boolean).join("\n\n");
    const fq = foldText(quoted);
    for (const t of foldedTerms) {
      const i = fq.indexOf(t);
      if (i >= 0) return window(quoted, i, max);
    }
  }
  return window(text, Math.max(0, at), max);
}

function window(text: string, at: number, max: number): string {
  const start = Math.max(0, at - Math.floor(max / 3));
  const cut = text.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${oneLine(cut)}${start + max < text.length ? "…" : ""}`;
}

export interface ThreadView {
  /** Oldest first; at most THREAD_MAX_MESSAGES, the newest ones. */
  messages: MailRecord[];
  /** Older messages of the conversation that were left out. */
  omitted: number;
  tasks: TaskRef[];
}

export const THREAD_MAX_MESSAGES = 14;

/** The whole conversation of one message the user may read; null when the id is not theirs to read. */
export async function readThread(db: DbOrTx, scope: ChatScope, messageId: string): Promise<ThreadView | null> {
  const [anchor] = await loadRecords(db, scope, [messageId]);
  if (!anchor) return null;
  if (!anchor.threadId) return { messages: [anchor], omitted: 0, tasks: anchor.tasks };
  const family = await threadFamily(db, anchor.threadId);
  const found = await db.execute(sql`
    select m.id, count(*) over() as total from messages m
    where m.thread_id in (${sqlList(family)}) and ${visibleSql(scope)}
    order by m.sort_ts desc, m.id desc
    limit ${THREAD_MAX_MESSAGES}`);
  const rows = found.rows as Array<{ id: string; total: number | string }>;
  const ids = rows.map((r) => r.id).reverse();
  const records = await loadRecords(db, scope, ids.includes(anchor.id) ? ids : [...ids, anchor.id]);
  records.sort((a, b) => a.date.getTime() - b.date.getTime());
  const all = uniqueTasks(records.flatMap((r) => r.tasks));
  return { messages: records, omitted: Math.max(0, Number(rows[0]?.total ?? records.length) - records.length), tasks: all };
}

// ── Tasks ───────────────────────────────────────────────────────────────────

export type TaskScopeFilter = "open" | "mine" | "waiting" | "closed" | "any";

export interface TaskQuery {
  allOf: string[];
  anyOf: string[];
  /** open: every open task; mine: open and the user's own move; waiting: the user waits for someone; closed; any. */
  status: TaskScopeFilter;
  limit: number;
}

export interface TaskRecord extends TaskRef {
  ownerKind: string;
  ownerName: string | null;
  ownerAddress: string | null;
  priority: string;
  counterpartyName: string | null;
  counterpartyAddress: string | null;
  company: string | null;
  dueDate: string | null;
  nextAction: string | null;
  summary: string | null;
  lastActivityAt: Date;
  createdAt: Date;
  closedAt: Date | null;
  snoozedUntil: string | null;
  originMessageId: string | null;
}

export interface TaskSearchResult {
  total: number;
  hits: TaskRecord[];
}

export const TASK_SEARCH_MAX = 20;

const TASK_COLUMNS = {
  id: tasks.id,
  ref: tasks.ref,
  title: tasks.title,
  status: tasks.status,
  ownerKind: tasks.ownerKind,
  ownerName: tasks.ownerName,
  ownerAddress: tasks.ownerAddress,
  priority: tasks.priority,
  counterpartyName: tasks.counterpartyName,
  counterpartyAddress: tasks.counterpartyAddress,
  company: tasks.company,
  dueDate: tasks.dueDate,
  nextAction: tasks.nextAction,
  summary: tasks.summary,
  lastActivityAt: tasks.lastActivityAt,
  createdAt: tasks.createdAt,
  closedAt: tasks.closedAt,
  snoozedUntil: tasks.snoozedUntil,
  originMessageId: tasks.originMessageId,
} as const;

/** A task word, folded the way tasks.search_text is written (src/engine/tasks.ts): no accents, punctuation as spaces. */
const taskWords = (raw: readonly string[] | null | undefined): string[] => (raw ?? []).map((r) => (typeof r === "string" ? foldForSearch(r) : r));

export async function searchTasks(db: DbOrTx, scope: ChatScope, q: TaskQuery): Promise<TaskSearchResult> {
  const allOf = cleanTerms(taskWords(q.allOf), TERM_LIMITS.allOf);
  const anyOf = cleanTerms(taskWords(q.anyOf), TERM_LIMITS.anyOf).filter((t) => !allOf.includes(t));
  const limit = Math.max(1, Math.min(TASK_SEARCH_MAX, Math.floor(q.limit) || 12));
  // tasks.search_text is folded when written (foldForSearch); the pattern also accepts the few letters that leaves.
  const hay = sql`${tasks.searchText}`;
  const parts: SQL[] = [ownTasks(scope), sql`${tasks.mergedIntoId} is null`];
  for (const t of allOf) parts.push(holds(hay, t));
  if (anyOf.length) parts.push(sql`(${sql.join(anyOf.map((t) => holds(hay, t)), sql` or `)})`);
  const open = sql`${tasks.status} in (${sqlList(OPEN_STATUSES)})`;
  if (q.status === "open") parts.push(open);
  if (q.status === "mine") parts.push(sql`${tasks.status} in ('ACTION_REQUIRED', 'WAITING_FOR_ME') and ${tasks.ownerKind} in ('ME', 'UNKNOWN')`);
  if (q.status === "waiting") parts.push(sql`${tasks.status} = 'WAITING_FOR_OTHER'`);
  if (q.status === "closed") parts.push(sql`${tasks.status} in ('COMPLETED', 'DISMISSED')`);
  const where = sql.join(parts, sql` and `);

  const [counted] = (await db.select({ n: sql<number>`count(*)` }).from(tasks).where(where)) as Array<{ n: number | string }>;
  const total = Number(counted?.n ?? 0);
  if (!total) return { total: 0, hits: [] };
  const rows = await db
    .select(TASK_COLUMNS)
    .from(tasks)
    .where(where)
    .orderBy(sql`(case when ${open} then 0 else 1 end)`, desc(tasks.lastActivityAt), desc(tasks.ref))
    .limit(limit);
  return { total, hits: rows as TaskRecord[] };
}

/** One task of the user by its number (#184); null when there is none. */
export async function taskByRef(db: DbOrTx, scope: ChatScope, ref: number): Promise<TaskRecord | null> {
  if (!Number.isInteger(ref) || ref <= 0) return null;
  const [row] = await db
    .select(TASK_COLUMNS)
    .from(tasks)
    .where(and(ownTasks(scope), eq(tasks.ref, ref), isNull(tasks.mergedIntoId)))
    .limit(1);
  return (row as TaskRecord | undefined) ?? null;
}

/** Tasks of the user by id (sources the browser sent back). */
export async function tasksByIds(db: DbOrTx, scope: ChatScope, ids: readonly string[]): Promise<TaskRecord[]> {
  const wanted = [...new Set(ids.filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase()))];
  if (!wanted.length) return [];
  const rows = await db
    .select(TASK_COLUMNS)
    .from(tasks)
    .where(and(ownTasks(scope), inArray(tasks.id, wanted)));
  return rows as TaskRecord[];
}

/** The messages a task was made from and updated by, oldest first (ids only; read them with {@link loadRecords}). */
export async function taskMessageIds(db: DbOrTx, scope: ChatScope, taskId: string, max = 6): Promise<string[]> {
  if (!scope.mailboxIds.length) return [];
  const rows = await db
    .select({ id: messages.id })
    .from(taskLinks)
    .innerJoin(messages, eq(messages.id, taskLinks.messageId))
    .innerJoin(tasks, eq(tasks.id, taskLinks.taskId))
    .where(and(eq(taskLinks.taskId, taskId), ownTasks(scope), inArray(messages.mailboxId, scope.mailboxIds)))
    .orderBy(desc(messages.sortTs))
    .limit(max);
  return [...new Set(rows.map((r) => r.id))].reverse();
}
