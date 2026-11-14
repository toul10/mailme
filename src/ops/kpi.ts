import { sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import { isBusinessDay } from "../lib/dates.js";

/**
 * KPIs straight from SQL. Aggregates only — never per named person, never content.
 * The range is inclusive local dates in `zone`.
 */

export interface KpiReport {
  range: { from: string; to: string; zone: string };
  tasksCreated: Array<{ origin: string; tier: string; count: number }>;
  /** AI-created tasks in range and how many of them the user marked "Not a task" (precision signal). */
  notATask: { aiCreated: number; dismissedNotATask: number; pct: number | null };
  aiCompleted: number;
  reopenedAfterAiClose: number;
  merges: number;
  wouldHaveMissed: number;
  manualAdds: number;
  suggestions: Array<{ state: string; count: number }>;
  extractionCostByDay: Array<{ day: string; calls: number; errors: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
  messagesByState: Array<{ state: string; count: number }>;
  messagesByFilterReason: Array<{ reason: string; count: number }>;
  /** Adoption target: user actions on ≥ 4 of 5 business days. */
  adoption: { businessDays: number; activeBusinessDays: number; activeDays: string[] };
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);

export async function computeKpis(db: Db, opts: { from: string; to: string; zone: string }): Promise<KpiReport> {
  const fromDt = DateTime.fromISO(opts.from, { zone: opts.zone });
  const toDt = DateTime.fromISO(opts.to, { zone: opts.zone });
  if (!fromDt.isValid || !toDt.isValid || toDt < fromDt) throw new Error("Invalid KPI range (expected --from <= --to, YYYY-MM-DD)");
  const from = fromDt.startOf("day").toJSDate();
  const to = toDt.plus({ days: 1 }).startOf("day").toJSDate();
  const inRange = (col: string) => sql`${sql.raw(col)} >= ${from} and ${sql.raw(col)} < ${to}`;
  const rows = async (q: SQL) => (await db.execute(q)).rows as Row[];
  const countEvents = async (op: string, extra = sql``) =>
    num((await rows(sql`select count(*)::int as n from task_events e where e.op = ${op} and ${inRange("e.created_at")} ${extra}`))[0]?.n);

  const tasksCreated = (
    await rows(sql`
      select t.origin, coalesce(ev.tier, case when t.origin = 'manual' then 'manual' else 'unknown' end) as tier, count(*)::int as n
      from tasks t
      left join lateral (select e.tier from task_events e where e.task_id = t.id and e.op = 'CREATE' order by e.created_at limit 1) ev on true
      where ${inRange("t.created_at")}
      group by 1, 2 order by 1, 2`)
  ).map((r) => ({ origin: String(r.origin), tier: String(r.tier), count: num(r.n) }));

  const [nat] = await rows(sql`
    select count(*)::int as ai_created,
      count(*) filter (where exists (select 1 from task_events e where e.task_id = t.id and e.op = 'USER_NOT_A_TASK'))::int as not_a_task
    from tasks t where t.origin in ('ai','backfill') and ${inRange("t.created_at")}`);
  const aiCreated = num(nat?.ai_created);
  const dismissedNotATask = num(nat?.not_a_task);

  const suggestions = (
    await rows(sql`select suggestion_state as state, count(*)::int as n from task_events
      where suggestion_state is not null and ${inRange("created_at")} group by 1 order by 1`)
  ).map((r) => ({ state: String(r.state), count: num(r.n) }));

  const extractionCostByDay = (
    await rows(sql`
      select to_char((created_at at time zone ${opts.zone})::date, 'YYYY-MM-DD') as day, count(*)::int as calls,
        count(*) filter (where status = 'error')::int as errors, coalesce(sum(cost_usd), 0)::float8 as cost,
        coalesce(sum(input_tokens), 0)::float8 as input, coalesce(sum(output_tokens), 0)::float8 as output,
        coalesce(sum(cache_read_input_tokens), 0)::float8 as cache_read
      from extractions where ${inRange("created_at")} group by 1 order by 1`)
  ).map((r) => ({
    day: String(r.day),
    calls: num(r.calls),
    errors: num(r.errors),
    costUsd: Math.round(num(r.cost) * 10_000) / 10_000,
    inputTokens: num(r.input),
    outputTokens: num(r.output),
    cacheReadTokens: num(r.cache_read),
  }));

  const messagesByState = (
    await rows(sql`select state, count(*)::int as n from messages where ${inRange("first_seen_at")} group by 1 order by 2 desc, 1`)
  ).map((r) => ({ state: String(r.state), count: num(r.n) }));
  const messagesByFilterReason = (
    await rows(sql`select coalesce(filter_reason, '-') as reason, count(*)::int as n from messages
      where state = 'filtered' and ${inRange("first_seen_at")} group by 1 order by 2 desc, 1`)
  ).map((r) => ({ reason: String(r.reason), count: num(r.n) }));

  const activeDays = (
    await rows(sql`select distinct to_char((created_at at time zone ${opts.zone})::date, 'YYYY-MM-DD') as day
      from task_events where actor = 'user' and ${inRange("created_at")} order by 1`)
  ).map((r) => String(r.day));
  const business: string[] = [];
  for (let d = fromDt.startOf("day"); d <= toDt.startOf("day"); d = d.plus({ days: 1 })) {
    const iso = d.toISODate()!;
    if (isBusinessDay(iso)) business.push(iso);
  }

  return {
    range: { from: opts.from, to: opts.to, zone: opts.zone },
    tasksCreated,
    notATask: { aiCreated, dismissedNotATask, pct: aiCreated ? Math.round((dismissedNotATask / aiCreated) * 1000) / 10 : null },
    aiCompleted: await countEvents("COMPLETE", sql`and e.applied`),
    reopenedAfterAiClose: await countEvents(
      "USER_REOPEN",
      sql`and exists (select 1 from task_events c where c.task_id = e.task_id and c.op = 'COMPLETE' and c.applied and c.created_at < e.created_at)`,
    ),
    merges: await countEvents("USER_MERGE"),
    wouldHaveMissed: await countEvents("USER_WOULD_HAVE_MISSED"),
    manualAdds: await countEvents("USER_CREATE"),
    suggestions,
    extractionCostByDay,
    messagesByState,
    messagesByFilterReason,
    adoption: { businessDays: business.length, activeBusinessDays: activeDays.filter((d) => business.includes(d)).length, activeDays },
  };
}

/** Plain-text rendering for the terminal. */
export function formatKpis(r: KpiReport): string {
  const lines: string[] = [];
  const table = (title: string, head: string[], body: Array<Array<string | number>>) => {
    lines.push("", title);
    if (body.length === 0) {
      lines.push("  (none)");
      return;
    }
    const cells = [head, ...body.map((row) => row.map(String))];
    const widths = head.map((_, i) => Math.max(...cells.map((c) => (c[i] ?? "").length)));
    for (const c of cells) lines.push("  " + c.map((v, i) => v.padEnd(widths[i]!)).join("  ").trimEnd());
  };
  lines.push(`KPIs ${r.range.from} → ${r.range.to} (${r.range.zone})`);
  table("Tasks created (origin / tier)", ["origin", "tier", "count"], r.tasksCreated.map((x) => [x.origin, x.tier, x.count]));
  lines.push(
    "",
    `Dismissed as “Not a task”: ${r.notATask.dismissedNotATask} of ${r.notATask.aiCreated} AI tasks` + (r.notATask.pct === null ? "" : ` (${r.notATask.pct}%)`),
    `AI completions: ${r.aiCompleted} · reopened after AI close: ${r.reopenedAfterAiClose}`,
    `Merges: ${r.merges} · manual adds: ${r.manualAdds} · “I'd have missed this”: ${r.wouldHaveMissed}`,
  );
  table("Suggestions", ["state", "count"], r.suggestions.map((x) => [x.state, x.count]));
  table(
    "Extraction cost per day",
    ["day", "calls", "errors", "usd", "in", "out", "cache_read"],
    r.extractionCostByDay.map((x) => [x.day, x.calls, x.errors, x.costUsd.toFixed(4), x.inputTokens, x.outputTokens, x.cacheReadTokens]),
  );
  table("Messages by state", ["state", "count"], r.messagesByState.map((x) => [x.state, x.count]));
  table("Filtered by reason", ["reason", "count"], r.messagesByFilterReason.map((x) => [x.reason, x.count]));
  lines.push("", `Adoption: user actions on ${r.adoption.activeBusinessDays} of ${r.adoption.businessDays} business days`);
  return lines.join("\n");
}
