import { statfs, stat } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { healthState } from "../db/schema.js";
import { effectiveDigestStart, loadShadowWeeks, SMTP_UNKNOWN } from "../digest/dispatch.js";
import { GLOBAL_PAUSE_KEY, type Logger } from "../domain/types.js";
import { greekHolidays, isBusinessDay } from "../lib/dates.js";
import { nullLogger } from "../lib/log.js";
import { errorCode, sendAlert, type Alert, type AlertSeverity } from "./alerts.js";

/**
 * Health checks, run every 5 minutes by the worker. Each check yields results keyed
 * "<family>:<scope>"; `health_state` de-duplicates them: one alert when a key enters `alerting`, a
 * "resolved" note when it returns to ok, and a reminder every 6 h while it stays alerting.
 * Alert texts contain ids and counts only — never subjects, addresses or other email content.
 */

export const HEALTH_THRESHOLDS = {
  syncStaleMin: 30,
  oldestPendingMin: 60,
  extractionFailureRate: 0.1,
  /** Below this many extraction calls today the failure rate is not meaningful. */
  extractionMinCalls: 10,
  /** Digest must be delivered this long after the user's digest_time (07:30 → 07:45). */
  digestGraceMin: 15,
  diskUsedRatio: 0.8,
  diskCriticalRatio: 0.9,
  backupMaxAgeHours: 26,
  quotaUsedRatio: 0.8,
  realertMs: 6 * 3_600_000,
} as const;

export { GLOBAL_PAUSE_KEY };

export const CHECK_FAMILIES = [
  "sync_stale",
  "queue_stale",
  "extraction_failures",
  "mailbox_status",
  "folder_failing",
  "ai_paused",
  "ai_global_pause",
  "digest_missing",
  "ai_spend",
  "quota",
  "disk",
  "backup",
] as const;
export type CheckFamily = (typeof CHECK_FAMILIES)[number] | "check_error";

export interface CheckResult {
  key: string;
  family: CheckFamily;
  ok: boolean;
  severity: AlertSeverity;
  title: string;
  body: string;
  detail: Record<string, unknown>;
}

export interface HealthDeps {
  db: Db;
  log?: Logger;
  config: Pick<Config, "DEFAULT_TIMEZONE" | "AI_DAILY_CALL_CAP" | "AI_DAILY_USD_CAP" | "ALERT_WEBHOOK_URL">;
  /** Alert sink; defaults to sendAlert(config, …). Returns false when delivery failed (retried next run). */
  alert?(alert: Alert): Promise<boolean>;
  /** Directory whose filesystem is checked for free space; null skips the disk check. */
  dataDir?: string | null;
  /** File touched after each successful backup (BACKUP_MARKER_FILE); null skips the backup check. */
  backupMarkerFile?: string | null;
  statfs?(path: string): Promise<{ blocks: number; bavail: number }>;
  /** mtime of a file, or null when it does not exist. */
  fileMtime?(path: string): Promise<Date | null>;
}

export interface HealthRunReport {
  results: CheckResult[];
  alerted: string[];
  reminded: string[];
  resolved: string[];
  /** Families whose evaluation threw (reported as check_error:<family>). */
  failedFamilies: string[];
}

const shortId = (id: string) => id.slice(0, 8);
const minutesBetween = (a: number, b: number) => Math.max(0, Math.floor((b - a) / 60_000));

interface MailboxRow {
  id: string;
  provider: string;
  status: string;
  aiPaused: boolean;
  aiPausedReason: string | null;
  callCap: number | null;
  usdCap: number | null;
  probe: Record<string, unknown> | null;
  createdMs: number;
  lastSyncMs: number | null;
  timezone: string;
}

