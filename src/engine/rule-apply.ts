import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, taskEvents, tasks, users } from "../db/schema.js";
import { ignoreRuleFor, normalizeRules, topicText, type MailRule } from "../domain/rules.js";
import { OPEN_STATUSES } from "../domain/types.js";
import { diffSnapshots, expirePendingSuggestions } from "./db-events.js";
import type { TaskRow } from "./tasks.js";

export interface RuleDismissal {
  taskId: string;
  mailboxId: string | null;
  ref: number;
  title: string;
  ruleId: string;
}

/**
 * Open tasks of the user whose origin mail one of their ignore rules (src/domain/rules.ts) covers: mail the
 * pre-filter would now stop, from before the rule existed. Same match as the pre-filter: subject + new/forwarded
 * text (stored segments), To/Cc. Nothing is written.
 */
export async function planRuleDismissals(db: Db, userId: string, override?: MailRule[]): Promise<RuleDismissal[]> {
  const [u] = await db.select({ mailRules: users.mailRules }).from(users).where(eq(users.id, userId));
  const rules = (override ?? normalizeRules(u?.mailRules).rules).filter((r) => r.enabled && r.kind === "ignore");
  if (!rules.length) return [];
  const rows = await db
    .select({ taskId: tasks.id, mailboxId: tasks.mailboxId, ref: tasks.ref, title: tasks.title, subject: messages.subject, segments: messages.segments, to: messages.to, cc: messages.cc })
    .from(tasks)
    .innerJoin(messages, eq(messages.id, tasks.originMessageId))
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES]), isNull(tasks.mergedIntoId), isNotNull(tasks.originMessageId)))
    .orderBy(tasks.ref);
  const out: RuleDismissal[] = [];
  for (const r of rows) {
    const text = r.segments.filter((s) => s.kind === "NEW" || s.kind === "FORWARDED").map((s) => s.text).join("\n");
    const rule = ignoreRuleFor(rules, { folded: topicText(r.subject, text), recipients: [...r.to, ...r.cc].map((a) => a.address) });
    if (rule) out.push({ taskId: r.taskId, mailboxId: r.mailboxId, ref: r.ref, title: r.title, ruleId: rule.id });
  }
  return out;
}

/**
 * Dismisses planned tasks as the system (DISMISSED, op SYSTEM_RULE_DISMISS with the rule id), one transaction
 * each. A task that changed meanwhile (closed, merged, its status locked by the user) is left alone.
 */
export async function applyRuleDismissals(db: Db, list: readonly RuleDismissal[], now: Date): Promise<number> {
  let done = 0;
  for (const d of list) {
    const ok = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(tasks).where(eq(tasks.id, d.taskId)).for("update");
      if (!cur || !(OPEN_STATUSES as readonly string[]).includes(cur.status) || cur.mergedIntoId || cur.lockedFields.includes("status")) return false;
      const patch: Partial<TaskRow> = { status: "DISMISSED", closedBy: "system", closedAt: now, snoozedUntil: null, snoozeMode: null, needsReview: false, reviewReasons: [] };
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
        actor: "system",
        op: "SYSTEM_RULE_DISMISS",
        before,
        after,
        payload: { rule: d.ruleId },
        applied: true,
        reasons: [],
        createdAt: now,
      });
      return true;
    });
    if (ok) done++;
  }
  return done;
}
