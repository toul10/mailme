import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailboxes, messages, organizations, taskEvents, tasks, threads, users } from "../db/schema.js";
import { activeRule, normalizeRules, type MailRule } from "../domain/rules.js";
import type { Clock, Logger } from "../domain/types.js";
import { domainOf } from "../lib/text.js";
import { senderAuthFailed } from "../mail/prefilter.js";
import { hasReplyOrForwardPrefix, isForwardSubject } from "../mail/subject.js";
import { isInternalDomain, threadFamily } from "./db-util.js";
import { diffSnapshots, expirePendingSuggestions } from "./db-events.js";
import type { TaskRow } from "./tasks.js";

/** Messages that count as an answer: real mail that reached (or is queued for) the AI — not out-of-office, bulk, spam … */
const ANSWER_STATES = ["pending", "extracted", "applied", "failed"] as const;

/**
 * The owner's «answered» rule (src/domain/rules.ts): an open request of the owner's (ACTION_REQUIRED, owner ME) is
 * completed by the system once someone at the organization answers it in the thread — the owner (a self-copy or a
 * Sent copy) or a colleague (an internal domain) — and the daily report lists it under "Answered".
 *
 * An answer is a reply (RE:, the Greek ΑΠ:, or In-Reply-To), never a forward: a colleague forwarding the request to
 * the owner (FW:, the Greek ΠΡ:) hands it over. It comes after the task's origin message, from someone other than
 * the requester, in a thread linked with more than LOW confidence, and not from a forged own-domain sender
 * (SpamAssassin saw no SPF pass or aligned DKIM). A task the owner reopened after such a close, or whose status they
 * locked, stays theirs.
 *
 * Runs inside the mailbox's drain lock (src/engine/pipeline.ts), so it never races apply; it also catches up on
 * answers that arrived before the rule existed.
 */
export async function closeAnsweredTasks(
  deps: { db: Db; clock: Clock; log: Logger },
  mailboxId: string,
  /** dryRun: plan only. rules: use these instead of the stored ones (a what-if before rules:import; implies dryRun). */
  opts: { dryRun?: boolean; rules?: MailRule[] } = {},
): Promise<{ closed: number; planned: Array<{ taskId: string; ref: number; title: string; by: string | null }> }> {
  const { db } = deps;
  const [ctx] = await db
    .select({ userId: mailboxes.userId, address: mailboxes.address, aliases: mailboxes.aliases, internalDomains: organizations.internalDomains, mailRules: users.mailRules })
    .from(mailboxes)
    .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(eq(mailboxes.id, mailboxId));
  if (!ctx || !activeRule(opts.rules ?? normalizeRules(ctx.mailRules).rules, "answered")) return { closed: 0, planned: [] };
  const dryRun = opts.dryRun || !!opts.rules;
  const owners = [ctx.address, ...ctx.aliases].map((a) => a.trim().toLowerCase()).filter(Boolean);
  const internal = (ctx.internalDomains ?? []).map((d) => d.toLowerCase());
  const ours = (address: string | null) => {
    const a = address?.trim().toLowerCase() ?? "";
    return !!a && (owners.includes(a) || isInternalDomain(domainOf(a), internal));
  };

  const open = await db
    .select({ task: tasks, origin: { id: messages.id, sortTs: messages.sortTs, threadId: messages.threadId, from: messages.fromAddress } })
    .from(tasks)
    .innerJoin(messages, eq(messages.id, tasks.originMessageId))
    .where(
      and(
        eq(tasks.mailboxId, mailboxId),
        eq(tasks.userId, ctx.userId),
        eq(tasks.status, "ACTION_REQUIRED"),
        eq(tasks.ownerKind, "ME"),
        isNull(tasks.mergedIntoId),
        isNotNull(messages.threadId),
      ),
    );

  let closed = 0;
  const planned: Array<{ taskId: string; ref: number; title: string; by: string | null }> = [];
  for (const { task: t, origin } of open) {
    if (t.lockedFields.includes("status")) continue;
    const [before] = await db.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.taskId, t.id), eq(taskEvents.op, "SYSTEM_ANSWERED"))).limit(1);
    if (before) continue;
    const [thread] = await db.select({ linkConfidence: threads.linkConfidence }).from(threads).where(eq(threads.id, origin.threadId!));
    if (thread?.linkConfidence === "LOW") continue;
    const family = await threadFamily(db, origin.threadId);
    const later = await db
      .select({ id: messages.id, from: messages.fromAddress, name: messages.fromName, subject: messages.subject, inReplyTo: messages.inReplyTo, headers: messages.headers, threadId: messages.threadId, sortTs: messages.sortTs })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          inArray(messages.threadId, family),
          gt(messages.sortTs, origin.sortTs),
          ne(messages.id, origin.id),
          inArray(messages.state, [...ANSWER_STATES]),
        ),
      )
      .orderBy(asc(messages.sortTs))
      .limit(50);
    const requester = origin.from?.trim().toLowerCase() ?? "";
    const answer = later.find((m) => ours(m.from) && m.from!.trim().toLowerCase() !== requester && isAnswer(m.subject, m.inReplyTo) && !senderAuthFailed(m.headers));
    if (!answer) continue;
    planned.push({ taskId: t.id, ref: t.ref, title: t.title, by: answer.from?.toLowerCase() ?? null });
    if (!dryRun && (await closeAsAnswered(db, deps.clock.now(), t, answer))) closed++;
  }
  if (closed) deps.log.info({ mailboxId, closed }, "answered tasks completed");
  return { closed, planned };
}

/** A reply, not a forward. «ΠΡ:» (Greek Outlook's forward) is not in src/mail/subject.ts's prefix list, so it is checked here. */
function isAnswer(subject: string, inReplyTo: string | null): boolean {
  if (isForwardSubject(subject) || /^\s*πρ\s*[:：]/iu.test(subject)) return false;
  return !!inReplyTo || hasReplyOrForwardPrefix(subject);
}

async function closeAsAnswered(
  db: Db,
  now: Date,
  t: TaskRow,
  answer: { id: string; from: string | null; name: string | null; threadId: string | null; sortTs: Date },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(tasks).where(eq(tasks.id, t.id)).for("update");
    // Changed since it was read (a user action, an apply): leave it for the next drain.
    if (!cur || cur.status !== "ACTION_REQUIRED" || cur.version !== t.version || cur.mergedIntoId) return false;
    const patch: Partial<TaskRow> = {
      status: "COMPLETED",
      closedBy: "system",
      closedAt: answer.sortTs,
      snoozedUntil: null,
      snoozeMode: null,
      needsReview: false,
      reviewReasons: [],
    };
    await expirePendingSuggestions(tx, cur.id);
    await tx
      .update(tasks)
      .set({ ...patch, version: sql`${tasks.version} + 1`, updatedAt: now })
      .where(eq(tasks.id, cur.id));
    const { before, after } = diffSnapshots(cur, patch);
    await tx.insert(taskEvents).values({
      taskId: cur.id,
      userId: cur.userId,
      mailboxId: cur.mailboxId,
      messageId: answer.id,
      threadId: answer.threadId,
      actor: "system",
      op: "SYSTEM_ANSWERED",
      before,
      after,
      payload: { by: answer.from?.toLowerCase() ?? null, name: answer.name },
      applied: true,
      reasons: [],
      createdAt: now,
    });
    return true;
  });
}