/** Evaluate every check without touching health_state or sending anything. */
export async function evaluateHealth(deps: HealthDeps, now: Date): Promise<{ results: CheckResult[]; failedFamilies: string[] }> {
  const results: CheckResult[] = [];
  const failedFamilies: string[] = [];
  const log = deps.log ?? nullLogger;
  const nowMs = now.getTime();

  const run = async (families: CheckFamily[], fn: () => Promise<CheckResult[]>) => {
    try {
      results.push(...(await fn()));
    } catch (err) {
      log.error({ families, code: errorCode(err) }, "health check failed");
      failedFamilies.push(...families);
    }
  };

  await run(["sync_stale", "queue_stale", "extraction_failures", "mailbox_status", "folder_failing", "ai_paused", "ai_spend", "quota"], async () => {
    const mailboxes = await loadMailboxes(deps.db);
    const out: Array<CheckResult | null> = [];
    const queue = await loadQueueStats(deps.db, now);
    const failing = await loadFailingFolders(deps.db);
    const paused = await isGloballyPaused(deps.db);
    for (const mb of mailboxes) {
      out.push(syncCheck(mb, nowMs));
      out.push(queueCheck(mb, queue.get(mb.id), nowMs, paused));
      out.push(statusCheck(mb));
      out.push(folderCheck(mb, failing.get(mb.id) ?? 0));
      out.push(aiPausedCheck(mb));
      const today = await loadTodayUsage(deps.db, mb, now);
      out.push(failureCheck(mb, today));
      out.push(spendCheck(mb, today, deps.config));
      out.push(quotaCheck(mb));
    }
    return out.filter((r): r is CheckResult => r !== null);
  });

  await run(["ai_global_pause"], async () => [globalPauseCheck(await loadGlobalPause(deps.db))]);
  await run(["digest_missing"], () => digestChecks(deps.db, now));
  if (deps.dataDir) await run(["disk"], async () => [await diskCheck(deps, deps.dataDir!)]);
  if (deps.backupMarkerFile) await run(["backup"], async () => [await backupCheck(deps, deps.backupMarkerFile!, nowMs)]);

  for (const family of failedFamilies) {
    results.push({
      key: `check_error:${family}`,
      family: "check_error",
      ok: false,
      severity: "warning",
      title: `MailMe: health check "${family}" failed to run`,
      body: `The ${family} check threw an error; see the worker log. Its previous state is kept.`,
      detail: { family },
    });
  }
  return { results, failedFamilies };
}

/** Evaluate, de-duplicate against health_state and send alerts / resolutions. Never throws on alert delivery. */
export async function runHealthChecks(deps: HealthDeps, now: Date): Promise<HealthRunReport> {
  const log = deps.log ?? nullLogger;
  const sink = deps.alert ?? ((a: Alert) => sendAlert(deps.config, a, { log }));
  const alert = async (a: Alert): Promise<boolean> => {
    try {
      return await sink(a);
    } catch (err) {
      log.warn({ code: errorCode(err) }, "alert sink failed");
      return false;
    }
  };
  const { results, failedFamilies } = await evaluateHealth(deps, now);
  const report: HealthRunReport = { results, alerted: [], reminded: [], resolved: [], failedFamilies };

  const states = new Map((await deps.db.select().from(healthState)).map((s) => [s.key, s]));
  const seen = new Set<string>();

  for (const r of results) {
    seen.add(r.key);
    const prev = states.get(r.key);
    if (r.ok) {
      if (prev?.status === "alerting") {
        await resolve(r.key, prev.since, r.detail);
      }
      continue;
    }
    if (!prev || prev.status === "ok") {
      const sent = await alert({ title: r.title, body: r.body, severity: r.severity });
      await upsertState(r.key, "alerting", now, sent ? now : null, r.detail);
      if (sent) report.alerted.push(r.key);
      continue;
    }
    const due = !prev.lastAlertAt || now.getTime() - prev.lastAlertAt.getTime() >= HEALTH_THRESHOLDS.realertMs;
    if (due) {
      const since = minutesBetween(prev.since.getTime(), now.getTime());
      const sent = await alert({ title: `${r.title} (still, ${formatDuration(since)})`, body: r.body, severity: r.severity });
      if (sent) report.reminded.push(r.key);
      await upsertState(r.key, "alerting", prev.since, sent ? now : prev.lastAlertAt, r.detail);
    } else {
      await upsertState(r.key, "alerting", prev.since, prev.lastAlertAt, r.detail);
    }
  }

  // Keys of families that ran but produced no result (mailbox removed, next day, …) are resolved.
  const failed = new Set<string>(failedFamilies);
  for (const [key, prev] of states) {
    if (prev.status !== "alerting" || seen.has(key)) continue;
    const family = familyOf(key);
    if (failed.has(family)) continue;
    if (family !== "check_error" && !isKnownFamily(family)) continue;
    if ((family === "disk" && !deps.dataDir) || (family === "backup" && !deps.backupMarkerFile)) continue;
    await resolve(key, prev.since, { stale: true });
  }
  return report;

  async function resolve(key: string, since: Date, detail: Record<string, unknown>) {
    const mins = minutesBetween(since.getTime(), now.getTime());
    await alert({ title: `MailMe resolved: ${key}`, body: `Back to normal after ${formatDuration(mins)}.`, severity: "info" });
    await upsertState(key, "ok", now, null, detail);
    report.resolved.push(key);
  }

  async function upsertState(key: string, status: "ok" | "alerting", since: Date, lastAlertAt: Date | null, detail: Record<string, unknown>) {
    await deps.db
      .insert(healthState)
      .values({ key, status, since, lastAlertAt, detail })
      .onConflictDoUpdate({ target: healthState.key, set: { status, since, lastAlertAt, detail } });
  }
}

