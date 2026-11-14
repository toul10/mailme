import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { cleanText } from "../digest/sanitize.js";
import { isInternalDomain } from "../engine/db-util.js";
import { R, reasonLabel } from "../engine/reconcile-reasons.js";
import type { Db } from "../db/client.js";
import { mailboxes, messages, organizations, taskEvents, taskLinks, tasks, users } from "../db/schema.js";
import { isImportant } from "../domain/preferences.js";
import { isOpenStatus, type Segment } from "../domain/types.js";
import { businessDaysBetween, calendarDaysBetween, greekHolidays, isBusinessDay, localDate } from "../lib/dates.js";
import { domainOf, foldForSearch, normalizeAddress, truncate } from "../lib/text.js";
import { DateTime } from "luxon";
import type {
  EvidenceView,
  PersonRef,
  TaskDetail,
  TaskEventView,
  TaskListItem,
  TaskListResponse,
  TaskMessageExcerpt,
  TaskTab,
} from "./api-types.js";
import { badRequest, escapeLike, UUID_RE } from "./http.js";
import { eventSummary } from "./labels.js";

/**
 * Read side of the task API. Every query is scoped to one user (`scope.userId`); callers never pass
 * another user's id. Derived values (overdue, days open, business days waiting) are computed at read time
 * in the organisation's timezone.
 */
export interface QueryScope {
  userId: string;
  timezone: string;
  holySpiritHoliday: boolean;
  now: Date;
}

export const TASK_TABS = ["todo", "waiting", "all", "others", "review", "closed", "earlier"] as const satisfies readonly TaskTab[];
export const CLOSED_TAB_DAYS = 30;
export const EXCERPT_CHARS = 500;
const MAX_Q = 200;

export interface ListParams {
  tab: TaskTab;
  company?: string | null;
  q?: string | null;
  /** Only tasks that need review or have pending suggestions (within the tab). */
  review?: boolean;
  limit: number;
  cursor?: string | null;
}

export const todayOf = (scope: QueryScope) => localDate(scope.now, scope.timezone);

// ── Conditions ───────────────────────────────────────────────────────────────

/** Backfill tasks idle this long go to the "Earlier" triage tab. */
const EARLIER_IDLE_DAYS = 7;

export const OPEN_SQL = sql`${tasks.status} in ('ACTION_REQUIRED','WAITING_FOR_ME','WAITING_FOR_OTHER')`;
/**
 * Explicitly qualified outer reference for correlated subqueries: drizzle renders columns in a select list
 * unqualified, and a bare "id" inside `from task_events e` would bind to e.id.
 */
const OUTER_TASK_ID = sql.raw(`"tasks"."id"`);
const PENDING_SUGGESTIONS = sql`exists (select 1 from task_events e where e.task_id = ${OUTER_TASK_ID} and e.suggestion_state = 'pending')`;

/**
 * A recently closed task whose closing mail bounced (engine/bounce.ts: needs_review + "bounce"): the AI closed it
 * because P1 sent the deliverable, but it never arrived. It stays in "Needs a look" until the user reopens or
 * confirms it (confirm clears the flag), like the review tab. Same 30-day window as the closed tab.
 */
export function closedBounceSql(now: Date): SQL {
  const since = new Date(now.getTime() - CLOSED_TAB_DAYS * 86_400_000);
  return sql`(${tasks.status} in ('COMPLETED','DISMISSED') and ${tasks.needsReview} and ${R.BOUNCE}::text = any(${tasks.reviewReasons}) and ${tasks.closedAt} >= ${since.toISOString()}::timestamptz)`;
}

/**
 * Snoozed = a future snooze date, or "until they reply" without a date (cleared when a reply arrives).
 * Never NULL (so `not snoozed` keeps unsnoozed rows).
 */
export function snoozedSql(today: string): SQL {
  return sql`coalesce((${tasks.snoozedUntil} > ${today}::date) or (${tasks.snoozeMode} = 'until_reply' and ${tasks.snoozedUntil} is null), false)`;
}

