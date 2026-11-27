/**
 * What the worker is doing right now, for the sync bar (HealthSummary.activity). Read from Postgres only, so the
 * worker writes nothing for it:
 * - a scheduled pass is running while some session holds the "tick" advisory lock (src/worker/tick.ts). Not the
 *   "worker" lock: a long-running worker (`pnpm start:worker`) holds that one all the time, and has no passes;
 * - the AI is reading a mailbox while some session holds its "drain:<id>" lock (src/engine/pipeline.ts), with either
 *   kind of worker;
 * - how far it got: the messages analysed since that pass started, against the ones still queued;
 * - why a mailbox stopped: its AI pause (a daily-budget pause ends at the next local midnight).
 * The locks are read from pg_locks, which lists the sessions of every process on the database (the scheduled
 * tick job's too). A database where that cannot be read reports `running: null` and nothing as being analysed.
 */
import { and, asc, eq, gte, inArray, max, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import { extractions, mailboxes, messages, organizations } from "../db/schema.js";
import { isGloballyPaused } from "../digest/freshness.js";
import { safeZone } from "../digest/calendar.js";
import { BUDGET_PAUSE_REASONS } from "../domain/types.js";
import type { MailboxActivity, SyncActivity } from "./api-types.js";

/** The advisory lock a scheduled pass holds while it runs (src/worker/tick.ts, TICK_LOCK there). */
const TICK_LOCK = "tick";

/**
 * Which of `keys` are held as session advisory locks (hashtextextended(key, 0), as src/db/client.ts takes them),
 * each with the start of the session holding it (null when not visible); null when the locks cannot be read.
 */
export type LockProbe = (keys: string[]) => Promise<Map<string, Date | null> | null>;

/** The lock probe of a real Postgres: pg_locks joined to pg_stat_activity. */
export function pgLockProbe(db: Db): LockProbe {
  return async (keys) => {
    if (keys.length === 0) return new Map();
    try {
      // A bigint advisory key shows in pg_locks as classid (high 32 bits) and objid (low 32 bits), objsubid 1.
      const res = await db.execute(sql`
        select k.key, a.backend_start
          from unnest(array[${sql.join(
            keys.map((k) => sql`${k}`),
            sql`, `,
          )}]::text[]) as k(key)
          join pg_locks l on l.locktype = 'advisory' and l.granted and l.objsubid = 1
                         and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(k.key, 0)
          left join pg_stat_activity a on a.pid = l.pid`);
      const held = new Map<string, Date | null>();
      for (const row of res.rows as Array<{ key: string; backend_start: string | Date | null }>) {
        const since = row.backend_start ? new Date(row.backend_start) : null;
        held.set(row.key, since && !Number.isNaN(since.getTime()) ? since : null);
      }
      return held;
    } catch {
      return null;
    }
  };
}

/** With no pass running (or its start unknown), `done` counts the messages analysed in this window. */
export const RECENT_WINDOW_MS = 10 * 60_000;

const BUDGET_REASONS = new Set<string>(Object.values(BUDGET_PAUSE_REASONS));

/** The session user's mailboxes as the worker sees them now. `zone`: the user's, for "today". */
export async function loadSyncActivity(db: Db, probe: LockProbe, userId: string, zone: string, now: Date): Promise<SyncActivity> {
  const mbs = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      provider: mailboxes.provider,
      status: mailboxes.status,
      lastSyncAt: mailboxes.lastSyncAt,
      aiPaused: mailboxes.aiPaused,
      aiPausedReason: mailboxes.aiPausedReason,
      orgZone: organizations.timezone,
    })
    .from(mailboxes)
    .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
    .where(eq(mailboxes.userId, userId))
    .orderBy(asc(mailboxes.address));
  const ids = mbs.map((m) => m.id);
  const locks = await probe([TICK_LOCK, ...ids.map((id) => `drain:${id}`)]);
  const running = locks ? locks.has(TICK_LOCK) : null;
  const passStart = running ? (locks?.get(TICK_LOCK) ?? null) : null;
  const windowStart = passStart && passStart.getTime() <= now.getTime() ? passStart : new Date(now.getTime() - RECENT_WINDOW_MS);
  const dayStart = DateTime.fromJSDate(now, { zone: safeZone(zone) }).startOf("day").toJSDate();
  const from = windowStart.getTime() < dayStart.getTime() ? windowStart : dayStart;

  const queued = new Map<string, number>();
  const done = new Map<string, { recent: number; today: number }>();
  const last = new Map<string, Date | null>();
  if (ids.length) {
    const q = await db
      .select({ id: messages.mailboxId, n: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(inArray(messages.mailboxId, ids), inArray(messages.state, ["pending", "extracted"])))
      .groupBy(messages.mailboxId);
    for (const r of q) queued.set(r.id, Number(r.n));
    const d = await db
      .select({
        id: extractions.mailboxId,
        recent: sql<number>`count(distinct ${extractions.messageId}) filter (where ${extractions.createdAt} >= ${windowStart.toISOString()}::timestamptz)::int`,
        today: sql<number>`count(distinct ${extractions.messageId}) filter (where ${extractions.createdAt} >= ${dayStart.toISOString()}::timestamptz)::int`,
      })
      .from(extractions)
      .where(and(inArray(extractions.mailboxId, ids), gte(extractions.createdAt, from)))
      .groupBy(extractions.mailboxId);
    for (const r of d) done.set(r.id, { recent: Number(r.recent), today: Number(r.today) });
    const l = await db
      .select({ id: extractions.mailboxId, at: max(extractions.createdAt) })
      .from(extractions)
      .where(inArray(extractions.mailboxId, ids))
      .groupBy(extractions.mailboxId);
    for (const r of l) last.set(r.id, r.at ? new Date(r.at) : null);
  }

  const out: MailboxActivity[] = mbs.map((m) => {
    const budget = m.aiPaused && BUDGET_REASONS.has(m.aiPausedReason ?? "");
    const resumesAt = budget ? DateTime.fromJSDate(now, { zone: safeZone(m.orgZone) }).startOf("day").plus({ days: 1 }).toJSDate() : null;
    return {
      id: m.id,
      address: m.address,
      provider: m.provider,
      status: m.status,
      lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
      analysing: Boolean(locks?.has(`drain:${m.id}`)),
      queued: queued.get(m.id) ?? 0,
      done: done.get(m.id)?.recent ?? 0,
      doneToday: done.get(m.id)?.today ?? 0,
      lastAnalysedAt: last.get(m.id)?.toISOString() ?? null,
      paused: m.aiPaused ? m.aiPausedReason || "paused" : null,
      resumesAt: resumesAt?.toISOString() ?? null,
    };
  });
  return { running, runningSince: passStart?.toISOString() ?? null, globalPaused: await isGloballyPaused(db), mailboxes: out };
}
