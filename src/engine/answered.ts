import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import type { Db } from "../db/client.js";
import { extractions, mailboxes, messages, organizations, taskEvents, tasks, threads, users } from "../db/schema.js";
import { activeRule, normalizeRules, type MailRule } from "../domain/rules.js";
import type { Address, Clock, Logger } from "../domain/types.js";
import { PUBLIC_MAIL_DOMAINS, domainOf, normalizeMessageId } from "../lib/text.js";
import { senderAuthFailed } from "../mail/prefilter.js";
import { hasReplyOrForwardPrefix, isForwardLike } from "../mail/subject.js";
import { isInternalDomain, threadFamily } from "./db-util.js";
import { diffSnapshots, expirePendingSuggestions } from "./db-events.js";
import type { TaskRow } from "./tasks.js";

/** Mail that reached (or is queued for) the AI — not out-of-office, bulk, spam … */
const ANSWER_STATES = ["pending", "extracted", "applied", "failed"] as const;

/** What the sweep does to one task. */
export type AnsweredKind = "answered" | "forwarded" | "handed_over";

export interface AnsweredPlan {
  taskId: string;
  ref: number;
  title: string;
  kind: AnsweredKind;
  /** Who wrote the mail that did it. */
  by: string | null;
  /** forwarded: the rule's target. handed_over: the colleague who has it now. */
  to: string | null;
}

/**
 * What the thread itself says about the owner's open requests (ACTION_REQUIRED). It reads only mail from the
 * organization (the owner or an internal domain) that came after the task's origin message, in the same thread:
 *
 *  - answered (the owner's "answered" rule, src/domain/rules.ts): someone at the organization replied (RE:, the
 *    Greek ΑΠ:, or In-Reply-To; never a forward, never the requester). The task is completed by the system and the
 *    daily report lists it under "Answered".
 *  - forwarded: a task the forward rule made ("Forward to <target>: …") is completed once a mail in the thread
 *    involves the target (To, Cc or From): the order has reached it. Needs no "answered" rule: it is what the task
 *    asks for.
 *  - handed over (with the "answered" rule): the owner forwarded the request to a colleague (every To recipient is
 *    at the organization). The task stays open and becomes the colleague's ("Handled by …", tab "Colleagues");
 *    it is completed when someone at the organization then replies to the requester's side. A forward the AI still
 *    has to read waits for it, and one the AI acted on is left to the AI (prompt "Hand-over to a colleague").
 *
 * Mail that the owner's own ignore rule set aside counts too (filter reason RULE: the owner's reply with the orders
 * address in Cc is still a reply). Out-of-office, bulk and spam never count, nor does a forged own-domain sender
 * (SpamAssassin saw no SPF pass or aligned DKIM).
 *
 * A thread joined by subject alone (LOW link confidence) may hold another conversation: there only a mail that names
 * the origin message in its In-Reply-To or References counts.
 *
 * A task the owner reopened after the system completed it, or whose status they locked, stays theirs; so does the
 * owner of a task they set by hand. Runs inside the mailbox's drain lock (src/engine/pipeline.ts), so it never races
 * apply; it also catches up on mail that arrived before the rule existed.
 */
