/**
 * What the chat has cost today, and the record of each question. The record is a row of the security audit log
 * (event "chat.ask"): who asked, the model, the rounds, the tokens, the cost and how it ended. Never the question,
 * the answer or anything that was read. The daily limits (CHAT_DAILY_QUESTION_CAP per user, CHAT_DAILY_USD_CAP for
 * everyone together) count these rows, so they hold across restarts and API instances.
 */
import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import { audit } from "../server/audit.js";
import type { ChatStats } from "./engine.js";

export interface ChatUsageToday {
  /** Questions this user asked since midnight (their time zone). */
  questions: number;
  /** What all users' questions cost in the same period, at the price table's rates. */
  usdAll: number;
}

export async function chatUsageToday(db: Db, userId: string, zone: string, now: Date): Promise<ChatUsageToday> {
  const dayStart = DateTime.fromJSDate(now, { zone }).startOf("day").toJSDate();
  const res = await db.execute(sql`
    select count(*) filter (where user_id = ${userId}) as questions,
           coalesce(sum((detail->>'costUsd')::double precision), 0) as usd
    from security_audit
    where event = 'chat.ask' and created_at >= ${dayStart.toISOString()}::timestamptz`);
  const row = res.rows[0] as { questions: number | string; usd: number | string } | undefined;
  return { questions: Number(row?.questions ?? 0), usdAll: Number(row?.usd ?? 0) };
}

export async function recordChat(db: Db, entry: { orgId: string; userId: string; ip: string | null; stats: ChatStats; ms: number }): Promise<void> {
  const s = entry.stats;
  await audit(db, {
    orgId: entry.orgId,
    userId: entry.userId,
    ip: entry.ip,
    event: "chat.ask",
    detail: {
      outcome: s.outcome,
      model: s.model,
      calls: s.calls,
      rounds: s.rounds,
      lookups: s.lookups,
      sources: s.sources,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cachedTokens: s.cachedTokens,
      costUsd: s.costUsd,
      ms: Math.round(entry.ms),
    },
  });
}