function tabSql(tab: TaskTab, scope: QueryScope): SQL {
  const today = todayOf(scope);
  switch (tab) {
    case "todo":
      return sql`(${tasks.status} in ('ACTION_REQUIRED','WAITING_FOR_ME') and ${tasks.ownerKind} in ('ME','UNKNOWN') and not ${snoozedSql(today)})`;
    case "waiting":
      return sql`(${tasks.status} = 'WAITING_FOR_OTHER' and not ${snoozedSql(today)})`;
    case "all":
      return sql`(${OPEN_SQL})`;
    case "others":
      // Dormant hand-overs (aging: idle colleagues' tasks) leave "Colleagues"; they stay under "all".
      return sql`(${tasks.ownerKind} = 'INTERNAL' and ${OPEN_SQL} and ${tasks.dormantAt} is null)`;
    case "review":
      return sql`((${OPEN_SQL} and ${tasks.needsReview}) or ${PENDING_SUGGESTIONS} or ${closedBounceSql(scope.now)})`;
    case "closed": {
      const since = new Date(scope.now.getTime() - CLOSED_TAB_DAYS * 86_400_000);
      return sql`(${tasks.status} in ('COMPLETED','DISMISSED') and ${tasks.closedAt} >= ${since.toISOString()}::timestamptz)`;
    }
    case "earlier":
      return earlierSql(scope.now);
  }
}

/**
 * "Earlier": backfill tasks still open with no activity for > 7 days that the user never acted on —
 * a one-time triage, kept out of the daily views. Shared by the "earlier" tab and /api/today.
 */
export function earlierSql(now: Date): SQL {
  const idleSince = new Date(now.getTime() - EARLIER_IDLE_DAYS * 86_400_000);
  return sql`(${OPEN_SQL} and ${tasks.origin} = 'backfill' and ${tasks.lastActivityAt} < ${idleSince.toISOString()}::timestamptz and not exists (select 1 from task_events ue where ue.task_id = ${OUTER_TASK_ID} and ue.actor = 'user'))`;
}

/** User scope + company + free-text search (shared by list and counts). */
function filterSql(scope: QueryScope, company: string | null | undefined, q: string | null | undefined): SQL {
  const parts: SQL[] = [sql`${tasks.userId} = ${scope.userId}`, sql`${tasks.mergedIntoId} is null`];
  if (company && company.trim()) parts.push(sql`${tasks.company} = ${company.trim()}`);
  const raw = (q ?? "").trim().slice(0, MAX_Q);
  const folded = foldForSearch(raw);
  if (folded) {
    const likeFolded = `%${escapeLike(folded)}%`;
    const likeRaw = `%${escapeLike(raw)}%`;
    parts.push(sql`(
      to_tsvector('simple', ${tasks.searchText}) @@ plainto_tsquery('simple', ${folded})
      or ${tasks.searchText} ilike ${likeFolded}
      or exists (
        select 1 from task_links tl
        join messages m on m.id = tl.message_id
        join mailboxes mb on mb.id = m.mailbox_id and mb.user_id = ${scope.userId}
        where tl.task_id = ${OUTER_TASK_ID} and (m.subject ilike ${likeRaw} or m.subject_norm ilike ${likeFolded})
      )
    )`);
  }
  return sql.join(parts, sql` and `);
}

// ── Keyset pagination ────────────────────────────────────────────────────────

type KeyType = "date" | "int" | "bigint" | "uuid";
interface SortKey {
  expr: SQL;
  dir: "asc" | "desc";
  type: KeyType;
}

/** Microsecond epoch: exact (JS Dates only keep milliseconds, Postgres keeps microseconds). */
const epochUs = (col: SQL) => sql`(floor(extract(epoch from ${col}) * 1000000))::bigint`;
const K_ACTIVITY: SortKey = { expr: epochUs(sql`${tasks.lastActivityAt}`), dir: "desc", type: "bigint" };
const K_ID: SortKey = { expr: sql`${tasks.id}`, dir: "asc", type: "uuid" };
const K_DUE: SortKey = { expr: sql`coalesce(${tasks.dueDate}, '9999-12-31'::date)`, dir: "asc", type: "date" };
const K_REPLY: SortKey = { expr: sql`coalesce(${tasks.expectReplyBy}, '9999-12-31'::date)`, dir: "asc", type: "date" };
const K_PRIORITY: SortKey = {
  expr: sql`(case ${tasks.priority} when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end)`,
  dir: "asc",
  type: "int",
};
const K_CLOSED: SortKey = { expr: epochUs(sql`coalesce(${tasks.closedAt}, ${tasks.updatedAt})`), dir: "desc", type: "bigint" };

/** Tab order: to-do by deadline then priority; waiting by follow-up date; closed by close time; else recent activity. */
function sortKeys(tab: TaskTab): SortKey[] {
  switch (tab) {
    case "todo":
      return [K_DUE, K_PRIORITY, K_ACTIVITY, K_ID];
    case "waiting":
      return [K_REPLY, K_ACTIVITY, K_ID];
    case "closed":
      return [K_CLOSED, K_ID];
    default:
      return [K_ACTIVITY, K_ID];
  }
}

const KEY_PATTERNS: Record<KeyType, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  int: /^-?\d{1,9}$/,
  bigint: /^-?\d{1,19}$/,
  uuid: UUID_RE,
};

