import { sql, type SQL } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { securityAudit } from "../db/schema.js";
import { DIGEST_LEASE_PREFIX } from "../digest/dispatch.js";

/**
 * Nightly retention purge. Every step is a single idempotent statement keyed on `now`, so a
 * re-run the same night changes nothing, and a crash between steps loses nothing.
 *
 * `messages.updated_at` is deliberately left alone: for a parked (failed) message it is the parked time, which the
 * report uses to list each parked message once (src/digest/freshness.ts recentParkedSql).
 */

export type RetentionConfig = Pick<Config, "BODY_RETENTION_DAYS" | "CLOSED_TASK_RETENTION_DAYS">;

/** Fixed windows from the plan's retention table. */
export const RETENTION = {
  /** Metadata of messages that no task references: filtered/skipped/own rows are deleted, analysed/parked rows blanked. */
  unlinkedMessageMetadataDays: 90,
  /** Digest HTML/text; afterwards ids and sections only. */
  digestBodyDays: 90,
  loginAttemptDays: 90,
  /** Expired one-click nonces are kept a week (replay diagnostics), then deleted. */
  expiredNonceGraceDays: 7,
  securityAuditDays: 365,
  /** Leftover digest delivery leases / retry timers (src/digest/dispatch.ts); only the current day's matter. */
  digestLeaseDays: 2,
} as const;

export interface RetentionReport {
  /** Message text/HTML/segments dropped after BODY_RETENTION_DAYS. */
  bodiesPurged: number;
  /** PERSONAL/SPAM-classified or deny-listed messages: bodies dropped at once. */
  sensitiveBodiesPurged: number;
  /** …and the body copies of those messages in extractions (request/output/handle map), also at once. */
  sensitiveExtractionsPurged: number;
  /** …and their evidence in task events: logged-only candidates deleted, quotes/payloads of task-bound ones dropped. */
  sensitiveEventsPurged: number;
  /** Extraction request/output/handle map dropped (usage and cost kept). */
  extractionsPurged: number;
  /** AI candidates that never became a task (tier=logged) — they carry evidence quotes. */
  orphanEventsDeleted: number;
  digestsPurged: number;
  messagesDeleted: number;
  /** Analysed (applied) and parked (failed) messages no task references: subject, addresses, headers, attachment names blanked. */
  metadataPurged: number;
  threadsDeleted: number;
  tasksDeleted: number;
  noncesDeleted: number;
  loginAttemptsDeleted: number;
  sessionsDeleted: number;
  trustedDevicesDeleted: number;
  auditRowsDeleted: number;
  digestLeasesDeleted: number;
}

const QUEUE_STATES = sql`('pending','extracted')`;
/** Messages whose content must not outlive their processing: the predicate on a `messages m` row. */
const SENSITIVE = sql`(m.classification in ('PERSONAL','SPAM') or m.filter_reason = 'DENYLIST') and m.state not in ${QUEUE_STATES}`;

