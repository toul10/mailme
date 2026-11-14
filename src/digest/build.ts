import { and, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db, DbOrTx } from "../db/client.js";
import { digests, mailboxes, messages, organizations, taskEvents, taskLinks, tasks, users } from "../db/schema.js";
import type { Address, BounceInfo } from "../domain/types.js";
import { OPEN_STATUSES, isOpenStatus } from "../domain/types.js";
import {
  addBusinessDays,
  businessDaysBetweenWith,
  calendarDiff,
  holidayCalendar,
  localDateOf,
  localDateTime,
  safeZone,
  shortDayLabel,
  weekdayLabel,
  type HolidayFn,
} from "./calendar.js";
import { loadFreshness, recentParkedSql } from "./freshness.js";
import { buildRuleBlocks } from "./rule-blocks.js";
import { TAG } from "./labels.js";
import type { DigestItem, DigestModel, DigestProblem, DigestSectionKey } from "./model.js";
import { cleanText, sanitizeAiText } from "./sanitize.js";

/** Sections in precedence order (problems are separate: a bounced task may also appear above). */
export const SECTION_ORDER = ["today", "promises", "followup", "new", "autoClosed", "stillValid"] as const satisfies readonly DigestSectionKey[];
export type RankedSection = (typeof SECTION_ORDER)[number];

export const SECTION_CAPS: Record<DigestSectionKey, number> = { today: 7, promises: 5, followup: 5, new: 7, autoClosed: 5, stillValid: 3, problems: 10 };
/** "Promises due in the next 3 business days" */
export const PROMISE_WINDOW_BUSINESS_DAYS = 3;
/** Parked (not analysed) messages listed by name; the rest are counted. */
export const NOT_ANALYZED_CAP = 5;
/** First report: backfill tasks idle longer than this go to the "Earlier" triage instead. */
export const BACKFILL_TRIAGE_DAYS = 7;


export { TAG };

/** DigestModel plus the org zone (the renderer formats times with it). */
export type DigestModelExt = DigestModel & { zone: string };

/** Task columns the section rules need. */
export interface CandidateTask {
  id: string;
  ref: number;
  title: string;
  status: string;
  priority: string;
  ownerKind: string;
  company: string | null;
  nextAction: string | null;
  dueDate: string | null;
  duePhrase: string | null;
  expectReplyBy: string | null;
  waitingSince: Date | null;
  snoozedUntil: string | null;
  snoozeMode: string | null;
  needsReview: boolean;
  mergedIntoId: string | null;
  origin: string;
  closedBy: string | null;
  closedAt: Date | null;
  autoClosedReportedAt: Date | null;
  stillValidAskedAt: Date | null;
  dormantAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  originMessageId: string | null;
  /** The user has acted on this task at least once (any user event) — it has left the "Earlier" triage. */
  userTouched?: boolean;
}

export interface SectionContext {
  localDate: string;
  now: Date;
  zone: string;
  holidays: HolidayFn;
  /** "New" = created at/after this instant (previous digest, else local yesterday 00:00). */
  newSince: Date;
  /** No digest was delivered before this one. */
  firstReport: boolean;
  /** Tasks whose "Still valid?" was answered (user event after stillValidAskedAt). */
  answered: ReadonlySet<string>;
  /** Tasks already listed under "Still valid?" in a delivered digest since they were asked. */
  stillValidShown: ReadonlySet<string>;
  /** Tasks back from an until_date snooze since the previous digest. */
  resurfaced: ReadonlySet<string>;
}

/**
 * Snoozed on this local date: while the snooze date is in the future. until_reply without a date waits for the reply
 * only; with a date, the date is its fallback (same rule as the web tabs, src/server/queries.ts).
 */
export function isSnoozed(t: Pick<CandidateTask, "snoozeMode" | "snoozedUntil">, localDate: string): boolean {
  if (t.snoozeMode === "until_reply" && t.snoozedUntil === null) return true;
  return t.snoozedUntil !== null && t.snoozedUntil > localDate;
}

/** A dated snooze (until_date, or until_reply's fallback date) that has come due on this local date. */
export function snoozeCameDue(t: Pick<CandidateTask, "snoozeMode" | "snoozedUntil">, localDate: string): boolean {
  return (t.snoozeMode === "until_date" || t.snoozeMode === "until_reply") && t.snoozedUntil !== null && t.snoozedUntil <= localDate;
}