function familyOf(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? key : key.slice(0, i);
}

function isKnownFamily(f: string): boolean {
  return (CHECK_FAMILIES as readonly string[]).includes(f);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

async function loadMailboxes(db: Db): Promise<MailboxRow[]> {
  const res = await db.execute(sql`
    select m.id, m.provider, m.status, m.ai_paused as "aiPaused", m.ai_paused_reason as "aiPausedReason",
      m.ai_daily_call_cap as "callCap", m.ai_daily_usd_cap::float8 as "usdCap", m.probe,
      (extract(epoch from m.created_at) * 1000)::float8 as "createdMs",
      (extract(epoch from m.last_sync_at) * 1000)::float8 as "lastSyncMs",
      o.timezone
    from mailboxes m
    join organizations o on o.id = m.org_id
    join users u on u.id = m.user_id
    where m.status <> 'disabled' and u.disabled_at is null
    order by m.created_at`);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    provider: String(r.provider),
    status: String(r.status),
    aiPaused: r.aiPaused === true,
    aiPausedReason: (r.aiPausedReason as string | null) ?? null,
    callCap: r.callCap === null || r.callCap === undefined ? null : Number(r.callCap),
    usdCap: r.usdCap === null || r.usdCap === undefined ? null : Number(r.usdCap),
    probe: (r.probe as Record<string, unknown> | null) ?? null,
    createdMs: Number(r.createdMs),
    lastSyncMs: r.lastSyncMs === null || r.lastSyncMs === undefined ? null : Number(r.lastSyncMs),
    timezone: String(r.timezone || "Europe/Athens"),
  }));
}

interface QueueStats {
  oldestMs: number | null;
  pending: number;
  backfillPending: number;
  lastProgressMs: number | null;
}

async function loadQueueStats(db: Db, now: Date): Promise<Map<string, QueueStats>> {
  const res = await db.execute(sql`
    select mailbox_id as "mailboxId", count(*)::int as pending,
      count(*) filter (where backfill)::int as "backfillPending",
      (extract(epoch from min(first_seen_at)) * 1000)::float8 as "oldestMs"
    from messages where state in ('pending','extracted') group by mailbox_id`);
  const progress = await db.execute(sql`
    select mailbox_id as "mailboxId", (extract(epoch from max(created_at)) * 1000)::float8 as "lastMs"
    from extractions where created_at > ${new Date(now.getTime() - 86_400_000)} and created_at <= ${now}
    group by mailbox_id`);
  const last = new Map((progress.rows as Array<{ mailboxId: string; lastMs: number | string }>).map((r) => [String(r.mailboxId), Number(r.lastMs)]));
  const out = new Map<string, QueueStats>();
  for (const r of res.rows as Array<{ mailboxId: string; pending: number | string; backfillPending: number | string; oldestMs: number | string | null }>) {
    out.set(String(r.mailboxId), {
      pending: Number(r.pending),
      backfillPending: Number(r.backfillPending),
      oldestMs: r.oldestMs === null ? null : Number(r.oldestMs),
      lastProgressMs: last.get(String(r.mailboxId)) ?? null,
    });
  }
  return out;
}

interface TodayUsage {
  calls: number;
  errors: number;
  usd: number;
}

async function loadTodayUsage(db: Db, mb: MailboxRow, now: Date): Promise<TodayUsage> {
  const dayStart = DateTime.fromJSDate(now, { zone: mb.timezone }).startOf("day").toJSDate();
  const res = await db.execute(sql`
    select count(*)::int as calls, count(*) filter (where status = 'error')::int as errors,
      coalesce(sum(cost_usd), 0)::float8 as usd
    from extractions where mailbox_id = ${mb.id} and created_at >= ${dayStart} and created_at <= ${now}`);
  const r = res.rows[0] as { calls: number | string; errors: number | string; usd: number | string } | undefined;
  return { calls: Number(r?.calls ?? 0), errors: Number(r?.errors ?? 0), usd: Math.round(Number(r?.usd ?? 0) * 1e6) / 1e6 };
}