export async function runRetention(db: Db, now: Date, config: RetentionConfig): Promise<RetentionReport> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const bodyCutoff = daysAgo(config.BODY_RETENTION_DAYS);
  const metaCutoff = daysAgo(RETENTION.unlinkedMessageMetadataDays);
  const closedCutoff = daysAgo(config.CLOSED_TASK_RETENTION_DAYS);

  const count = async (statement: SQL): Promise<number> => {
    const res = await db.execute(sql`with affected as (${statement}) select count(*)::int as n from affected`);
    return Number((res.rows[0] as { n: number | string } | undefined)?.n ?? 0);
  };

  // Bodies are needed until the message leaves the queue; a stuck queue is a health alert, not a purge.
  const bodiesPurged = await count(sql`
    update messages set text_plain = null, text_html = null, segments = '[]'::jsonb, calendar = null,
      body_purged_at = ${now}
    where body_purged_at is null and first_seen_at < ${bodyCutoff} and state not in ${QUEUE_STATES}
    returning 1`);

  const sensitiveBodiesPurged = await count(sql`
    update messages m set text_plain = null, text_html = null, segments = '[]'::jsonb, calendar = null,
      body_purged_at = ${now}
    where m.body_purged_at is null and ${SENSITIVE}
    returning 1`);

  // The rendered extraction input (request) is a copy of the body; output and handle map carry quotes and names.
  const sensitiveExtractionsPurged = await count(sql`
    update extractions e set request = null, output = null, handle_map = null, purged_at = ${now}
    where e.purged_at is null
      and exists (select 1 from messages m where m.id = e.message_id and ${SENSITIVE})
    returning 1`);

  const sensitiveOrphans = await count(sql`
    delete from task_events e
    where e.task_id is null and exists (select 1 from messages m where m.id = e.message_id and ${SENSITIVE})
    returning 1`);
  // Rare (the AI classified the message PERSONAL/SPAM yet a task references it): keep the event, drop its quotes.
  const sensitiveBound = await count(sql`
    update task_events e set evidence_quote = null, evidence_norm = null, payload = null
    where e.task_id is not null
      and (e.evidence_quote is not null or e.evidence_norm is not null or e.payload is not null)
      and exists (select 1 from messages m where m.id = e.message_id and ${SENSITIVE})
    returning 1`);
  const sensitiveEventsPurged = sensitiveOrphans + sensitiveBound;

  const extractionsPurged = await count(sql`
    update extractions e set request = null, output = null, handle_map = null, purged_at = ${now}
    where e.purged_at is null and e.created_at < ${bodyCutoff}
      and not exists (select 1 from messages m where m.id = e.message_id and m.state in ${QUEUE_STATES})
    returning 1`);

  const orphanEventsDeleted = await count(sql`
    delete from task_events where task_id is null and created_at < ${bodyCutoff} returning 1`);

  const digestsPurged = await count(sql`
    update digests set html = null, text = null, purged_at = ${now}
    where purged_at is null and created_at < ${daysAgo(RETENTION.digestBodyDays)}
    returning 1`);

  // Closed tasks (and merged-away duplicates) past retention; events and links cascade.
  const tasksToDelete = sql`
    select id from tasks
    where (status in ('COMPLETED','DISMISSED') and closed_at is not null and closed_at < ${closedCutoff})
       or (merged_into_id is not null and coalesce(closed_at, updated_at) < ${closedCutoff})`;
  await db.execute(sql`delete from action_nonces where task_id in (${tasksToDelete})`);
  const tasksDeleted = await count(sql`delete from tasks where id in (${tasksToDelete}) returning 1`);

  /** No task references the message: by link (message or its thread), task-bound event, or origin. */
  const unreferenced = sql`
    not exists (select 1 from task_links l where l.message_id = m.id)
    and not exists (select 1 from task_links l where m.thread_id is not null and l.thread_id = m.thread_id)
    and not exists (select 1 from task_events e where e.message_id = m.id and e.task_id is not null)
    and not exists (select 1 from tasks t where t.origin_message_id = m.id)`;

  const messagesDeleted = await count(sql`
    delete from messages m
    where m.state in ('filtered','skipped_old','own_mail') and m.first_seen_at < ${metaCutoff}
      and not exists (select 1 from task_links l where l.message_id = m.id)
      and not exists (select 1 from task_events e where e.message_id = m.id and e.task_id is not null)
    returning 1`);

  // Analysed-but-unlinked (FYI, logged-only candidates …) and parked messages: the row stays — its extractions
  // (usage/cost for the KPIs) and audit labels cascade on delete, and the dedup key (message_key) keeps a re-listed
  // message from being ingested again — but subject, addresses, headers and attachment names go.
  const metadataPurged = await count(sql`
    update messages m set subject = '', subject_norm = '', from_address = null, from_name = null,
      "to" = '[]'::jsonb, cc = '[]'::jsonb, bcc = '[]'::jsonb, reply_to = '[]'::jsonb, headers = '{}'::jsonb,
      attachments = '[]'::jsonb, "references" = '{}'::text[], in_reply_to = null, thread_index = null
    where m.state in ('applied','failed') and m.first_seen_at < ${metaCutoff}
      and (m.subject <> '' or m.subject_norm <> '' or m.from_address is not null or m.from_name is not null
        or m."to" <> '[]'::jsonb or m.cc <> '[]'::jsonb or m.bcc <> '[]'::jsonb or m.reply_to <> '[]'::jsonb
        or m.headers <> '{}'::jsonb or m.attachments <> '[]'::jsonb or cardinality(m."references") > 0
        or m.in_reply_to is not null or m.thread_index is not null)
      and ${unreferenced}
    returning 1`);

  const threadsDeleted = await count(sql`
    delete from threads t
    where t.created_at < ${metaCutoff}
      and not exists (select 1 from messages m where m.thread_id = t.id)
      and not exists (select 1 from task_links l where l.thread_id = t.id)
      and not exists (select 1 from task_events e where e.thread_id = t.id)
      and not exists (select 1 from threads t2 where t2.merged_into_id = t.id)
    returning 1`);

  const noncesDeleted = await count(sql`
    delete from action_nonces where expires_at < ${daysAgo(RETENTION.expiredNonceGraceDays)} returning 1`);
  const loginAttemptsDeleted = await count(sql`
    delete from mailbox_login_attempts where at < ${daysAgo(RETENTION.loginAttemptDays)} returning 1`);
  const sessionsDeleted = await count(sql`delete from sessions where expires_at < ${now} returning 1`);
  const trustedDevicesDeleted = await count(sql`delete from trusted_devices where expires_at < ${now} returning 1`);
  const auditRowsDeleted = await count(sql`
    delete from security_audit where created_at < ${daysAgo(RETENTION.securityAuditDays)} returning 1`);
  const digestLeasesDeleted = await count(sql`
    delete from app_state where key like ${`${DIGEST_LEASE_PREFIX}%`} and updated_at < ${daysAgo(RETENTION.digestLeaseDays)} returning 1`);

  const report: RetentionReport = {
    bodiesPurged,
    sensitiveBodiesPurged,
    sensitiveExtractionsPurged,
    sensitiveEventsPurged,
    extractionsPurged,
    orphanEventsDeleted,
    digestsPurged,
    messagesDeleted,
    metadataPurged,
    threadsDeleted,
    tasksDeleted,
    noncesDeleted,
    loginAttemptsDeleted,
    sessionsDeleted,
    trustedDevicesDeleted,
    auditRowsDeleted,
    digestLeasesDeleted,
  };
  if (Object.values(report).some((n) => n > 0)) {
    await db.insert(securityAudit).values({ event: "retention_purge", detail: { ...report }, createdAt: now });
  }
  return report;
}
