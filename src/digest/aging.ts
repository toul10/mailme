import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { digests, organizations, taskEvents, tasks } from "../db/schema.js";
import { OPEN_STATUSES } from "../domain/types.js";
import { businessDaysBetweenWith, holidayCalendar, localDateOf, safeZone, type HolidayFn } from "./calendar.js";

/** Idle business days before "Still valid?" is asked. */
export const STILL_VALID_AFTER_BUSINESS_DAYS = 7;
/** Unanswered business days after the question was shown in a delivered report before the task goes dormant. */
export const DORMANT_AFTER_BUSINESS_DAYS = 7;
/**
 * Idle business days before a colleague's task (ownerKind INTERNAL — typically a hand-over) goes dormant. There is no
 * "Still valid?" for it: P1 cannot answer for the colleague and the report never shows it. With no mail on the topic
 * for two working weeks it was most likely handled outside P1's mailbox; new mail on the topic wakes it (apply.ts).
 */
export const COLLEAGUE_DORMANT_AFTER_BUSINESS_DAYS = 10;

interface AgingTask {
  id: string;
  orgId: string;
  userId: string;
  mailboxId: string | null;
  ownerKind?: string;
  dueDate: string | null;
  expectReplyBy: string | null;
  lastActivityAt: Date;
  stillValidAskedAt: Date | null;
}

const msAfter = (d: Date) => new Date(d.getTime() + 1);

export type AgingDecision = "ask" | "dormant" | null;

/**
 * Pure: what aging does to one open, visible, unsnoozed task today.
 * Tasks with a future deadline (due date or follow-up date) are left alone: they surface on their own when due,
 * and a dormant task would never be reported again.
 * `shownAt`: when a delivered report first showed the task with its question (at/after stillValidAskedAt), or null.
 * The dormancy clock starts there — never at the ask itself, which may never reach a report (section cap, shadow week,
 * delivery failures).
 */
export function agingDecision(
  t: Pick<AgingTask, "dueDate" | "expectReplyBy" | "lastActivityAt" | "stillValidAskedAt">,
  lastUserEventAt: Date | null,
  shownAt: Date | null,
  today: string,
  zone: string,
  holidays: HolidayFn,
): AgingDecision {
  if ((t.dueDate !== null && t.dueDate >= today) || (t.expectReplyBy !== null && t.expectReplyBy > today)) return null;
  const activity = lastUserEventAt && lastUserEventAt.getTime() > t.lastActivityAt.getTime() ? lastUserEventAt : t.lastActivityAt;
  const bd = (d: Date) => businessDaysBetweenWith(localDateOf(d, zone), today, holidays);
  if (t.stillValidAskedAt && activity.getTime() <= t.stillValidAskedAt.getTime()) {
    return shownAt && bd(shownAt) >= DORMANT_AFTER_BUSINESS_DAYS ? "dormant" : null;
  }
  if (bd(activity) < STILL_VALID_AFTER_BUSINESS_DAYS) return null;
  if (t.stillValidAskedAt && bd(t.stillValidAskedAt) < STILL_VALID_AFTER_BUSINESS_DAYS) return null;
  return "ask";
}

/**
 * Pure: aging of a colleague's open, unsnoozed task — never asked, dormant after
 * {@link COLLEAGUE_DORMANT_AFTER_BUSINESS_DAYS} idle business days (user events count as activity); a future
 * deadline keeps it as is, like {@link agingDecision}.
 */
export function colleagueAgingDecision(
  t: Pick<AgingTask, "dueDate" | "expectReplyBy" | "lastActivityAt">,
  lastUserEventAt: Date | null,
  today: string,
  zone: string,
  holidays: HolidayFn,
): "dormant" | null {
  if ((t.dueDate !== null && t.dueDate >= today) || (t.expectReplyBy !== null && t.expectReplyBy > today)) return null;
  const activity = lastUserEventAt && lastUserEventAt.getTime() > t.lastActivityAt.getTime() ? lastUserEventAt : t.lastActivityAt;
  return businessDaysBetweenWith(localDateOf(activity, zone), today, holidays) >= COLLEAGUE_DORMANT_AFTER_BUSINESS_DAYS ? "dormant" : null;
}

interface OrgCalendar {
  zone: string;
  today: string;
  holidays: HolidayFn;
}

