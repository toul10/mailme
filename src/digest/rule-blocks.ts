import { and, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { mailboxes, messages, taskEvents, tasks, users } from "../db/schema.js";
import { activeRule, mentionsTopic, normalizeRules, topicText } from "../domain/rules.js";
import { OPEN_STATUSES } from "../domain/types.js";
import { senderAuthFailed } from "../mail/prefilter.js";
import { hasReplyOrForwardPrefix, normalizeSubject } from "../mail/subject.js";
import type { DigestRuleBlocks } from "./model.js";
import { cleanText, sanitizeAiText } from "./sanitize.js";

/** "Updates" listed by name; the rest are counted. */
export const UPDATES_CAP = 10;
/** "Answered" listed by name; the rest are counted. */
export const ANSWERED_CAP = 10;
/** "Forwarded to a colleague" listed by name; the rest are counted. */
export const HANDED_OVER_CAP = 10;

/**
 * The report's blocks that come from the owner's own rules (src/domain/rules.ts) — "Summary" (summary),
 * "Answered" and "Forwarded to a colleague" (answered), "Updates" (updates) — for what happened since the previous
 * report (`since`).
 * undefined when the owner has none of these rules: the report is then exactly what it was without rules.
 */
export async function buildRuleBlocks(db: Db, p: { userId: string; since: Date; openTotal: number }): Promise<DigestRuleBlocks | undefined> {
  const [u] = await db.select({ mailRules: users.mailRules }).from(users).where(eq(users.id, p.userId));
  const rules = normalizeRules(u?.mailRules).rules;
  const summaryRule = activeRule(rules, "summary");
  const answeredRule = activeRule(rules, "answered");
  const updatesRule = activeRule(rules, "updates");
  if (!summaryRule && !answeredRule && !updatesRule) return undefined;

  const boxes = await db.select({ id: mailboxes.id, address: mailboxes.address, aliases: mailboxes.aliases }).from(mailboxes).where(eq(mailboxes.userId, p.userId));
  const mbIds = boxes.map((b) => b.id);
  const owners = boxes.flatMap((b) => [b.address, ...b.aliases]).map((a) => a.trim().toLowerCase()).filter(Boolean);

  // "Answered": tasks the answered rule completed since the last report and nobody reopened since.
  const answered: DigestRuleBlocks["answered"] = [];
  let answeredTotal = 0;
  if (answeredRule || summaryRule) {
    const rows = await db
      .select({ taskId: tasks.id, ref: tasks.ref, title: tasks.title, payload: taskEvents.payload })
      .from(taskEvents)
      .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
      .where(and(eq(tasks.userId, p.userId), eq(taskEvents.op, "SYSTEM_ANSWERED"), gte(taskEvents.createdAt, p.since), eq(tasks.status, "COMPLETED"), eq(tasks.closedBy, "system")))
      .orderBy(tasks.ref);
    answeredTotal = rows.length;
    if (answeredRule) {
      for (const r of rows.slice(0, ANSWERED_CAP)) {
        const pl = (r.payload ?? {}) as { by?: unknown; name?: unknown; forwardedTo?: unknown };
        const by = typeof pl.name === "string" && pl.name.trim() ? pl.name : typeof pl.by === "string" ? pl.by : null;
        const target = typeof pl.forwardedTo === "string" ? cleanText(pl.forwardedTo, 80) : "";
        answered.push({ taskId: r.taskId, ref: r.ref, title: sanitizeAiText(r.title, 160), by: by ? cleanText(by, 80) : null, ...(target ? { forwardedTo: target } : {}) });
      }
    }
  }

  // "Forwarded to a colleague": requests the sweep handed over since the last report and that are still the
  // colleague's and open. Colleagues' tasks appear in no other part of the report, so this is said once.
  const handedOver: DigestRuleBlocks["handedOver"] = [];
  let handedOverTotal = 0;
  if (answeredRule) {
    const rows = await db
      .select({ taskId: tasks.id, ref: tasks.ref, title: tasks.title, payload: taskEvents.payload })
      .from(taskEvents)
      .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
      .where(
        and(
          eq(tasks.userId, p.userId),
          eq(taskEvents.op, "SYSTEM_FORWARDED"),
          gte(taskEvents.createdAt, p.since),
          eq(tasks.ownerKind, "INTERNAL"),
          inArray(tasks.status, [...OPEN_STATUSES]),
          isNull(tasks.mergedIntoId),
        ),
      )
      .orderBy(tasks.ref);
    handedOverTotal = rows.length;
    for (const r of rows.slice(0, HANDED_OVER_CAP)) {
      const pl = (r.payload ?? {}) as { to?: unknown; toName?: unknown };
      const to = typeof pl.toName === "string" && pl.toName.trim() ? pl.toName : typeof pl.to === "string" ? pl.to : null;
      handedOver.push({ taskId: r.taskId, ref: r.ref, title: sanitizeAiText(r.title, 160), to: to ? cleanText(to, 80) : null });
    }
  }

  // "Updates": the owner's own new mail (not a reply or forward) about the rule's topics. Self-copies count only
  // when not forged (a phishing "From: you" is filtered before, and SpamAssassin's verdict is checked here).
  const updates: DigestRuleBlocks["updates"] = [];
  let updatesTotal = 0;
  if (updatesRule && mbIds.length && owners.length) {
    const rows = await db
      .select({ subject: messages.subject, to: messages.to, cc: messages.cc, headers: messages.headers, sortTs: messages.sortTs, direction: messages.direction, claims: messages.claimsOwnerSender })
      .from(messages)
      .where(
        and(
          inArray(messages.mailboxId, mbIds),
          gte(messages.firstSeenAt, p.since),
          inArray(sql`lower(${messages.fromAddress})`, owners),
          ne(messages.state, "own_mail"),
          sql`coalesce(${messages.filterReason}, '') not in ('PHISHING', 'SPAM_FOLDER', 'DRAFT_OR_DELETED', 'DENYLIST')`,
        ),
      )
      .orderBy(desc(messages.sortTs));
    const seen = new Set<string>();
    for (const m of rows) {
      if (m.direction !== "OUTBOUND" && !m.claims) continue;
      if (hasReplyOrForwardPrefix(m.subject) || /^\s*πρ\s*[:：]/iu.test(m.subject)) continue; // "ΠΡ:" is the Greek "Fwd:"
      const folded = topicText(m.subject);
      if (!mentionsTopic(folded, updatesRule.topics) || mentionsTopic(folded, updatesRule.except) || senderAuthFailed(m.headers)) continue;
      const key = normalizeSubject(m.subject);
      if (seen.has(key)) continue;
      seen.add(key);
      updatesTotal++;
      if (updates.length >= UPDATES_CAP) continue;
      const recipients = new Set([...m.to, ...m.cc].map((a) => a.address.toLowerCase()).filter((a) => !owners.includes(a)));
      updates.push({ subject: cleanText(m.subject, 120) || "(no subject)", recipients: recipients.size, at: m.sortTs });
    }
  }

  let summary: DigestRuleBlocks["summary"] = null;
  if (summaryRule) {
    const count = async (where: ReturnType<typeof and>) => Number((await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(where))[0]?.n ?? 0);
    const received = mbIds.length
      ? await count(and(inArray(messages.mailboxId, mbIds), gte(messages.firstSeenAt, p.since), eq(messages.direction, "INBOUND"), eq(messages.claimsOwnerSender, false), notInArray(messages.state, ["own_mail"])))
      : 0;
    const ignored = mbIds.length ? await count(and(inArray(messages.mailboxId, mbIds), gte(messages.firstSeenAt, p.since), eq(messages.filterReason, "RULE"))) : 0;
    const [{ n: newTasks } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.userId, p.userId), gte(tasks.createdAt, p.since)));
    summary = { received, newTasks: Number(newTasks), answered: answeredTotal, updates: updatesTotal, ignored, openTotal: p.openTotal };
  }

  return {
    summary,
    answered: answeredRule ? answered : [],
    answeredMore: answeredRule ? Math.max(0, answeredTotal - answered.length) : 0,
    handedOver,
    handedOverMore: Math.max(0, handedOverTotal - handedOver.length),
    updates,
    updatesMore: Math.max(0, updatesTotal - updates.length),
  };
}