export async function closeAnsweredTasks(
  deps: { db: Db; clock: Clock; log: Logger },
  mailboxId: string,
  /** dryRun: plan only. rules: use these instead of the stored ones (a what-if before rules:import; implies dryRun). */
  opts: { dryRun?: boolean; rules?: MailRule[] } = {},
): Promise<{ closed: number; handedOver: number; planned: AnsweredPlan[] }> {
  const { db } = deps;
  const nothing = { closed: 0, handedOver: 0, planned: [] };
  const [ctx] = await db
    .select({ userId: mailboxes.userId, address: mailboxes.address, aliases: mailboxes.aliases, internalDomains: organizations.internalDomains, zone: organizations.timezone, mailRules: users.mailRules })
    .from(mailboxes)
    .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
    .innerJoin(users, eq(users.id, mailboxes.userId))
    .where(eq(mailboxes.id, mailboxId));
  if (!ctx) return nothing;
  const rules = opts.rules ?? normalizeRules(ctx.mailRules).rules;
  const answeredOn = !!activeRule(rules, "answered");
  // A forward rule that was switched off still says where its old tasks wanted the mail to go.
  const forwardRules = rules.filter((r) => r.kind === "forward" && r.target);
  if (!answeredOn && !forwardRules.length) return nothing;
  const dryRun = opts.dryRun || !!opts.rules;
  const owners = [ctx.address, ...ctx.aliases].map(lower).filter(Boolean);
  const internal = (ctx.internalDomains ?? []).map((d) => d.toLowerCase());
  const isOwner = (address: string | null | undefined) => owners.includes(lower(address));
  const ours = (address: string | null | undefined) => isOwner(address) || isInternalDomain(domainOf(lower(address)), internal);

  const open = await db
    .select({
      task: tasks,
      origin: {
        id: messages.id,
        sortTs: messages.sortTs,
        threadId: messages.threadId,
        from: messages.fromAddress,
        replyTo: messages.replyTo,
        messageKey: messages.messageKey,
        messageIdHeader: messages.messageIdHeader,
      },
      madeBy: { model: extractions.model, request: extractions.request },
    })
    .from(tasks)
    .innerJoin(messages, eq(messages.id, tasks.originMessageId))
    .leftJoin(extractions, eq(extractions.id, messages.appliedExtractionId))
    .where(
      and(
        eq(tasks.mailboxId, mailboxId),
        eq(tasks.userId, ctx.userId),
        eq(tasks.status, "ACTION_REQUIRED"),
        inArray(tasks.ownerKind, ["ME", "INTERNAL"]),
        isNull(tasks.mergedIntoId),
        isNotNull(messages.threadId),
      ),
    )
    .orderBy(asc(tasks.ref));

  let closed = 0;
  let handedOver = 0;
  const planned: AnsweredPlan[] = [];
  for (const { task: t, origin, madeBy } of open) {
    if (t.lockedFields.includes("status")) continue;
    const system = await db
      .select({ op: taskEvents.op, messageId: taskEvents.messageId })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, t.id), inArray(taskEvents.op, ["SYSTEM_ANSWERED", "SYSTEM_FORWARDED"])));
    // Completed by the system once and open again: the owner reopened it. Theirs from now on.
    if (system.some((e) => e.op === "SYSTEM_ANSWERED")) continue;
    const handOver = system.find((e) => e.op === "SYSTEM_FORWARDED") ?? null;
    // A colleague's task is ours to watch only when this sweep handed it over.
    if (t.ownerKind === "INTERNAL" && !handOver) continue;
    const forwardTo = t.ownerKind === "ME" ? forwardTarget(forwardRules, madeBy, t.title) : null;
    if (!answeredOn && !forwardTo) continue;

    const [thread] = await db.select({ linkConfidence: threads.linkConfidence }).from(threads).where(eq(threads.id, origin.threadId!));
    const lowLink = thread?.linkConfidence === "LOW";
    const family = await threadFamily(db, origin.threadId);
    const later = await db
      .select({
        id: messages.id,
        from: messages.fromAddress,
        name: messages.fromName,
        to: messages.to,
        cc: messages.cc,
        subject: messages.subject,
        inReplyTo: messages.inReplyTo,
        references: messages.references,
        headers: messages.headers,
        threadId: messages.threadId,
        sortTs: messages.sortTs,
        state: messages.state,
      })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          inArray(messages.threadId, family),
          gt(messages.sortTs, origin.sortTs),
          ne(messages.id, origin.id),
          or(inArray(messages.state, [...ANSWER_STATES]), and(eq(messages.state, "filtered"), eq(messages.filterReason, "RULE"))),
        ),
      )
      .orderBy(asc(messages.sortTs))
      .limit(50);
    const originIds = new Set([origin.messageKey, normalizeMessageId(origin.messageIdHeader)].filter((x): x is string => !!x));
    const namesOrigin = (m: (typeof later)[number]) => [m.inReplyTo, ...m.references].some((x) => originIds.has(normalizeMessageId(x) ?? ""));
    const fromUs = later.filter((m) => ours(m.from) && !senderAuthFailed(m.headers) && (!lowLink || namesOrigin(m)));
    const requester = lower(origin.from);
    const recipients = (m: (typeof later)[number]) => [...m.to, ...m.cc].map((a: Address) => lower(a.address)).filter(Boolean);

    // 1. The forward rule's task: the mail has reached the rule's target.
    const reached = forwardTo ? fromUs.find((m) => lower(m.from) === forwardTo || recipients(m).includes(forwardTo)) : undefined;
    if (reached && forwardTo) {
      planned.push({ taskId: t.id, ref: t.ref, title: t.title, kind: "forwarded", by: lower(reached.from) || null, to: forwardTo });
      if (!dryRun && (await closeAsAnswered(db, deps.clock.now(), t, reached, { forwardedTo: forwardTo }))) closed++;
      continue;
    }
    if (!answeredOn) continue;

    // 2. Someone at the organization replied. Once the owner has forwarded the request to a colleague — recorded by
    //    an earlier sweep, or seen now — only a reply to the requester's side counts: the colleague's "ok, I will call
    //    them" to the owner answers nobody. So the result is the same whether the mails are read one by one or all
    //    at once.
    const forward = handOver
      ? later.find((m) => m.id === handOver.messageId)
      : fromUs.find((m) => isOwner(m.from) && isForwardLike(m.subject) && colleagueOf(m, isOwner, ours) !== null);
    const sides = [requester, lower(t.counterpartyAddress), ...origin.replyTo.map((a: Address) => lower(a.address))].filter(Boolean);
    const counts = (m: (typeof later)[number]) => {
      if (!forward) return handOver ? reaches(recipients(m), sides, internal) : true;
      if (m.sortTs.getTime() <= forward.sortTs.getTime()) return !handOver;
      return reaches(recipients(m), sides, internal);
    };
    const answer = fromUs.find((m) => lower(m.from) !== requester && isAnswer(m.subject, m.inReplyTo) && counts(m));
    if (answer) {
      planned.push({ taskId: t.id, ref: t.ref, title: t.title, kind: "answered", by: lower(answer.from) || null, to: null });
      if (!dryRun && (await closeAsAnswered(db, deps.clock.now(), t, answer, {}))) closed++;
      continue;
    }

    // 3. The owner forwarded the request to a colleague: theirs now, still open.
    if (handOver || t.ownerKind !== "ME" || t.lockedFields.includes("owner")) continue;
    // Still in the AI's queue: wait, so the two never hand the same request over twice.
    if (!forward || forward.state === "pending" || forward.state === "extracted") continue;
    // The AI read the forward and acted on it itself (a new task for the colleague, a question on this one).
    const [byAi] = await db
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(and(eq(taskEvents.messageId, forward.id), eq(taskEvents.actor, "ai"), or(eq(taskEvents.taskId, t.id), and(eq(taskEvents.op, "CREATE"), eq(taskEvents.applied, true)))))
      .limit(1);
    if (byAi) continue;
    const colleague = colleagueOf(forward, isOwner, ours)!;
    planned.push({ taskId: t.id, ref: t.ref, title: t.title, kind: "handed_over", by: lower(forward.from) || null, to: colleague.address });
    if (!dryRun && (await handOverTo(db, deps.clock.now(), t, forward, colleague, ctx.zone))) handedOver++;
  }
  if (closed || handedOver) deps.log.info({ mailboxId, closed, handedOver }, "answered tasks completed");
  return { closed, handedOver, planned };
}