/** Excluded from every section: colleagues' tasks, merged, dormant; on the first report, stale backfill. */
/**
 * "Earlier": an open backfill task idle for > BACKFILL_TRIAGE_DAYS that the user never acted on
 * belongs to the one-time triage list (web tab "earlier"), not to any report. Same rule as the server's tab.
 */
export function isEarlierTriage(t: Pick<CandidateTask, "origin" | "status" | "lastActivityAt" | "userTouched">, now: Date): boolean {
  return t.origin === "backfill" && isOpenStatus(t.status) && !t.userTouched && now.getTime() - t.lastActivityAt.getTime() > BACKFILL_TRIAGE_DAYS * 86_400_000;
}

export function isExcluded(t: CandidateTask, ctx: Pick<SectionContext, "firstReport" | "now">): boolean {
  if (t.ownerKind === "INTERNAL" || t.mergedIntoId !== null || t.dormantAt !== null) return true;
  if (isEarlierTriage(t, ctx.now)) return true;
  return false;
}

export function stillValidPending(t: CandidateTask, ctx: Pick<SectionContext, "answered">): boolean {
  return t.stillValidAskedAt !== null && t.lastActivityAt.getTime() <= t.stillValidAskedAt.getTime() && !ctx.answered.has(t.id);
}

/** The single section a task belongs to (first match wins), or null. */
export function assignSection(t: CandidateTask, ctx: SectionContext): RankedSection | null {
  if (isExcluded(t, ctx)) return null;
  if (!isOpenStatus(t.status)) {
    return t.closedBy === "ai" && t.autoClosedReportedAt === null ? "autoClosed" : null;
  }
  if (isSnoozed(t, ctx.localDate)) return null;
  const { localDate } = ctx;
  if ((t.dueDate !== null && t.dueDate <= localDate) || ctx.resurfaced.has(t.id)) return "today";
  if (t.status === "WAITING_FOR_ME" && t.dueDate !== null && t.dueDate <= addBusinessDays(localDate, PROMISE_WINDOW_BUSINESS_DAYS, ctx.holidays)) return "promises";
  if (t.status === "WAITING_FOR_OTHER" && t.expectReplyBy !== null && t.expectReplyBy <= localDate) return "followup";
  if (t.origin === "ai" && t.createdAt.getTime() >= ctx.newSince.getTime()) return "new";
  if (stillValidPending(t, ctx) && !ctx.stillValidShown.has(t.id)) return "stillValid";
  return null;
}

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1 };

export function overdueDaysOf(t: Pick<CandidateTask, "status" | "dueDate">, localDate: string): number | null {
  if (!isOpenStatus(t.status) || t.dueDate === null || t.dueDate > localDate) return null;
  return calendarDiff(t.dueDate, localDate);
}

export function businessDaysWaitingOf(t: Pick<CandidateTask, "status" | "waitingSince">, ctx: Pick<SectionContext, "localDate" | "zone" | "holidays">): number | null {
  if ((t.status !== "WAITING_FOR_ME" && t.status !== "WAITING_FOR_OTHER") || !t.waitingSince) return null;
  return businessDaysBetweenWith(localDateOf(t.waitingSince, ctx.zone), ctx.localDate, ctx.holidays);
}

/**
 * Deterministic order: overdue days desc → due today → earlier due date → URGENT/HIGH →
 * business days waiting desc → age desc (oldest first) → ref.
 */