function castValue(v: string, type: KeyType): SQL {
  switch (type) {
    case "date":
      return sql`${v}::date`;
    case "int":
      return sql`${v}::int`;
    case "bigint":
      return sql`${v}::bigint`;
    case "uuid":
      return sql`${v}::uuid`;
  }
}

export function encodeCursor(tab: TaskTab, values: string[]): string {
  return Buffer.from(JSON.stringify({ t: tab, v: values }), "utf8").toString("base64url");
}

/** Decode and validate a cursor for this tab; malformed → 400. */
export function decodeCursor(tab: TaskTab, cursor: string): string[] {
  const keys = sortKeys(tab);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badRequest("Invalid cursor");
  }
  const obj = parsed as { t?: unknown; v?: unknown };
  if (!obj || obj.t !== tab || !Array.isArray(obj.v) || obj.v.length !== keys.length) throw badRequest("Invalid cursor");
  const values = obj.v as unknown[];
  keys.forEach((k, i) => {
    const v = values[i];
    if (typeof v !== "string" || !KEY_PATTERNS[k.type].test(v)) throw badRequest("Invalid cursor");
  });
  return values as string[];
}

/** Rows strictly after the cursor in the tab's order (lexicographic over mixed directions). */
function afterSql(keys: SortKey[], values: string[]): SQL {
  const ors: SQL[] = keys.map((k, i) => {
    const parts: SQL[] = keys.slice(0, i).map((prev, j) => sql`${prev.expr} = ${castValue(values[j]!, prev.type)}`);
    parts.push(k.dir === "asc" ? sql`${k.expr} > ${castValue(values[i]!, k.type)}` : sql`${k.expr} < ${castValue(values[i]!, k.type)}`);
    return sql`(${sql.join(parts, sql` and `)})`;
  });
  return sql`(${sql.join(ors, sql` or `)})`;
}

// ── Derived values ───────────────────────────────────────────────────────────

function businessDays(fromIso: string, toIso: string, holySpirit: boolean): number {
  if (!holySpirit) return businessDaysBetween(fromIso, toIso);
  const cache = new Map<number, Set<string>>();
  const holidays = (y: number) => {
    let s = cache.get(y);
    if (!s) cache.set(y, (s = greekHolidays(y, { includeHolySpirit: true })));
    return s;
  };
  let d = DateTime.fromISO(fromIso, { zone: "UTC" });
  const end = DateTime.fromISO(toIso, { zone: "UTC" });
  let n = 0;
  while (d < end) {
    d = d.plus({ days: 1 });
    if (isBusinessDay(d.toISODate()!, holidays)) n++;
  }
  return n;
}

export type TaskRow = typeof tasks.$inferSelect;

export function toListItem(t: TaskRow, pendingSuggestions: number, scope: QueryScope): TaskListItem {
  const today = todayOf(scope);
  const open = isOpenStatus(t.status);
  const waiting = t.status === "WAITING_FOR_ME" || t.status === "WAITING_FOR_OTHER";
  const item: TaskListItem = {
    evidence: null,
    originEvidence: null,
    reviewCodes: [],
    ownerLabel: null,
    lastMessage: null,
    important: false,
    id: t.id,
    ref: t.ref,
    title: t.title,
    status: t.status,
    priority: t.priority,
    company: t.company,
    counterpartyName: t.counterpartyName,
    counterpartyAddress: t.counterpartyAddress,
    nextAction: t.nextAction,
    dueDate: t.dueDate,
    duePhrase: t.duePhrase,
    overdue: open && !!t.dueDate && t.dueDate < today,
    daysOpen: calendarDaysBetween(localDate(t.createdAt, scope.timezone), today),
    businessDaysWaiting: waiting ? businessDays(localDate(t.waitingSince ?? t.createdAt, scope.timezone), today, scope.holySpiritHoliday) : null,
    expectReplyBy: t.expectReplyBy,
    snoozedUntil: t.snoozedUntil,
    snoozeMode: t.snoozeMode,
    needsReview: t.needsReview,
    pendingSuggestions,
    ownerKind: t.ownerKind,
    origin: t.origin,
    lastActivityAt: t.lastActivityAt.toISOString(),
    version: t.version,
  };
  // tasks.review_reasons stores codes (engine/reconcile-reasons.ts R); the display labels are TaskDetail.reviewReasons.
  item.reviewCodes = [...new Set(t.reviewReasons)];
  if (t.ownerKind === "INTERNAL") item.ownerLabel = cleanText(t.ownerName, 120) || normalizeAddress(t.ownerAddress) || null;
  return item;
}