/**
 * Unsnooze due tasks; mark "Still valid?" after 7 idle business days; dormant 7 business days after the question was
 * shown in a delivered report. Colleagues' tasks are never asked and go dormant after 10 idle business
 * days ({@link colleagueAgingDecision}). "Today" and business days are those of each task's organization, like the
 * report's; `zone` is only the fallback for an invalid org timezone.
 */
export async function runAging(db: Db, now: Date, zone: string): Promise<{ unsnoozed: number; asked: number; dormant: number }> {
  const fallbackZone = safeZone(zone);
  const result = { unsnoozed: 0, asked: 0, dormant: 0 };

  const orgs = await db.select({ id: organizations.id, timezone: organizations.timezone, holySpirit: organizations.holySpiritHoliday }).from(organizations);
  const calendars = new Map<string, OrgCalendar>();
  for (const o of orgs) {
    const z = safeZone(o.timezone, fallbackZone);
    calendars.set(o.id, { zone: z, today: localDateOf(now, z), holidays: holidayCalendar({ includeHolySpirit: o.holySpirit }) });
  }
  const fallback: OrgCalendar = { zone: fallbackZone, today: localDateOf(now, fallbackZone), holidays: holidayCalendar() };
  const calOf = (orgId: string) => calendars.get(orgId) ?? fallback;
  // Latest "today" of any org: a cheap SQL pre-filter; the exact per-org check is below.
  const maxToday = [fallback, ...calendars.values()].reduce((m, c) => (c.today > m ? c.today : m), fallback.today);

  // 1. Dated snoozes that have come due: until_date, and until_reply's optional fallback date.
  const due = await db
    .select({ id: tasks.id, orgId: tasks.orgId, userId: tasks.userId, mailboxId: tasks.mailboxId, snoozedUntil: tasks.snoozedUntil, snoozeMode: tasks.snoozeMode })
    .from(tasks)
    .where(and(inArray(tasks.status, [...OPEN_STATUSES]), isNotNull(tasks.snoozedUntil), sql`${tasks.snoozedUntil} <= ${maxToday}::date`));
  for (const t of due) {
    if (t.snoozedUntil! > calOf(t.orgId).today) continue;
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(tasks)
        .set({ snoozedUntil: null, snoozeMode: null, version: sql`${tasks.version} + 1`, lastActivityAt: now, updatedAt: now })
        .where(and(eq(tasks.id, t.id), eq(tasks.snoozedUntil, t.snoozedUntil!), t.snoozeMode === null ? isNull(tasks.snoozeMode) : eq(tasks.snoozeMode, t.snoozeMode)))
        .returning({ id: tasks.id });
      if (!row) return false;
      await tx.insert(taskEvents).values({
        taskId: t.id,
        userId: t.userId,
        mailboxId: t.mailboxId,
        actor: "system",
        op: "SYSTEM_UNSNOOZE",
        before: { snoozedUntil: t.snoozedUntil, snoozeMode: t.snoozeMode },
        after: { snoozedUntil: null, snoozeMode: null },
        applied: true,
      });
      return true;
    });
    if (done) result.unsnoozed++;
  }

  // 2–3. Ask "Still valid?" / go dormant. Colleagues' tasks are never reported, so they are not asked: they only go dormant.
  const rows = await db
    .select({
      id: tasks.id,
      orgId: tasks.orgId,
      userId: tasks.userId,
      mailboxId: tasks.mailboxId,
      ownerKind: tasks.ownerKind,
      dueDate: tasks.dueDate,
      expectReplyBy: tasks.expectReplyBy,
      lastActivityAt: tasks.lastActivityAt,
      stillValidAskedAt: tasks.stillValidAskedAt,
      snoozedUntil: tasks.snoozedUntil,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...OPEN_STATUSES]),
        isNull(tasks.mergedIntoId),
        isNull(tasks.dormantAt),
        isNull(tasks.snoozeMode),
        or(isNull(tasks.snoozedUntil), sql`${tasks.snoozedUntil} <= ${maxToday}::date`),
      ),
    );
  const open: AgingTask[] = rows.filter((t) => t.snoozedUntil === null || t.snoozedUntil <= calOf(t.orgId).today);
  if (!open.length) return result;

  const lastUser = new Map<string, Date>();
  const ids = open.map((t) => t.id);
  for (let i = 0; i < ids.length; i += 500) {
    const evs = await db
      .select({ taskId: taskEvents.taskId, at: sql<Date>`max(${taskEvents.createdAt})`.mapWith(taskEvents.createdAt) })
      .from(taskEvents)
      .where(and(inArray(taskEvents.taskId, ids.slice(i, i + 500)), eq(taskEvents.actor, "user")))
      .groupBy(taskEvents.taskId);
    for (const r of evs) if (r.taskId) lastUser.set(r.taskId, new Date(r.at));
  }

  const isColleagues = (t: AgingTask) => t.ownerKind === "INTERNAL";
  const shownAt = await firstShownSinceAsked(db, open.filter((t) => !isColleagues(t)));

  for (const t of open) {
    const cal = calOf(t.orgId);
    const decision = isColleagues(t)
      ? colleagueAgingDecision(t, lastUser.get(t.id) ?? null, cal.today, cal.zone, cal.holidays)
      : agingDecision(t, lastUser.get(t.id) ?? null, shownAt.get(t.id) ?? null, cal.today, cal.zone, cal.holidays);
    if (!decision) continue;
    const done = await db.transaction(async (tx) => {
      // Re-check against the snapshot (JS dates are ms, timestamptz is µs: compare within the millisecond).
      const unchanged = and(
        eq(tasks.id, t.id),
        isNull(tasks.dormantAt),
        isNull(tasks.snoozeMode),
        lt(tasks.lastActivityAt, msAfter(t.lastActivityAt)),
        t.stillValidAskedAt ? and(gte(tasks.stillValidAskedAt, t.stillValidAskedAt), lt(tasks.stillValidAskedAt, msAfter(t.stillValidAskedAt))) : isNull(tasks.stillValidAskedAt),
      );
      const [row] =
        decision === "ask"
          ? await tx.update(tasks).set({ stillValidAskedAt: now, updatedAt: now }).where(unchanged).returning({ id: tasks.id })
          : await tx.update(tasks).set({ dormantAt: now, updatedAt: now }).where(unchanged).returning({ id: tasks.id });
      if (!row) return false;
      await tx.insert(taskEvents).values({
        taskId: t.id,
        userId: t.userId,
        mailboxId: t.mailboxId,
        actor: "system",
        op: decision === "ask" ? "SYSTEM_STILL_VALID_ASKED" : "SYSTEM_DORMANT",
        before: decision === "ask" ? { stillValidAskedAt: t.stillValidAskedAt?.toISOString() ?? null } : { dormantAt: null },
        after: decision === "ask" ? { stillValidAskedAt: now.toISOString() } : { dormantAt: now.toISOString() },
        applied: true,
      });
      return true;
    });
    if (done) result[decision === "ask" ? "asked" : "dormant"]++;
  }
  return result;
}