async function loadGlobalPause(db: Db): Promise<unknown> {
  const res = await db.execute(sql`select value from app_state where key = ${GLOBAL_PAUSE_KEY}`);
  const row = res.rows[0] as { value: unknown } | undefined;
  return row ? row.value : null;
}

async function isGloballyPaused(db: Db): Promise<boolean> {
  return isPauseValue(await loadGlobalPause(db));
}

/** Same reading as the pipeline: absent / null / false / { paused: false } = not paused. */
export function isPauseValue(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  return !(typeof v === "object" && (v as { paused?: unknown }).paused === false);
}

// ── Checks (pure given the loaded rows) ─────────────────────────────────────

function result(family: CheckFamily, scope: string | null, ok: boolean, severity: AlertSeverity, title: string, body: string, detail: Record<string, unknown>): CheckResult {
  return { key: scope ? `${family}:${scope}` : `${family}:global`, family, ok, severity, title, body, detail };
}

function syncCheck(mb: MailboxRow, nowMs: number): CheckResult | null {
  if (mb.provider !== "imap" || mb.status !== "active") return null;
  const ref = mb.lastSyncMs ?? mb.createdMs;
  const age = minutesBetween(ref, nowMs);
  const ok = age <= HEALTH_THRESHOLDS.syncStaleMin;
  const last = mb.lastSyncMs === null ? "never completed" : `${formatDuration(age)} ago`;
  return result("sync_stale", mb.id, ok, "warning", `MailMe: mailbox sync is stale (mailbox ${shortId(mb.id)})`,
    `Last full sync cycle: ${last} (threshold ${HEALTH_THRESHOLDS.syncStaleMin} min). Mailbox id ${mb.id}.`, { ageMin: age, neverSynced: mb.lastSyncMs === null });
}

function queueCheck(mb: MailboxRow, q: QueueStats | undefined, nowMs: number, globallyPaused: boolean): CheckResult | null {
  // Paused / failed mailboxes and the global pause have their own alerts; the queue waiting behind them is expected.
  if (mb.status !== "active" || mb.aiPaused || globallyPaused) return null;
  const oldestAge = q?.oldestMs == null ? 0 : minutesBetween(q.oldestMs, nowMs);
  const sinceProgress = q?.lastProgressMs == null ? null : minutesBetween(q.lastProgressMs, nowMs);
  // During backfill the queue is legitimately hours deep; only a stalled backfill (no AI call for 60 min) alerts.
  const backfilling = (q?.backfillPending ?? 0) > 0;
  const stalled = sinceProgress === null || sinceProgress > HEALTH_THRESHOLDS.oldestPendingMin;
  const ok = oldestAge <= HEALTH_THRESHOLDS.oldestPendingMin || (backfilling && !stalled);
  return result("queue_stale", mb.id, ok, "warning", `MailMe: analysis queue is behind (mailbox ${shortId(mb.id)})`,
    `Oldest pending message waits ${formatDuration(oldestAge)} (threshold ${HEALTH_THRESHOLDS.oldestPendingMin} min). ` +
      `Pending: ${q?.pending ?? 0} (backfill ${q?.backfillPending ?? 0}). Last AI call: ${sinceProgress === null ? "none in 24 h" : `${formatDuration(sinceProgress)} ago`}. Mailbox id ${mb.id}.`,
    { oldestMin: oldestAge, pending: q?.pending ?? 0, backfillPending: q?.backfillPending ?? 0, sinceProgressMin: sinceProgress });
}

function statusCheck(mb: MailboxRow): CheckResult {
  const bad = mb.status === "auth_failed" || mb.status === "blocked";
  const hint = mb.status === "auth_failed"
    ? "Login was rejected; there are no automatic retries. Re-enter the password with `pnpm cli mailbox:add` (same user/address)."
    : "The server blocked the connection. Check the provider ban/allowlist, then `pnpm cli mailbox:resume`.";
  return result("mailbox_status", mb.id, !bad, "critical", `MailMe: mailbox ${mb.status} (mailbox ${shortId(mb.id)})`,
    `${hint} Mailbox id ${mb.id}.`, { status: mb.status });
}

/** Folders excluded from the settle check after repeated EXAMINE/STATUS/SEARCH failures (src/mail/imap/sync.ts). */
const FOLDER_FAILING_AFTER = 3;