export const PENDING_COUNT = sql<number>`(select count(*)::int from task_events e where e.task_id = ${OUTER_TASK_ID} and e.suggestion_state = 'pending')`;

// ── People, evidence, last message ───────────────────────────────────────────
//
// "In their own words": every row shows the sentence behind the task, who wrote it and
// when. Messages are only ever read through the session user's own mailboxes: a message outside them (a bad link,
// another tenant) contributes nothing — no author, no time, no subject.

/** Evidence quotes are clipped to about this many characters, at a word boundary. */
export const EVIDENCE_QUOTE_CHARS = 220;

/**
 * An evidence quote ready to show: control/bidi characters stripped, whitespace collapsed, cut at the last word
 * boundary within `max` characters (a single overlong word is cut hard) and marked with an ellipsis (…).
 */
export function clipQuote(input: string | null | undefined, max = EVIDENCE_QUOTE_CHARS): string {
  const s = cleanText(input, Number.MAX_SAFE_INTEGER);
  if (s.length <= max) return s;
  const space = s.lastIndexOf(" ", max);
  const head = space >= Math.floor(max * 0.6) ? s.slice(0, space) : s.slice(0, max);
  return head.replace(/(?<![\s,;:·.\-–—])[\s,;:·.\-–—]+$/u, "") + "…";
}

/** Header of a FORWARDED / QUOTED segment (who wrote it, when): never its text. */
interface SegmentHead {
  id: string;
  author: string | null;
  date: string | null;
}

/** A message as seen by the session user: sender, time, subject and the owner/internal context of its mailbox. */
interface MessageMeta {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  fromName: string | null;
  fromAddress: string | null;
  claimsOwnerSender: boolean;
  sortTs: Date;
  subject: string;
  mailboxAddress: string;
  mailboxAliases: string[];
  internalDomains: string[];
  /** Headers of the FORWARDED/QUOTED segments (loaded for evidence attribution only; jsonb, maybe as text). */
  segmentHeads?: SegmentHead[] | string | null;
}

const MESSAGE_META = {
  id: messages.id,
  direction: messages.direction,
  fromName: messages.fromName,
  fromAddress: messages.fromAddress,
  claimsOwnerSender: messages.claimsOwnerSender,
  sortTs: messages.sortTs,
  subject: messages.subject,
  mailboxAddress: mailboxes.address,
  mailboxAliases: mailboxes.aliases,
  internalDomains: organizations.internalDomains,
};

const MESSAGE_SEGMENTS = sql.raw(`"messages"."segments"`);

/** id/author/date of every FORWARDED and QUOTED segment of the outer `messages` row, as jsonb (the text never leaves SQL). */
const SEGMENT_HEADS = sql<SegmentHead[] | string | null>`(
  select jsonb_agg(jsonb_build_object('id', seg->>'id', 'author', seg->>'author', 'date', seg->>'date'))
  from jsonb_array_elements(case when jsonb_typeof(${MESSAGE_SEGMENTS}) = 'array' then ${MESSAGE_SEGMENTS} else '[]'::jsonb end) seg
  where seg->>'kind' in ('FORWARDED','QUOTED')
)`;

/** The session user's mailboxes only (inner join: anything else is invisible). */
const ownMailbox = (userId: string) => and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.userId, userId));

const ownerAddresses = (m: Pick<MessageMeta, "mailboxAddress" | "mailboxAliases">) => new Set([m.mailboxAddress, ...m.mailboxAliases].map((a) => a.toLowerCase()));

/**
 * Who wrote a message. "You" (isOwner) only for the owner's own sent mail. A delivered copy that merely claims
 * "From: you" (claims_owner_sender — DMARC p=none) is shown as the address it claims, and as neither
 * the owner nor a colleague: the internal domain is exactly what a spoof borrows, so it earns no colleague trust.
 * Internal = the owner, or a sender in one of the organisation's domains (subdomains included).
 */
export function personOf(m: Pick<MessageMeta, "direction" | "fromName" | "fromAddress" | "claimsOwnerSender" | "mailboxAddress" | "mailboxAliases" | "internalDomains">): PersonRef {
  const address = normalizeAddress(m.fromAddress);
  const name = cleanText(m.fromName, 120) || null;
  if (m.direction === "INBOUND" && m.claimsOwnerSender) return { name, address, isOwner: false, isInternal: false };
  const isOwner = m.direction === "OUTBOUND" || (address !== null && ownerAddresses(m).has(address));
  return { name, address, isOwner, isInternal: isOwner || isInternalDomain(domainOf(address), m.internalDomains) };
}