export function compareTasks(a: CandidateTask, b: CandidateTask, ctx: Pick<SectionContext, "localDate" | "zone" | "holidays">): number {
  const oa = overdueDaysOf(a, ctx.localDate);
  const ob = overdueDaysOf(b, ctx.localDate);
  const ova = oa ?? -1;
  const ovb = ob ?? -1;
  if (ova > 0 || ovb > 0) {
    if (ova !== ovb) return ovb - ova;
  }
  const ta = oa === 0 ? 0 : 1;
  const tb = ob === 0 ? 0 : 1;
  if (ta !== tb) return ta - tb;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  const pa = PRIORITY_RANK[a.priority] ?? 2;
  const pb = PRIORITY_RANK[b.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  const wa = businessDaysWaitingOf(a, ctx) ?? -1;
  const wb = businessDaysWaitingOf(b, ctx) ?? -1;
  if (wa !== wb) return wb - wa;
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() - b.createdAt.getTime();
  return a.ref - b.ref;
}

/** Pure: candidates → ranked sections (uncapped, sorted). */
export function planSections(candidates: CandidateTask[], ctx: SectionContext): Record<RankedSection, CandidateTask[]> {
  const out: Record<RankedSection, CandidateTask[]> = { today: [], promises: [], followup: [], new: [], autoClosed: [], stillValid: [] };
  for (const t of candidates) {
    const s = assignSection(t, ctx);
    if (s) out[s].push(t);
  }
  for (const key of SECTION_ORDER) out[key].sort((a, b) => compareTasks(a, b, ctx));
  return out;
}

interface LatestMessage {
  subject: string | null;
  sender: string | null;
  at: Date | null;
}

const taskColumns = {
  id: tasks.id,
  ref: tasks.ref,
  title: tasks.title,
  status: tasks.status,
  priority: tasks.priority,
  ownerKind: tasks.ownerKind,
  company: tasks.company,
  nextAction: tasks.nextAction,
  dueDate: tasks.dueDate,
  duePhrase: tasks.duePhrase,
  expectReplyBy: tasks.expectReplyBy,
  waitingSince: tasks.waitingSince,
  snoozedUntil: tasks.snoozedUntil,
  snoozeMode: tasks.snoozeMode,
  needsReview: tasks.needsReview,
  mergedIntoId: tasks.mergedIntoId,
  origin: tasks.origin,
  closedBy: tasks.closedBy,
  closedAt: tasks.closedAt,
  autoClosedReportedAt: tasks.autoClosedReportedAt,
  stillValidAskedAt: tasks.stillValidAskedAt,
  dormantAt: tasks.dormantAt,
  lastActivityAt: tasks.lastActivityAt,
  createdAt: tasks.createdAt,
  originMessageId: tasks.originMessageId,
  userTouched: sql<boolean>`exists (select 1 from task_events ue where ue.task_id = ${sql.raw(`"tasks"."id"`)} and ue.actor = 'user')`,
};

/** Latest linked message per task: direct message links (and the origin message), else the linked threads. */
async function latestMessages(db: DbOrTx, list: CandidateTask[]): Promise<Map<string, LatestMessage>> {
  const result = new Map<string, LatestMessage>();
  if (!list.length) return result;
  const ids = list.map((t) => t.id);
  const links = await db
    .select({ taskId: taskLinks.taskId, threadId: taskLinks.threadId, messageId: taskLinks.messageId })
    .from(taskLinks)
    .where(inArray(taskLinks.taskId, ids));
  const direct = new Map<string, Set<string>>();
  const threadsOf = new Map<string, Set<string>>();
  for (const t of list) {
    direct.set(t.id, new Set(t.originMessageId ? [t.originMessageId] : []));
    threadsOf.set(t.id, new Set());
  }
  for (const l of links) {
    if (l.messageId) direct.get(l.taskId)!.add(l.messageId);
    if (l.threadId) threadsOf.get(l.taskId)!.add(l.threadId);
  }
  const msgIds = [...new Set([...direct.values()].flatMap((s) => [...s]))];
  const threadIds = [...new Set([...threadsOf.entries()].filter(([id]) => direct.get(id)!.size === 0).flatMap(([, s]) => [...s]))];
  if (!msgIds.length && !threadIds.length) return result;
  const conds = [];
  if (msgIds.length) conds.push(inArray(messages.id, msgIds));
  if (threadIds.length) conds.push(inArray(messages.threadId, threadIds));
  const rows = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      direction: messages.direction,
      fromAddress: messages.fromAddress,
      fromName: messages.fromName,
      to: messages.to,
      subject: messages.subject,
      sortTs: messages.sortTs,
    })
    .from(messages)
    .where(conds.length === 1 ? conds[0] : or(...conds));
  const later = (a: (typeof rows)[number], b: (typeof rows)[number] | undefined) =>
    !b || a.sortTs.getTime() > b.sortTs.getTime() || (a.sortTs.getTime() === b.sortTs.getTime() && a.id > b.id);
  for (const t of list) {
    const d = direct.get(t.id)!;
    const th = threadsOf.get(t.id)!;
    let best: (typeof rows)[number] | undefined;
    for (const m of rows) {
      const hit = d.size ? d.has(m.id) : m.threadId !== null && th.has(m.threadId);
      if (hit && later(m, best)) best = m;
    }
    if (best) result.set(t.id, { subject: best.subject || null, sender: senderLabel(best), at: best.sortTs });
  }
  return result;
}