async function loadFailingFolders(db: Db): Promise<Map<string, number>> {
  const res = await db.execute(sql`
    select mailbox_id, count(*)::int as n from mailbox_folders
    where sync_enabled and not private and gone_at is null and consecutive_failures >= ${FOLDER_FAILING_AFTER}
    group by mailbox_id`);
  return new Map((res.rows as Array<{ mailbox_id: string; n: number }>).map((r) => [r.mailbox_id, Number(r.n)]));
}

function folderCheck(mb: MailboxRow, failing: number): CheckResult | null {
  if (mb.provider !== "imap" || mb.status !== "active") return null;
  // Folder names can be customer names: the alert carries only the count; `pnpm cli mailbox:folders` shows which.
  return result("folder_failing", mb.id, failing === 0, "warning", `MailMe: ${failing} folder(s) keep failing (mailbox ${shortId(mb.id)})`,
    `${failing} synced folder(s) failed ${FOLDER_FAILING_AFTER}+ cycles in a row and are skipped; mail filed there is not analysed. ` +
      `Check with \`pnpm cli mailbox:folders --mailbox ${mb.id}\` and disable or fix the folder. Mailbox id ${mb.id}.`, { failing });
}

function aiPausedCheck(mb: MailboxRow): CheckResult {
  const reason = (mb.aiPausedReason ?? "manual").slice(0, 40);
  return result("ai_paused", mb.id, !mb.aiPaused, "warning", `MailMe: AI paused for mailbox ${shortId(mb.id)}`,
    `Reason code: ${reason}. Budget pauses clear at local midnight; otherwise \`pnpm cli mailbox:resume\`. Mailbox id ${mb.id}.`, { reason });
}

function failureCheck(mb: MailboxRow, t: TodayUsage): CheckResult {
  const rate = t.calls > 0 ? t.errors / t.calls : 0;
  const ok = t.calls < HEALTH_THRESHOLDS.extractionMinCalls || rate <= HEALTH_THRESHOLDS.extractionFailureRate;
  return result("extraction_failures", mb.id, ok, "warning", `MailMe: extraction failures ${Math.round(rate * 100)}% today (mailbox ${shortId(mb.id)})`,
    `${t.errors} of ${t.calls} extraction calls failed today (threshold ${HEALTH_THRESHOLDS.extractionFailureRate * 100}%). Mailbox id ${mb.id}.`,
    { calls: t.calls, errors: t.errors });
}

function spendCheck(mb: MailboxRow, t: TodayUsage, cfg: HealthDeps["config"]): CheckResult {
  const usdCap = mb.usdCap ?? cfg.AI_DAILY_USD_CAP;
  const callCap = mb.callCap ?? cfg.AI_DAILY_CALL_CAP;
  const ok = t.usd < usdCap && t.calls < callCap;
  return result("ai_spend", mb.id, ok, "warning", `MailMe: daily AI budget reached (mailbox ${shortId(mb.id)})`,
    `Today: $${t.usd.toFixed(2)} of $${usdCap.toFixed(2)}, ${t.calls} of ${callCap} calls. Mailbox id ${mb.id}.`,
    { usd: t.usd, usdCap, calls: t.calls, callCap });
}