/** `Name <addr>`, `"Name" <addr>`, `addr` or `Name` (a segment header's author) → name and address. */
export function parseAuthor(author: string | null | undefined): { name: string | null; address: string | null } | null {
  const s = cleanText(author, 200);
  if (!s) return null;
  const unquote = (v: string) => v.replace(/^["'\s]+|(?<!["'\s])["'\s]+$/g, "") || null;
  const angle = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/u.exec(s);
  if (angle) return { name: unquote(angle[1]!), address: normalizeAddress(angle[2]) };
  if (/^[^\s@<>]+@[^\s@<>]+$/u.test(s)) return { name: null, address: normalizeAddress(s) };
  return { name: unquote(s), address: null };
}

/** The author written in a forwarded/quoted header block, judged against the same mailbox context as the message. */
function segmentPerson(author: string | null, m: MessageMeta): PersonRef | null {
  const p = parseAuthor(author);
  if (!p || (!p.name && !p.address)) return null;
  const isOwner = p.address !== null && ownerAddresses(m).has(p.address);
  return { name: p.name ? cleanText(p.name, 120) || null : null, address: p.address, isOwner, isInternal: isOwner || isInternalDomain(domainOf(p.address), m.internalDomains) };
}

const isoOrNull = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function segmentHeadsOf(m: MessageMeta): SegmentHead[] {
  let raw: unknown = m.segmentHeads;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  return Array.isArray(raw) ? (raw as SegmentHead[]) : [];
}

/**
 * Who wrote the evidence sentence and when. NEW text (and the subject, attachment names, calendar) is the message's
 * own; a FORWARDED or QUOTED sentence belongs to the author of its header block ("Maria Papadaki, Mon 21 Sep"), never
 * to whoever forwarded or quoted it. Without a parseable author the attribution stays empty (the UI still says "from a
 * forwarded message").
 */
function attribution(m: MessageMeta, source: string | null, segmentId: string | null): { author: PersonRef | null; at: string | null } {
  if (source !== "FORWARDED" && source !== "QUOTED") return { author: personOf(m), at: m.sortTs.toISOString() };
  const head = segmentId ? segmentHeadsOf(m).find((s) => s.id === segmentId) : undefined;
  const author = head ? segmentPerson(head.author, m) : null;
  return { author, at: author ? isoOrNull(head?.date) : null };
}