const lower = (s: string | null | undefined): string => s?.trim().toLowerCase() ?? "";

/** A reply, not a forward (src/mail/subject.ts isForwardLike also knows ΠΡ:, the forward prefix of Greek Outlook). */
function isAnswer(subject: string, inReplyTo: string | null): boolean {
  if (isForwardLike(subject)) return false;
  return !!inReplyTo || hasReplyOrForwardPrefix(subject);
}

/**
 * One of the requester's side is among the recipients: the origin mail's sender or Reply-To, the task's counterparty,
 * or someone else at their company's domain (never a free-mail domain, never the organization's own).
 */
function reaches(recipients: readonly string[], sides: readonly string[], internal: readonly string[]): boolean {
  const domains = new Set(sides.map((a) => domainOf(a)).filter((d): d is string => !!d && !PUBLIC_MAIL_DOMAINS.has(d) && !isInternalDomain(d, internal)));
  return recipients.some((a) => sides.includes(a) || domains.has(domainOf(a) ?? ""));
}

/**
 * The colleague a forward hands the request to: the first To recipient, when every To recipient (the owner's own
 * addresses aside) is at the organization. A forward to a supplier or back to a customer hands nothing over.
 */
function colleagueOf(m: { to: Address[] }, isOwner: (a: string) => boolean, ours: (a: string) => boolean): { address: string; name: string | null } | null {
  const to = m.to.map((a) => ({ address: lower(a.address), name: a.name?.trim() || null })).filter((a) => a.address && !isOwner(a.address));
  return to.length && to.every((a) => ours(a.address)) ? to[0]! : null;
}

