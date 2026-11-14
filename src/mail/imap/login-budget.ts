import { and, desc, gt, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { mailboxes, mailboxLoginAttempts } from "../../db/schema.js";

/**
 * Host-wide login budget for API-initiated logins. The shared host counts failed logins per client IP —
 * the platform's one IP — across every account on it: ~5 failures ban the IP, which stops sync and report delivery
 * for every mailbox on that host. So the budget is keyed by the IMAP host, not by mailbox row or username (a member
 * could otherwise multiply a per-row budget by creating rows, or aim other rows at a colleague's username).
 *
 * Same thresholds as the CLI's loginBudgetProblem (src/cli/commands/mailbox.ts): at most 2 auth failures per hour, and
 * nothing within 15 minutes of a "too many connections" answer. It is persistent (mailbox_login_attempts), so it
 * survives API restarts and counts the worker's and the CLI's failures too.
 */
export const HOST_AUTH_FAILURES_PER_HOUR = 2;
const HOUR_MS = 3_600_000;
const TOO_MANY_WINDOW_MS = 15 * 60_000;

export type HostBudget = { ok: true } | { ok: false; retryAfterSec: number; reason: "auth_failures" | "too_many" };

export async function hostLoginBudget(db: DbOrTx, imapHost: string, now: Date): Promise<HostBudget> {
  const nowMs = now.getTime();
  const rows = await db
    .select({ at: mailboxLoginAttempts.at, outcome: mailboxLoginAttempts.outcome })
    .from(mailboxLoginAttempts)
    .innerJoin(mailboxes, sql`${mailboxes.id} = ${mailboxLoginAttempts.mailboxId}`)
    .where(
      and(
        sql`lower(${mailboxes.imapHost}) = ${imapHost.toLowerCase()}`,
        gt(mailboxLoginAttempts.at, new Date(nowMs - HOUR_MS)),
        inArray(mailboxLoginAttempts.outcome, ["auth_failed", "too_many"]),
      ),
    )
    .orderBy(desc(mailboxLoginAttempts.at))
    .limit(50);

  const seconds = (untilMs: number) => Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
  const tooMany = rows.find((r) => r.outcome === "too_many" && nowMs - r.at.getTime() < TOO_MANY_WINDOW_MS);
  if (tooMany) return { ok: false, reason: "too_many", retryAfterSec: seconds(tooMany.at.getTime() + TOO_MANY_WINDOW_MS) };
  const failures = rows.filter((r) => r.outcome === "auth_failed");
  if (failures.length >= HOST_AUTH_FAILURES_PER_HOUR) {
    // Newest first: the budget frees up once the limit-th newest failure has left the one-hour window.
    const gate = failures[HOST_AUTH_FAILURES_PER_HOUR - 1]!;
    return { ok: false, reason: "auth_failures", retryAfterSec: seconds(gate.at.getTime() + HOUR_MS) };
  }
  return { ok: true };
}
