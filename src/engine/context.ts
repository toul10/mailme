import { and, asc, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { mailboxes, messages, organizations, taskEvents, taskLinks, tasks, threads, users } from "../db/schema.js";
import {
  OPEN_STATUSES,
  PARTICIPANT_HANDLES,
  TASK_HANDLES,
  isOpenStatus,
  type ExtractionInput,
  type HandleMap,
  type ParticipantHandle,
  type ParticipantRef,
  type TaskCard,
  type TaskCardScope,
  type ThreadDigestEntry,
} from "../domain/types.js";
import { normalizeRules } from "../domain/rules.js";
import { describeInstant } from "../lib/dates.js";
import { hasReplyOrForwardPrefix } from "../mail/subject.js";
import { domainOf, foldForMatch, normalizeAddress, tokens, truncate } from "../lib/text.js";
import { companyDomainOf, isInternalDomain, loadCompanyMap, lookupCompany, sqlList, threadFamily } from "./db-util.js";
import type { TaskRow } from "./tasks.js";

export const CONTEXT_LIMITS = {
  maxCards: TASK_HANDLES.length,
  /** Recently closed thread tasks leave room for related open ones. */
  maxThreadClosedCards: 5,
  closedWindowDays: 30,
  digestMessages: 3,
  digestChars: 600,
  maxParticipants: PARTICIPANT_HANDLES.length,
  maxQueryTokens: 30,
  cardTextChars: 200,
} as const;

/** Message states whose content was eligible for the AI (filtered / skipped / own mail never is). */
const AI_ELIGIBLE_STATES = ["pending", "extracted", "applied", "failed"] as const;
const PRIVATE_CLASSES = ["PERSONAL", "SPAM"];

/** Frequent words that carry no topic signal in the related-task query. */
const STOPWORDS = new Set(
  "και για την στην στο στον στα απο από που του της των τον τις τα με σε να θα οτι ότι μας σας σου μου ειναι είναι εχω έχω καλημερα καλησπερα ευχαριστω ευχαριστώ φιλικα φιλικά παρακαλω παρακαλώ the and for you your with this that from are was have has will please thanks thank regards dear hello kind best re fw fwd".split(" ").map(foldForMatch),
);

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** The message or its mailbox is missing. */
export class ContextError extends Error {}

/**
 * Build the extractor input for one message: participants → P-handles (P1 = owner), task cards → K-handles
 * (thread open, thread recently closed ≤30d, related open by address/company domain via FTS, ≤12 total),
 * thread digest (last 3, NEW only), segment anchors in the org zone. Scoped to the message's mailbox.
 */
export async function buildExtractionContext(db: DbOrTx, messageId: string): Promise<{ input: ExtractionInput; handleMap: HandleMap }> {
  const [msg] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!msg) throw new ContextError("message not found");
  const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.id, msg.mailboxId));
  if (!mb) throw new ContextError("mailbox not found");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, mb.orgId));
  const [user] = await db.select({ name: users.name, profileNote: users.profileNote, mailRules: users.mailRules }).from(users).where(eq(users.id, mb.userId));
  const zone = org?.timezone || "Europe/Athens";
  const internalDomains = (org?.internalDomains ?? []).map((d) => d.toLowerCase());
  const companyMap = await loadCompanyMap(db, mb.orgId);
  const family = await threadFamily(db, msg.threadId);
  const [thread] = msg.threadId ? await db.select({ linkConfidence: threads.linkConfidence }).from(threads).where(eq(threads.id, msg.threadId)) : [];

  // ── Participants (P1 = owner) ──────────────────────────────────────────────
  const ownerAddrs = [mb.address, ...mb.aliases].map(normalizeAddress).filter((a): a is string => !!a);
  const parts = new Participants({ address: mb.address.toLowerCase(), name: user?.name ?? mb.displayName ?? null }, ownerAddrs, internalDomains, companyMap);
  const fromHandle = parts.add(msg.fromAddress, msg.fromName, "from") ?? "OTHER";
  const toHandles = uniqHandles(msg.to.map((a) => parts.add(a.address, a.name, "to") ?? "OTHER"));
  const ccHandles = uniqHandles(msg.cc.map((a) => parts.add(a.address, a.name, "cc") ?? "OTHER"));
  for (const seg of msg.segments) {
    if (seg.kind === "NEW" || !seg.author) continue;
    const author = parseAuthor(seg.author);
    if (author.address) parts.add(author.address, author.name, "quoted");
    else if (author.name) parts.addRoleByName(author.name, "quoted");
  }

  // ── Task cards ─────────────────────────────────────────────────────────────
  const scoped = and(eq(tasks.userId, mb.userId), isNull(tasks.mergedIntoId));
  const linked = family.length ? await db.selectDistinct({ taskId: taskLinks.taskId }).from(taskLinks).where(inArray(taskLinks.threadId, family)) : [];
  const threadTasks = linked.length ? await db.select().from(tasks).where(and(scoped, inArray(tasks.id, linked.map((l) => l.taskId)))) : [];
  const closedSince = msg.sortTs.getTime() - CONTEXT_LIMITS.closedWindowDays * 86_400_000;
  const threadOpen = threadTasks
    .filter((t) => isOpenStatus(t.status))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || a.ref - b.ref)
    .slice(0, CONTEXT_LIMITS.maxCards);
  const threadClosed = threadTasks
    .filter((t) => !isOpenStatus(t.status) && t.closedAt && t.closedAt.getTime() >= closedSince)
    .sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime())
    .slice(0, Math.min(CONTEXT_LIMITS.maxThreadClosedCards, CONTEXT_LIMITS.maxCards - threadOpen.length));

  const related = await relatedOpenTasks(db, {
    userId: mb.userId,
    mailboxId: mb.id,
    exclude: threadTasks.map((t) => t.id),
    addresses: parts.messageAddresses(),
    domains: parts.messageAddresses().map((a) => companyDomainOf(a, internalDomains)).filter((d): d is string => !!d),
    queryTokens: queryTokens(msg.subjectNorm || msg.subject, msg.segments.filter((s) => s.kind === "NEW").map((s) => s.text).join("\n")),
    limit: CONTEXT_LIMITS.maxCards - threadOpen.length - threadClosed.length,
  });

  const chosen: Array<{ task: TaskRow; scope: TaskCardScope }> = [
    ...threadOpen.map((task) => ({ task, scope: "THREAD_OPEN" as const })),
    ...threadClosed.map((task) => ({ task, scope: "THREAD_CLOSED" as const })),
    ...related.map((task) => ({ task, scope: "RELATED_OPEN" as const })),
  ];

  // Counterparties (then non-owner task owners) of the offered tasks become participants when there is room.
  for (const { task } of chosen) parts.add(task.counterpartyAddress, task.counterpartyName, "task");
  for (const { task } of chosen) if (task.ownerKind !== "ME") parts.add(task.ownerAddress, task.ownerName, "task");

  const cardInfo = await cardEventInfo(db, chosen.map((c) => c.task));
  const handleMap: HandleMap = { tasks: {}, participants: {} };
  const taskCards: TaskCard[] = chosen.map(({ task, scope }, i) => {
    const handle = TASK_HANDLES[i]!;
    handleMap.tasks[handle] = task.id;
    const info = cardInfo.get(task.id);
    return {
      handle,
      scope,
      title: task.title,
      status: task.status,
      ownerHandle: task.ownerKind === "ME" ? "P1" : (parts.handleOf(task.ownerAddress) ?? "UNKNOWN"),
      counterpartyHandle: parts.handleOf(task.counterpartyAddress),
      company: task.company,
      dueDate: task.dueDate,
      duePhrase: task.duePhrase,
      items: task.items,
      originEvidence: info?.originEvidence ?? null,
      originDate: describeInstant(info?.originAt ?? task.createdAt, zone),
      lastEvent: info?.lastEvent ?? null,
      lastEventDate: info?.lastEventAt ? describeInstant(info.lastEventAt, zone) : null,
      closedBy: task.closedBy,
    };
  });
  for (const p of parts.all()) handleMap.participants[p.handle] = { address: p.address, name: p.name, isOwner: p.isOwner, isInternal: p.isInternal };

  // ── Thread digest (prior AI-eligible messages, NEW text only) ─────────────
  // "Prior" = earlier sort_ts, plus the message's own reply-chain ancestors whatever their sort_ts (a Sent copy with a
  // skewed Date is still the parent: reply-chain order wins inside a thread).
  const ancestors = [...new Set([msg.inReplyTo, ...msg.references].filter((x): x is string => !!x))];
  const prior = family.length
    ? await db
        .select({ id: messages.id, sortTs: messages.sortTs, direction: messages.direction, fromAddress: messages.fromAddress, subject: messages.subject, segments: messages.segments })
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, msg.mailboxId),
            inArray(messages.threadId, family),
            ne(messages.id, msg.id),
            inArray(messages.state, [...AI_ELIGIBLE_STATES]),
            or(isNull(messages.classification), notInArray(messages.classification, PRIVATE_CLASSES)),
            or(
              lt(messages.sortTs, msg.sortTs),
              and(eq(messages.sortTs, msg.sortTs), lt(messages.id, msg.id)),
              ancestors.length ? inArray(messages.messageIdHeader, ancestors) : undefined,
            ),
          ),
        )
        .orderBy(desc(messages.sortTs), desc(messages.id))
        .limit(CONTEXT_LIMITS.digestMessages)
    : [];
  const threadDigest: ThreadDigestEntry[] = prior.reverse().map((m) => ({
    date: describeInstant(m.sortTs, zone),
    direction: m.direction,
    fromHandle: parts.handleOf(m.fromAddress) ?? "OTHER",
    subject: m.subject,
    newText: truncate(
      m.segments
        .filter((s) => s.kind === "NEW")
        .map((s) => s.text)
        .join("\n")
        .trim(),
      CONTEXT_LIMITS.digestChars,
    ).text,
  }));

  const sentAnchor = describeInstant(msg.sortTs, zone);
  const input: ExtractionInput = {
    owner: { name: user?.name ?? mb.displayName ?? null, address: mb.address, aliases: mb.aliases, internalDomains, notes: user?.profileNote ?? null },
    zone,
    message: {
      direction: msg.direction,
      sentAnchor,
      subject: msg.subject,
      fromHandle,
      toHandles,
      ccHandles,
      attachments: msg.attachments.filter((a) => !a.inline).map((a) => ({ filename: a.filename, contentType: a.contentType })),
      segments: msg.segments.map((s) => ({ ...s, anchor: s.kind === "NEW" ? sentAnchor : segmentAnchor(s.date, zone) })),
      calendar: msg.calendar ?? null,
      late: msg.late,
    },
    participants: parts.all(),
    taskCards,
    threadDigest,
    lowLinkConfidence: thread?.linkConfidence === "LOW",
  };
  const rules = normalizeRules(user?.mailRules).rules.filter((r) => r.enabled);
  if (rules.length) {
    const from = normalizeAddress(msg.fromAddress);
    const fromDomain = domainOf(from);
    const external = msg.direction === "INBOUND" && !msg.claimsOwnerSender && !!from && !ownerAddrs.includes(from) && !isInternalDomain(fromDomain, internalDomains);
    input.rules = {
      list: rules,
      from,
      recipients: [...msg.to, ...msg.cc].map((a) => normalizeAddress(a.address)).filter((a): a is string => !!a),
      external,
      reply: hasReplyOrForwardPrefix(msg.subject) || !!msg.inReplyTo,
      senderKnown: external && fromDomain ? await domainKnown(db, msg, fromDomain, internalDomains, ownerAddrs) : false,
    };
  }
  return { input, handleMap };
}