function senderLabel(m: { direction: string; fromName: string | null; fromAddress: string | null; to: Address[] }): string | null {
  if (m.direction === "OUTBOUND") {
    const r = m.to[0];
    const who = r ? r.name || r.address : null;
    return who ? `You → ${who}` : "You";
  }
  return m.fromName || m.fromAddress || null;
}

function toItem(t: CandidateTask, section: DigestSectionKey, ctx: SectionContext, msg: LatestMessage | undefined, extraTags: string[] = []): DigestItem {
  const open = isOpenStatus(t.status);
  const tags: string[] = [];
  if (section === "today" && t.status === "WAITING_FOR_ME" && t.dueDate) tags.push(TAG.promised(t.dueDate));
  if (section === "today" && ctx.resurfaced.has(t.id)) tags.push(TAG.resurfaced);
  if (section === "followup" && t.expectReplyBy) tags.push(TAG.replyBy(t.expectReplyBy));
  if (open && t.priority === "URGENT") tags.push(TAG.urgent);
  if (open && t.priority === "HIGH") tags.push(TAG.high);
  if (t.needsReview && open) tags.push(TAG.review);
  if (section !== "stillValid" && open && stillValidPending(t, ctx)) tags.push(TAG.stillValid);
  tags.push(...extraTags);
  return {
    taskId: t.id,
    ref: t.ref,
    title: sanitizeAiText(t.title, 160),
    company: t.company ? cleanText(t.company, 80) : null,
    nextAction: t.nextAction ? sanitizeAiText(t.nextAction, 200) || null : null,
    status: t.status,
    dueDate: t.dueDate,
    duePhrase: t.duePhrase ? sanitizeAiText(t.duePhrase, 80) || null : null,
    overdueDays: overdueDaysOf(t, ctx.localDate),
    businessDaysWaiting: businessDaysWaitingOf(t, ctx),
    subject: msg?.subject ? cleanText(msg.subject, 160) : null,
    sender: msg?.sender ? cleanText(msg.sender, 80) : null,
    lastMessageDate: msg?.at ? localDateTime(msg.at, ctx.zone) : null,
    needsReview: t.needsReview,
    tags,
  };
}

function emptySections(): DigestModel["sections"] {
  return {
    today: { items: [], more: 0 },
    promises: { items: [], more: 0 },
    followup: { items: [], more: 0 },
    new: { items: [], more: 0 },
    autoClosed: { items: [], more: 0 },
    stillValid: { items: [], more: 0 },
    problems: { items: [], more: 0 },
  };
}