/**
 * The target of the forward rule that made this task, or null for any other task. The stored extraction says so
 * (model "rules", request.rule = the rule's id); once retention has purged the request, the title does
 * ("Forward to <target>: …", src/ai/rules-extractor.ts).
 */
function forwardTarget(forwardRules: readonly MailRule[], madeBy: { model: string | null; request: unknown } | null, title: string): string | null {
  if (madeBy?.model !== "rules" || !forwardRules.length) return null;
  const id = madeBy.request && typeof madeBy.request === "object" ? (madeBy.request as { rule?: unknown }).rule : null;
  const rule = forwardRules.find((r) => r.id === id) ?? forwardRules.find((r) => title.toLowerCase().includes(r.target!));
  return rule?.target ?? null;
}

type Mail = { id: string; from: string | null; name: string | null; threadId: string | null; sortTs: Date };

async function closeAsAnswered(db: Db, now: Date, t: TaskRow, answer: Mail, extra: { forwardedTo?: string }): Promise<boolean> {
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
      payload: { by: answer.from?.toLowerCase() ?? null, name: answer.name, ...(extra.forwardedTo ? { forwardedTo: extra.forwardedTo } : {}) },
      applied: true,
      reasons: [],
      createdAt: now,
    });
    return true;
  });
}

/** The task becomes the colleague's (ownerKind INTERNAL, "Handled by …") and stays open. */
async function handOverTo(db: Db, now: Date, t: TaskRow, forward: Mail, colleague: { address: string; name: string | null }, zone: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(tasks).where(eq(tasks.id, t.id)).for("update");
    if (!cur || cur.status !== "ACTION_REQUIRED" || cur.ownerKind !== "ME" || cur.version !== t.version || cur.mergedIntoId || cur.lockedFields.includes("owner")) return false;
    const patch: Partial<TaskRow> = { ownerKind: "INTERNAL", ownerAddress: colleague.address, ownerName: colleague.name };
    await tx
      .update(tasks)
      .set({ ...patch, version: sql`${tasks.version} + 1`, lastActivityAt: forward.sortTs > cur.lastActivityAt ? forward.sortTs : cur.lastActivityAt, updatedAt: now })
      .where(eq(tasks.id, cur.id));
    const { before, after } = diffSnapshots(cur, patch);
    await tx.insert(taskEvents).values({
      taskId: cur.id,
      userId: cur.userId,
      mailboxId: cur.mailboxId,
      messageId: forward.id,
      threadId: forward.threadId,
      actor: "system",
      op: "SYSTEM_FORWARDED",
      before,
      after,
      // on: the forward's day in the organization's timezone (null for an invalid zone), for the history line.
      payload: { by: forward.from?.toLowerCase() ?? null, name: forward.name, to: colleague.address, toName: colleague.name, at: forward.sortTs.toISOString(), on: DateTime.fromJSDate(forward.sortTs, { zone }).toISODate() },
      applied: true,
      reasons: [],
      createdAt: now,
    });
    return true;
  });
}