/** Visible messages by id (one query); `withSegments` adds the forwarded/quoted segment headers. */
async function loadMessageMeta(db: Db, userId: string, ids: Iterable<string | null>, withSegments = false): Promise<Map<string, MessageMeta>> {
  const unique = [...new Set([...ids].filter((id): id is string => !!id))];
  if (!unique.length) return new Map();
  const rows: MessageMeta[] = withSegments
    ? await db
        .select({ ...MESSAGE_META, segmentHeads: SEGMENT_HEADS })
        .from(messages)
        .innerJoin(mailboxes, ownMailbox(userId))
        .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
        .where(inArray(messages.id, unique))
    : await db
        .select(MESSAGE_META)
        .from(messages)
        .innerJoin(mailboxes, ownMailbox(userId))
        .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
        .where(inArray(messages.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

interface EvidenceRow {
  eventId: string;
  taskId: string | null;
  quote: string | null;
  source: string | null;
  messageId: string | null;
  segmentId: string | null;
}

const EVIDENCE_COLS = {
  eventId: taskEvents.id,
  taskId: taskEvents.taskId,
  quote: taskEvents.evidenceQuote,
  source: taskEvents.evidenceSource,
  messageId: taskEvents.messageId,
  segmentId: sql<string | null>`${taskEvents.features} ->> 'segmentId'`,
};

function toEvidence(r: EvidenceRow, meta: ReadonlyMap<string, MessageMeta>): EvidenceView | null {
  const quote = clipQuote(r.quote);
  if (!quote) return null;
  const m = r.messageId ? meta.get(r.messageId) : undefined;
  return { quote, source: r.source, messageId: m?.id ?? null, ...(m ? attribution(m, r.source, r.segmentId) : { author: null, at: null }) };
}

/**
 * An AI event that put the task in its current status: applied with that status in `after` (a CREATE's snapshot, an
 * UPDATE, a REOPEN), or an accepted suggestion proposing it (an UPDATE's fields, a "new task?" task).
 */
const SET_CURRENT_STATUS = sql`(
  (${taskEvents.applied} and ${taskEvents.after} ->> 'status' = ${tasks.status})
  or (${taskEvents.suggestionState} = 'accepted' and (
    ${taskEvents.payload} -> 'proposed' -> 'fields' ->> 'status' = ${tasks.status}
    or ${taskEvents.payload} -> 'proposed' -> 'task' ->> 'status' = ${tasks.status}))
)`;

interface TaskEvidence {
  evidence: EvidenceView | null;
  originEvidence: EvidenceView | null;
}

/**
 * Evidence per task (batched queries, whatever the number of tasks):
 * - origin: the earliest AI CREATE (applied, or an accepted "new task?" suggestion);
 * - state, for WAITING_FOR_ME / WAITING_FOR_OTHER: the latest applied-or-accepted AI event with a quote that set the
 *   current status — P1's promise ("I'll send you the quote on Thursday"), the question P1 asked.
 * `evidence` is the state sentence, else the origin; `originEvidence` is the origin only when it is a different
 * sentence (the customer's request behind the promise).
 */
async function loadEvidence(db: Db, userId: string, taskIds: string[]): Promise<Map<string, TaskEvidence>> {
  const out = new Map<string, TaskEvidence>();
  if (!taskIds.length) return out;
  const origins: EvidenceRow[] = await db
    .selectDistinctOn([taskEvents.taskId], EVIDENCE_COLS)
    .from(taskEvents)
    .where(and(inArray(taskEvents.taskId, taskIds), eq(taskEvents.actor, "ai"), eq(taskEvents.op, "CREATE")))
    .orderBy(taskEvents.taskId, asc(taskEvents.createdAt), sql`${taskEvents.opIndex} asc nulls last`, asc(taskEvents.id));
  const states: EvidenceRow[] = await db
    .selectDistinctOn([taskEvents.taskId], EVIDENCE_COLS)
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(
      and(
        inArray(taskEvents.taskId, taskIds),
        inArray(tasks.status, ["WAITING_FOR_ME", "WAITING_FOR_OTHER"]),
        eq(taskEvents.actor, "ai"),
        isNotNull(taskEvents.evidenceQuote),
        sql`btrim(${taskEvents.evidenceQuote}) <> ''`,
        SET_CURRENT_STATUS,
      ),
    )
    .orderBy(taskEvents.taskId, desc(taskEvents.createdAt), sql`${taskEvents.opIndex} desc nulls last`, desc(taskEvents.id));
  const meta = await loadMessageMeta(db, userId, [...origins, ...states].map((r) => r.messageId), true);
  const originOf = new Map(origins.map((r) => [r.taskId, r]));
  const stateOf = new Map(states.map((r) => [r.taskId, r]));
  for (const id of taskIds) {
    const o = originOf.get(id);
    const s = stateOf.get(id);
    const origin = o ? toEvidence(o, meta) : null;
    const state = s ? toEvidence(s, meta) : null;
    const evidence = state ?? origin;
    if (!evidence) continue;
    const differs = !!state && !!origin && s!.eventId !== o!.eventId && !(state.quote === origin.quote && state.messageId === origin.messageId);
    out.set(id, { evidence, originEvidence: differs ? origin : null });
  }
  return out;
}

type LastMessage = NonNullable<TaskListItem["lastMessage"]>;

/**
 * A message a person wrote: not the platform's own mail, and not filtered as automated or not really sent (bounces,
 * out-of-office, calendar replies, bulk, no-reply, drafts, junk). Old, empty or encrypted mail still counts.
 */
const HUMAN_MESSAGE = sql`(${messages.state} <> 'own_mail' and (${messages.filterReason} is null or ${messages.filterReason} in ('TOO_OLD','EMPTY','ENCRYPTED')))`;

/**
 * Who wrote last: the latest human message (by sort_ts) of the task's conversation — every message of the threads
 * the task is linked to, plus the linked messages themselves — from the user's own mailboxes. A reply that changed
 * nothing on the task (so has no link of its own) still counts.
 */
async function loadLastMessages(db: Db, userId: string, taskIds: string[]): Promise<Map<string, LastMessage>> {
  const out = new Map<string, LastMessage>();
  if (!taskIds.length) return out;
  const rows = await db
    .selectDistinctOn([taskLinks.taskId], { taskId: taskLinks.taskId, ...MESSAGE_META })
    .from(taskLinks)
    .innerJoin(messages, or(eq(messages.id, taskLinks.messageId), and(isNotNull(taskLinks.threadId), eq(messages.threadId, taskLinks.threadId))))
    .innerJoin(mailboxes, ownMailbox(userId))
    .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
    .where(and(inArray(taskLinks.taskId, taskIds), HUMAN_MESSAGE))
    .orderBy(taskLinks.taskId, desc(messages.sortTs), desc(messages.id));
  for (const r of rows) {
    out.set(r.taskId, { author: personOf(r), at: r.sortTs.toISOString(), subject: cleanText(r.subject, 300), direction: r.direction });
  }
  return out;
}

/** Fill `evidence`, `originEvidence` and `lastMessage` of list items in place (batched lookups, whatever the number of items). */
export async function withContext<T extends TaskListItem>(db: Db, userId: string, items: T[]): Promise<T[]> {
  const ids = [...new Set(items.map((i) => i.id))];
  const evidence = await loadEvidence(db, userId, ids);
  const last = await loadLastMessages(db, userId, ids);
  const [prefs] = items.length ? await db.select({ important: users.importantSenders }).from(users).where(eq(users.id, userId)) : [];
  const important = prefs?.important ?? [];
  for (const item of items) {
    const e = evidence.get(item.id);
    item.evidence = e?.evidence ?? null;
    item.originEvidence = e?.originEvidence ?? null;
    item.lastMessage = last.get(item.id) ?? null;
    item.important = isImportant(item, important);
  }
  return items;
}

// ── List & counts ────────────────────────────────────────────────────────────

export async function countTabs(db: Db, scope: QueryScope, company?: string | null, q?: string | null): Promise<Record<TaskTab, number>> {
  const where = filterSql(scope, company, q);
  const [row] = await db
    .select({
      todo: sql<number>`count(*) filter (where ${tabSql("todo", scope)})::int`,
      waiting: sql<number>`count(*) filter (where ${tabSql("waiting", scope)})::int`,
      all: sql<number>`count(*) filter (where ${tabSql("all", scope)})::int`,
      others: sql<number>`count(*) filter (where ${tabSql("others", scope)})::int`,
      review: sql<number>`count(*) filter (where ${tabSql("review", scope)})::int`,
      closed: sql<number>`count(*) filter (where ${tabSql("closed", scope)})::int`,
      earlier: sql<number>`count(*) filter (where ${tabSql("earlier", scope)})::int`,
    })
    .from(tasks)
    .where(where);
  const counts: Record<TaskTab, number> = {
    todo: Number(row?.todo ?? 0),
    waiting: Number(row?.waiting ?? 0),
    all: Number(row?.all ?? 0),
    others: Number(row?.others ?? 0),
    review: Number(row?.review ?? 0),
    closed: Number(row?.closed ?? 0),
    earlier: Number(row?.earlier ?? 0),
  };
  return counts;
}

export async function listTasks(db: Db, scope: QueryScope, p: ListParams): Promise<TaskListResponse> {
  const keys = sortKeys(p.tab);
  const conds: SQL[] = [filterSql(scope, p.company, p.q), tabSql(p.tab, scope)];
  if (p.review) conds.push(sql`(${tasks.needsReview} or ${PENDING_SUGGESTIONS})`);
  if (p.cursor) conds.push(afterSql(keys, decodeCursor(p.tab, p.cursor)));
  const keyCols = Object.fromEntries(keys.map((k, i) => [`k${i}`, sql<string>`(${k.expr})::text`])) as Record<string, SQL.Aliased<string> | SQL<string>>;

  const rows = await db
    .select({ task: tasks, pending: PENDING_COUNT, ...keyCols })
    .from(tasks)
    .where(sql.join(conds, sql` and `))
    .orderBy(...keys.map((k) => (k.dir === "asc" ? sql`${k.expr} asc` : sql`${k.expr} desc`)))
    .limit(p.limit + 1);

  const page = rows.slice(0, p.limit);
  const last = page[page.length - 1] as (Record<string, unknown> & (typeof rows)[number]) | undefined;
  const nextCursor = rows.length > p.limit && last ? encodeCursor(p.tab, keys.map((_, i) => String(last[`k${i}`]))) : null;
  return {
    items: await withContext(db, scope.userId, page.map((r) => toListItem(r.task, Number(r.pending), scope))),
    counts: await countTabs(db, scope, p.company, p.q),
    nextCursor,
  };
}

// ── Detail ───────────────────────────────────────────────────────────────────

/** The task id if it exists and belongs to the user, else null. */
export async function ownedTaskId(db: Db, userId: string, taskId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)))
    .limit(1);
  return row?.id ?? null;
}