/** Each task once, first matching section by precedence; caps 7/5/5…; deterministic order. */
export async function buildDigestModel(db: Db, userId: string, localDate: string, now: Date, opts: { late?: boolean } = {}): Promise<DigestModel> {
  const [u] = await db
    .select({ id: users.id, name: users.name, timezone: organizations.timezone, holySpirit: organizations.holySpiritHoliday })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.orgId))
    .where(eq(users.id, userId));
  if (!u) throw new Error("digest: user not found");
  const zone = safeZone(u.timezone);
  const holidays = holidayCalendar({ includeHolySpirit: u.holySpirit });

  // Previous delivered digest → cutoff for "New", parked messages and first-report rules. The watermark is when its
  // content was built (rendered_at): a retried delivery is built long after its row was first claimed (created_at).
  const [prev] = await db
    .select({ createdAt: digests.createdAt, renderedAt: digests.renderedAt })
    .from(digests)
    .where(and(eq(digests.userId, userId), eq(digests.status, "delivered"), lt(digests.localDate, localDate)))
    .orderBy(desc(digests.localDate))
    .limit(1);
  const yesterdayStart = DateTime.fromISO(localDate, { zone }).minus({ days: 1 }).startOf("day").toJSDate();
  // Rows delivered before rendered_at existed fall back to the claim time (earlier: may repeat, never loses an item).
  const newSince = prev ? (prev.renderedAt ?? prev.createdAt) : yesterdayStart;

  const candidates: CandidateTask[] = await db
    .select(taskColumns)
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        isNull(tasks.mergedIntoId),
        isNull(tasks.dormantAt),
        ne(tasks.ownerKind, "INTERNAL"),
        or(inArray(tasks.status, [...OPEN_STATUSES]), and(eq(tasks.closedBy, "ai"), isNull(tasks.autoClosedReportedAt))),
      ),
    );
  const ids = candidates.map((t) => t.id);

  // Answers to "Still valid?": any user event after the ask.
  const asked = candidates.filter((t) => t.stillValidAskedAt !== null);
  const answered = new Set<string>();
  const stillValidShown = new Set<string>();
  if (asked.length) {
    const lastUser = await db
      .select({ taskId: taskEvents.taskId, at: sql<Date>`max(${taskEvents.createdAt})`.mapWith(taskEvents.createdAt) })
      .from(taskEvents)
      .where(and(inArray(taskEvents.taskId, asked.map((t) => t.id)), eq(taskEvents.actor, "user")))
      .groupBy(taskEvents.taskId);
    const lastUserAt = new Map(lastUser.map((r) => [r.taskId!, new Date(r.at)]));
    for (const t of asked) {
      const at = lastUserAt.get(t.id);
      if (at && at.getTime() > t.stillValidAskedAt!.getTime()) answered.add(t.id);
    }
    const earliest = new Date(Math.min(...asked.map((t) => t.stillValidAskedAt!.getTime())));
    const shownRows = await db
      .select({ deliveredAt: digests.deliveredAt, sections: digests.sections })
      .from(digests)
      .where(and(eq(digests.userId, userId), eq(digests.status, "delivered"), gte(digests.deliveredAt, earliest)));
    for (const t of asked) {
      for (const d of shownRows) {
        if (d.deliveredAt && d.deliveredAt.getTime() >= t.stillValidAskedAt!.getTime() && (d.sections?.stillValid ?? []).includes(t.id)) {
          stillValidShown.add(t.id);
        }
      }
    }
  }

  // Back from a dated snooze (until_date, or until_reply's fallback date): expired but not yet cleared, or
  // unsnoozed by aging since the last digest.
  const resurfaced = new Set<string>();
  for (const t of candidates) if (snoozeCameDue(t, localDate)) resurfaced.add(t.id);
  if (ids.length) {
    const unsnoozed = await db
      .select({ taskId: taskEvents.taskId })
      .from(taskEvents)
      .where(and(inArray(taskEvents.taskId, ids), eq(taskEvents.op, "SYSTEM_UNSNOOZE"), gte(taskEvents.createdAt, newSince)));
    for (const r of unsnoozed) if (r.taskId) resurfaced.add(r.taskId);
  }

  const ctx: SectionContext = { localDate, now, zone, holidays, newSince, firstReport: !prev, answered, stillValidShown, resurfaced };
  const planned = planSections(candidates, ctx);

  // Problems: bounces reported since the previous digest (any status: a completed task can bounce).
  const bounceRows = await db
    .select({ taskId: taskEvents.taskId, payload: taskEvents.payload, after: taskEvents.after, bounce: messages.bounce, createdAt: taskEvents.createdAt })
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .leftJoin(messages, eq(messages.id, taskEvents.messageId))
    .where(and(eq(tasks.userId, userId), eq(taskEvents.op, "SYSTEM_BOUNCE"), gte(taskEvents.createdAt, newSince)))
    .orderBy(desc(taskEvents.createdAt));
  const bounceRecipient = new Map<string, string | null>();
  for (const b of bounceRows) {
    if (!b.taskId || bounceRecipient.has(b.taskId)) continue;
    bounceRecipient.set(b.taskId, recipientOf(b.payload) ?? recipientOf(b.after) ?? (b.bounce as BounceInfo | null)?.recipient ?? null);
  }
  let bounceTasks: CandidateTask[] = [];
  if (bounceRecipient.size) {
    bounceTasks = (await db.select(taskColumns).from(tasks).where(and(inArray(tasks.id, [...bounceRecipient.keys()]), eq(tasks.userId, userId)))).filter(
      (t) => t.ownerKind !== "INTERNAL" && t.mergedIntoId === null,
    );
    bounceTasks.sort((a, b) => a.ref - b.ref);
  }

  // Enrich only what will be shown.
  const shown: Array<[DigestSectionKey, CandidateTask[]]> = SECTION_ORDER.map((k) => [k, planned[k].slice(0, SECTION_CAPS[k])]);
  const shownBounces = bounceTasks.slice(0, SECTION_CAPS.problems);
  const latest = await latestMessages(db, [...shown.flatMap(([, l]) => l), ...shownBounces]);

  const sections = emptySections();
  for (const [key, list] of shown) {
    sections[key] = { items: list.map((t) => toItem(t, key, ctx, latest.get(t.id))), more: planned[key as RankedSection].length - list.length };
  }
  sections.problems = {
    items: shownBounces.map((t) => toItem(t, "problems", ctx, latest.get(t.id), [TAG.bounce(bounceRecipient.get(t.id) ?? null)])),
    more: bounceTasks.length - shownBounces.length,
  };

  // Problems: parked messages, bounces, freshness. A parked message is reported once, in the first report after it
  // was parked (acknowledged ones never); the web "Not analysed" list keeps it until it is retried or acknowledged.
  const problems: DigestProblem[] = [];
  const mbIds = (await db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, userId))).map((m) => m.id);
  if (mbIds.length) {
    const parked = and(inArray(messages.mailboxId, mbIds), recentParkedSql(newSince));
    const failed = await db
      .select({ subject: messages.subject, fromName: messages.fromName, fromAddress: messages.fromAddress, direction: messages.direction, to: messages.to, sortTs: messages.sortTs })
      .from(messages)
      .where(parked)
      .orderBy(desc(messages.sortTs), desc(messages.id))
      .limit(NOT_ANALYZED_CAP);
    const [{ n: failedTotal } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(parked);
    for (const m of failed) {
      const subject = cleanText(m.subject, 120) || "(no subject)";
      const sender = senderLabel(m);
      const when = `${shortDayLabel(localDateOf(m.sortTs, zone))} ${localDateTime(m.sortTs, zone).slice(11)}`;
      problems.push({ kind: "not_analyzed", text: `Not analysed: “${subject}”${sender ? ` — ${cleanText(sender, 80)}` : ""} · ${when}` });
    }
    const rest = Number(failedTotal) - failed.length;
    if (rest > 0) problems.push({ kind: "not_analyzed", text: `… and ${rest} more ${rest === 1 ? "message" : "messages"} not analysed` });
  }
  for (const t of bounceTasks) {
    const to = bounceRecipient.get(t.id) ?? null;
    problems.push({ kind: "bounce", text: `${to ? `Not delivered to ${cleanText(to, 80)}` : "Not delivered"}: #${t.ref} ${sanitizeAiText(t.title, 160)}` });
  }
  const fresh = await loadFreshness(db, userId, now, zone);
  problems.push(...fresh.problems);

  // Counts over visible open tasks.
  const visibleOpen = candidates.filter((t) => isOpenStatus(t.status) && !isExcluded(t, ctx) && !isSnoozed(t, localDate));
  const counts = {
    openTotal: visibleOpen.length,
    actionToday: planned.today.length,
    waiting: visibleOpen.filter((t) => t.status === "WAITING_FOR_OTHER").length,
    overdue: visibleOpen.filter((t) => t.dueDate !== null && t.dueDate < localDate).length,
  };

  const ruleBlocks = await buildRuleBlocks(db, { userId, since: newSince, openTotal: counts.openTotal });
  const isEmpty =
    (Object.keys(sections) as DigestSectionKey[]).every((k) => sections[k].items.length === 0 && sections[k].more === 0) &&
    !problems.some((p) => p.kind === "not_analyzed" || p.kind === "bounce") &&
    !ruleBlocks?.answered.length &&
    !ruleBlocks?.updates.length;

  const model: DigestModelExt = {
    userId,
    userName: u.name,
    localDate,
    weekdayLabel: weekdayLabel(localDate),
    late: opts.late ?? false,
    freshness: fresh.freshness,
    counts,
    sections,
    problems,
    isEmpty,
    zone,
    ...(ruleBlocks ? { rules: ruleBlocks } : {}),
  };
  return model;
}

function recipientOf(v: unknown): string | null {
  if (v && typeof v === "object") {
    const r = (v as Record<string, unknown>).recipient;
    if (typeof r === "string" && r.trim()) return r.trim();
  }
  return null;
}

/** Task ids shown per section (stored in digests.sections for audit, feedback and “shown once” rules). */
export function sectionTaskIds(model: DigestModel): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(model.sections)) out[k] = v.items.map((i) => i.taskId);
  return out;
}