function segmentAnchor(iso: string | null, zone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : describeInstant(d, zone);
}

function uniqHandles(hs: Array<ParticipantHandle | "OTHER">): Array<ParticipantHandle | "OTHER"> {
  return [...new Set(hs)];
}

/** "Giannis P. <giannis@abc-gr.example>" → address + name; name-only authors keep just the name. */
export function parseAuthor(raw: string): { address: string | null; name: string | null } {
  const m = raw.match(EMAIL_RE);
  const address = m ? normalizeAddress(m[0]) : null;
  const name = raw
    .replace(/<[^>]*>/g, " ")
    .replace(EMAIL_RE, " ")
    .replace(/["'[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { address, name: name || null };
}

/** Subject tokens first, then NEW-text tokens; folded, deduped, stopwords and short tokens dropped. */
export function queryTokens(subject: string, newText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...tokens(subject), ...tokens(newText)]) {
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= CONTEXT_LIMITS.maxQueryTokens) break;
  }
  return out;
}

/**
 * Open tasks of the same user/mailbox that share a counterparty address or a (non-public, non-internal)
 * company domain with the message, ranked by full-text relevance (OR of plainto_tsquery per token) then recency.
 */
async function relatedOpenTasks(
  db: DbOrTx,
  q: { userId: string; mailboxId: string; exclude: string[]; addresses: string[]; domains: string[]; queryTokens: string[]; limit: number },
): Promise<TaskRow[]> {
  if (q.limit <= 0 || (q.addresses.length === 0 && q.domains.length === 0)) return [];
  const match = [];
  if (q.addresses.length) match.push(sql`lower(${tasks.counterpartyAddress}) in (${sqlList(q.addresses)})`);
  if (q.domains.length) match.push(inArray(tasks.companyDomain, [...new Set(q.domains)]));
  // No usable tokens (an empty subject and no new text): recency only. A constant `0` in ORDER BY is read as a column
  // position and fails (42P10): on 2026-10-02 one subject-less message paused AI for every mailbox for a day.
  const rank = q.queryTokens.length
    ? sql`ts_rank(to_tsvector('simple', ${tasks.searchText}), ${sql.join(
        q.queryTokens.map((t) => sql`plainto_tsquery('simple', ${t})`),
        sql` || `,
      )})`
    : null;
  const ids = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, q.userId),
        or(eq(tasks.mailboxId, q.mailboxId), isNull(tasks.mailboxId)),
        inArray(tasks.status, [...OPEN_STATUSES]),
        isNull(tasks.mergedIntoId),
        q.exclude.length ? notInArray(tasks.id, q.exclude) : undefined,
        or(...match),
      ),
    )
    .orderBy(...(rank ? [desc(rank)] : []), desc(tasks.lastActivityAt), asc(tasks.id))
    .limit(q.limit);
  if (!ids.length) return [];
  const rows = await db.select().from(tasks).where(inArray(tasks.id, ids.map((r) => r.id)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((r) => byId.get(r.id)).filter((r): r is TaskRow => !!r);
}

interface CardInfo {
  originEvidence: string | null;
  originAt: Date | null;
  lastEvent: string | null;
  lastEventAt: Date | null;
}

/** Origin evidence/date and the last meaningful event of each card task. */
async function cardEventInfo(db: DbOrTx, cardTasks: TaskRow[]): Promise<Map<string, CardInfo>> {
  const out = new Map<string, CardInfo>();
  if (!cardTasks.length) return out;
  const ids = cardTasks.map((t) => t.id);
  const evs = await db
    .select({ taskId: taskEvents.taskId, op: taskEvents.op, actor: taskEvents.actor, applied: taskEvents.applied, evidenceQuote: taskEvents.evidenceQuote, createdAt: taskEvents.createdAt })
    .from(taskEvents)
    .where(inArray(taskEvents.taskId, ids))
    .orderBy(asc(taskEvents.createdAt));
  const originIds = cardTasks.map((t) => t.originMessageId).filter((x): x is string => !!x);
  const origins = originIds.length ? await db.select({ id: messages.id, sortTs: messages.sortTs }).from(messages).where(inArray(messages.id, originIds)) : [];
  const originTs = new Map(origins.map((o) => [o.id, o.sortTs]));
  for (const t of cardTasks) {
    const mine = evs.filter((e) => e.taskId === t.id);
    const isCreation = (op: string) => op === "CREATE" || op === "USER_CREATE";
    const origin = mine.find((e) => isCreation(e.op) && e.evidenceQuote);
    const last = mine.filter((e) => (e.applied || e.actor !== "ai") && !isCreation(e.op)).at(-1);
    out.set(t.id, {
      originEvidence: origin?.evidenceQuote ? truncate(origin.evidenceQuote, CONTEXT_LIMITS.cardTextChars).text : null,
      originAt: (t.originMessageId && originTs.get(t.originMessageId)) || null,
      lastEvent: !last ? null : last.evidenceQuote ? `${last.op} «${truncate(last.evidenceQuote, CONTEXT_LIMITS.cardTextChars).text}»` : last.op,
      lastEventAt: last?.createdAt ?? null,
    });
  }
  return out;
}

type Role = ParticipantRef["roles"][number];

/** Assigns P-handles in first-seen order; P1 is the owner (all owner addresses map to it). */
class Participants {
  private readonly refs: ParticipantRef[] = [];
  private readonly byAddress = new Map<string, ParticipantRef>();
  private readonly inMessage: string[] = [];

  constructor(
    owner: { address: string; name: string | null },
    ownerAddresses: string[],
    private readonly internalDomains: string[],
    private readonly companyMap: Map<string, string>,
  ) {
    const p1: ParticipantRef = {
      handle: "P1",
      address: owner.address,
      name: owner.name,
      isOwner: true,
      isInternal: true,
      company: lookupCompany(companyMap, domainOf(owner.address)),
      roles: [],
    };
    this.refs.push(p1);
    for (const a of [owner.address, ...ownerAddresses]) this.byAddress.set(a, p1);
  }

  /** Returns the handle, "OTHER" when all 8 handles are taken, or null for a missing/invalid address. */
  add(address: string | null | undefined, name: string | null | undefined, role: Role): ParticipantHandle | "OTHER" | null {
    const a = normalizeAddress(address);
    if (!a) return null;
    let p = this.byAddress.get(a);
    if (role !== "task" && role !== "bcc" && !p?.isOwner && !this.inMessage.includes(a)) this.inMessage.push(a);
    if (!p) {
      if (this.refs.length >= CONTEXT_LIMITS.maxParticipants) return "OTHER";
      const d = domainOf(a);
      p = {
        handle: PARTICIPANT_HANDLES[this.refs.length]!,
        address: a,
        name: name?.trim() || null,
        isOwner: false,
        isInternal: isInternalDomain(d, this.internalDomains),
        company: lookupCompany(this.companyMap, d),
        roles: [],
      };
      this.refs.push(p);
      this.byAddress.set(a, p);
    }
    if (!p.name && name?.trim()) p.name = name.trim();
    if (!p.roles.includes(role)) p.roles.push(role);
    return p.handle;
  }

  /** A quoted author without an address: attach the role to a known participant with the same name. */
  addRoleByName(name: string, role: Role): void {
    const n = foldForMatch(name);
    const p = this.refs.find((r) => r.name && foldForMatch(r.name) === n);
    if (p && !p.roles.includes(role)) p.roles.push(role);
  }

  handleOf(address: string | null | undefined): ParticipantHandle | null {
    const a = normalizeAddress(address);
    return a ? (this.byAddress.get(a)?.handle ?? null) : null;
  }

  /** Non-owner addresses that appear in the message (from/to/cc/quoted), including overflowed ones. */
  messageAddresses(): string[] {
    return [...this.inMessage];
  }

  all(): ParticipantRef[] {
    return this.refs;
  }
}

/**
 * Does the company know this domain from before this message: the owner or a colleague wrote to it, or its earlier
 * mail (that reached the AI) was addressed to someone at the company besides this mailbox? Mail that only ever came
 * to this one mailbox proves nothing: a fake «purchase order» campaign sends several, and a forwarded fake PO puts
 * malware in front of colleagues, so the forward rule never trusts it.
 */
async function domainKnown(db: DbOrTx, msg: typeof messages.$inferSelect, domain: string, internalDomains: string[], ownerAddrs: string[]): Promise<boolean> {
  const like = `%@${domain}`;
  const internal = internalDomains.length ? sql`split_part(lower(r->>'address'), '@', 2) in (${sqlList(internalDomains)})` : sql`false`;
  const internalSender = internalDomains.length ? sql`split_part(lower(m.from_address), '@', 2) in (${sqlList(internalDomains)})` : sql`false`;
  const notOwner = ownerAddrs.length ? sql`lower(r->>'address') not in (${sqlList(ownerAddrs)})` : sql`true`;
  const rows = await db.execute(sql`
    select 1 from ${messages} m
    where m.mailbox_id = ${msg.mailboxId} and m.id <> ${msg.id} and m.sort_ts < ${msg.sortTs}
      and (
        ((m.direction = 'OUTBOUND' or m.claims_owner_sender or ${internalSender})
          and exists (select 1 from jsonb_array_elements(m."to" || m.cc) r where lower(r->>'address') like ${like}))
        or (m.state in ('applied', 'extracted', 'pending', 'failed') and lower(m.from_address) like ${like}
          and exists (select 1 from jsonb_array_elements(m."to" || m.cc) r where ${internal} and ${notOwner}))
      )
    limit 1`);
  return rows.rows.length > 0;
}