/** Task id of a suggestion event owned by the user, else null. */
export async function ownedEventTaskId(db: Db, userId: string, eventId: string): Promise<string | null> {
  const [row] = await db
    .select({ taskId: tasks.id })
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(and(eq(taskEvents.id, eventId), eq(tasks.userId, userId)))
    .limit(1);
  return row?.taskId ?? null;
}

const ROLE_PRIORITY = ["origin", "completion", "reopen", "update", "manual", "reference"];

function newExcerpt(segments: Segment[] | null | undefined): string {
  const text = (segments ?? [])
    .filter((s) => s.kind === "NEW")
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
  return truncate(text, EXCERPT_CHARS).text;
}

export type EventRow = typeof taskEvents.$inferSelect;

/**
 * An event for the UI. AI events carry the message they were read from and the author of their evidence sentence
 * ("Nikos Pappas wrote…"; a forwarded or quoted sentence is its header block's author, see {@link attribution}),
 * when that message is in the user's own mailboxes; user/system events carry none.
 */
function toEventView(e: EventRow, meta: ReadonlyMap<string, MessageMeta>): TaskEventView {
  const m = e.actor === "ai" && e.messageId ? meta.get(e.messageId) : undefined;
  const segmentId = typeof e.features?.segmentId === "string" ? e.features.segmentId : null;
  const who = m ? attribution(m, e.evidenceSource, segmentId) : { author: null, at: null };
  const view: TaskEventView = {
    messageId: m?.id ?? null,
    author: who.author,
    messageAt: who.at,
    id: e.id,
    actor: e.actor,
    op: e.op,
    createdAt: e.createdAt.toISOString(),
    applied: e.applied,
    tier: e.tier,
    suggestionState: e.suggestionState,
    evidenceSource: e.evidenceSource,
    evidenceQuote: e.evidenceQuote,
    reasons: e.reasons.map(reasonLabel),
    summary: eventSummary(e),
  };
  return view;
}