/**
 * For asked tasks: the first delivered report (delivered at/after the ask) that showed the task. Any section counts —
 * "Still valid?" itself, or another section where the item carries the "Still valid?" tag (build.ts toItem tags
 * every unanswered asked task). Dispatch re-stamps stillValidAskedAt to the delivery time for the "Still valid?"
 * section, so that delivery counts too.
 */
async function firstShownSinceAsked(db: Db, open: AgingTask[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const byUser = new Map<string, AgingTask[]>();
  for (const t of open) {
    if (!t.stillValidAskedAt) continue;
    const list = byUser.get(t.userId) ?? [];
    list.push(t);
    byUser.set(t.userId, list);
  }
  for (const [userId, list] of byUser) {
    const earliest = new Date(Math.min(...list.map((t) => t.stillValidAskedAt!.getTime())));
    const delivered = await db
      .select({ deliveredAt: digests.deliveredAt, sections: digests.sections })
      .from(digests)
      .where(and(eq(digests.userId, userId), eq(digests.status, "delivered"), isNotNull(digests.deliveredAt), gte(digests.deliveredAt, earliest)));
    const shownIn = delivered.map((d) => ({ at: d.deliveredAt!, ids: new Set(Object.values(d.sections ?? {}).flat()) }));
    for (const t of list) {
      for (const d of shownIn) {
        if (d.at.getTime() < t.stillValidAskedAt!.getTime() || !d.ids.has(t.id)) continue;
        const cur = out.get(t.id);
        if (!cur || d.at.getTime() < cur.getTime()) out.set(t.id, d.at);
      }
    }
  }
  return out;
}