function quotaCheck(mb: MailboxRow): CheckResult | null {
  const q = mb.probe?.quota as { usedKb?: unknown; limitKb?: unknown } | null | undefined;
  const used = Number(q?.usedKb);
  const limit = Number(q?.limitKb);
  if (!q || !Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const ratio = used / limit;
  return result("quota", mb.id, ratio <= HEALTH_THRESHOLDS.quotaUsedRatio, "warning", `MailMe: mailbox quota ${Math.round(ratio * 100)}% (mailbox ${shortId(mb.id)})`,
    `Server storage ${Math.round(used / 1024)} MB of ${Math.round(limit / 1024)} MB (as of the last probe). Mailbox id ${mb.id}.`, { usedKb: used, limitKb: limit });
}

function globalPauseCheck(value: unknown): CheckResult {
  const paused = isPauseValue(value);
  const reason = typeof value === "object" && value && typeof (value as { reason?: unknown }).reason === "string" ? String((value as { reason: string }).reason).slice(0, 40) : "unknown";
  return result("ai_global_pause", null, !paused, "critical", "MailMe: AI analysis paused for ALL mailboxes",
    `A global error (e.g. API key, billing or a code bug) paused extraction without consuming messages. Reason code: ${reason}. ` +
      "Fix the cause, then `pnpm cli ai:resume`.", { reason });
}

async function digestChecks(db: Db, now: Date): Promise<CheckResult[]> {
  const res = await db.execute(sql`
    select u.id, u.digest_time as "digestTime", u.digest_start_date::text as "startDate", o.timezone,
      o.holy_spirit_holiday as "holySpirit"
    from users u join organizations o on o.id = u.org_id
    where u.digest_enabled and u.disabled_at is null
      and exists (select 1 from mailboxes m where m.user_id = u.id and m.status not in ('setup','disabled'))`);
  const rows = res.rows as Array<{ id: string; digestTime: string; startDate: string | null; timezone: string; holySpirit: boolean }>;
  // Same start rule as the dispatcher: no report (so nothing missing) during the shadow week.
  const shadow = rows.some((u) => !u.startDate) ? await loadShadowWeeks(db, rows.map((u) => String(u.id))) : new Map();
  const out: CheckResult[] = [];
  for (const u of rows) {
    const zone = u.timezone || "Europe/Athens";
    const local = DateTime.fromJSDate(now, { zone });
    const date = local.toISODate()!;
    const holidays = (y: number) => greekHolidays(y, { includeHolySpirit: u.holySpirit === true });
    if (!isBusinessDay(date, holidays)) continue;
    const startDate = effectiveDigestStart(u.startDate, shadow.get(String(u.id)), zone);
    if (startDate && startDate > date) continue;
    const [h, m] = (u.digestTime || "07:30").split(":").map(Number);
    const deadline = local.set({ hour: h ?? 7, minute: m ?? 30, second: 0, millisecond: 0 }).plus({ minutes: HEALTH_THRESHOLDS.digestGraceMin });
    if (local < deadline) continue;
    const d = await db.execute(sql`select status, last_error as "lastError" from digests where user_id = ${u.id} and local_date = ${date}::date`);
    const row = d.rows[0] as { status: string; lastError: string | null } | undefined;
    const status = row?.status ?? "none";
    // last_error is a short code (never content), e.g. auth, Error:ETIMEDOUT, smtp_unknown.
    const code = row?.lastError && /^[A-Za-z0-9_.:-]{1,60}$/.test(row.lastError) ? row.lastError : null;
    const hint =
      code === SMTP_UNKNOWN
        ? ` The SMTP submission was interrupted and may have gone out; it is not resent automatically. Check the user's inbox, then \`pnpm cli digest:send-now --user ${u.id} --retry\` if it did not arrive.`
        : "";
    out.push(result("digest_missing", u.id, status === "delivered", "warning", `MailMe: daily report not delivered (user ${shortId(String(u.id))})`,
      `Report for ${date} is "${status}"${code ? ` (${code})` : ""} at ${local.toFormat("HH:mm")} (${zone}); expected by ${deadline.toFormat("HH:mm")}. User id ${u.id}.${hint}`,
      { date, status, ...(code ? { code } : {}) }));
  }
  return out;
}

async function diskCheck(deps: HealthDeps, dir: string): Promise<CheckResult> {
  const fsStat = await (deps.statfs ?? statfs)(dir);
  const blocks = Number(fsStat.blocks);
  const ratio = blocks > 0 ? 1 - Number(fsStat.bavail) / blocks : 0;
  const pct = Math.round(ratio * 100);
  return result("disk", null, ratio <= HEALTH_THRESHOLDS.diskUsedRatio, ratio > HEALTH_THRESHOLDS.diskCriticalRatio ? "critical" : "warning",
    `MailMe: disk ${pct}% full`, `The filesystem holding the data directory is ${pct}% used (threshold ${HEALTH_THRESHOLDS.diskUsedRatio * 100}%).`, { usedPct: pct });
}

async function backupCheck(deps: HealthDeps, marker: string, nowMs: number): Promise<CheckResult> {
  const mtime = await (deps.fileMtime ?? defaultMtime)(marker);
  const ageH = mtime ? Math.floor((nowMs - mtime.getTime()) / 3_600_000) : null;
  const ok = ageH !== null && ageH <= HEALTH_THRESHOLDS.backupMaxAgeHours;
  return result("backup", null, ok, "warning", "MailMe: backup is overdue",
    ageH === null ? "No backup marker found; no successful backup is recorded." : `Last successful backup ${ageH} h ago (threshold ${HEALTH_THRESHOLDS.backupMaxAgeHours} h).`,
    { ageHours: ageH });
}

async function defaultMtime(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return null;
  }
}