/** Event views with their messages' authors (one batched lookup). */
export async function eventViews(db: Db, userId: string, rows: EventRow[]): Promise<TaskEventView[]> {
  const meta = await loadMessageMeta(db, userId, rows.filter((e) => e.actor === "ai").map((e) => e.messageId), true);
  return rows.map((e) => toEventView(e, meta));
}

export async function getTaskDetail(db: Db, scope: QueryScope, taskId: string): Promise<TaskDetail | null> {
  const [row] = await db
    .select({ task: tasks, pending: PENDING_COUNT })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.userId, scope.userId)))
    .limit(1);
  if (!row) return null;
  const t = row.task;

  // Linked messages, restricted to the user's own mailboxes (defence in depth against a bad link).
  const linkRows = await db
    .select({
      role: taskLinks.role,
      linkedAt: taskLinks.createdAt,
      id: messages.id,
      direction: messages.direction,
      dateHeader: messages.dateHeader,
      sortTs: messages.sortTs,
      fromName: messages.fromName,
      fromAddress: messages.fromAddress,
      subject: messages.subject,
      segments: messages.segments,
      attachments: messages.attachments,
    })
    .from(taskLinks)
    .innerJoin(messages, eq(messages.id, taskLinks.messageId))
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(eq(taskLinks.taskId, t.id), eq(mailboxes.userId, scope.userId)))
    .orderBy(asc(messages.sortTs), asc(messages.id));

  const byMessage = new Map<string, TaskMessageExcerpt>();
  for (const m of linkRows) {
    const existing = byMessage.get(m.id);
    if (existing) {
      if (ROLE_PRIORITY.indexOf(m.role) < ROLE_PRIORITY.indexOf(existing.role)) existing.role = m.role;
      continue;
    }
    byMessage.set(m.id, {
      messageId: m.id,
      role: m.role,
      direction: m.direction,
      date: (m.dateHeader ?? m.sortTs).toISOString(),
      fromName: m.fromName,
      fromAddress: m.fromAddress,
      subject: m.subject,
      excerpt: newExcerpt(m.segments),
      attachments: (m.attachments ?? []).filter((a) => !a.inline).map((a) => a.filename),
    });
  }

  const eventRows = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, t.id))
    .orderBy(asc(taskEvents.createdAt), asc(taskEvents.id));
  const events = await eventViews(db, scope.userId, eventRows);
  const [item] = await withContext(db, scope.userId, [toListItem(t, Number(row.pending), scope)]);

  const detail: TaskDetail = {
    ...item!,
    summary: t.summary,
    items: t.items,
    ownerName: t.ownerName,
    ownerAddress: t.ownerAddress,
    reviewReasons: t.reviewReasons.map(reasonLabel),
    lockedFields: t.lockedFields,
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    closedBy: t.closedBy,
    createdAt: t.createdAt.toISOString(),
    messages: [...byMessage.values()],
    events,
    suggestions: events.filter((e) => e.suggestionState === "pending"),
  };
  return detail;
}

// ── Companies ────────────────────────────────────────────────────────────────

export async function listCompanies(db: Db, userId: string): Promise<Array<{ name: string; open: number }>> {
  const rows = await db
    .select({ name: tasks.company, open: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), isNull(tasks.mergedIntoId), OPEN_SQL, sql`${tasks.company} is not null and ${tasks.company} <> ''`))
    .groupBy(tasks.company)
    .orderBy(asc(tasks.company));
  return rows.map((r) => ({ name: r.name ?? "", open: Number(r.open) }));
}
