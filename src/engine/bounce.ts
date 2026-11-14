import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { messages, taskEvents, taskLinks, tasks } from "../db/schema.js";
import type { BounceInfo } from "../domain/types.js";
import { R } from "./reconcile-reasons.js";

/**
 * A delivery failure for one of the owner's messages: every task that message created or
 * completed goes to review with "⚠️ Not delivered" and a SYSTEM_BOUNCE event (shown in the next report).
 * Idempotent per (task, bounce message). Never reopens or deletes anything by itself.
 */
export async function recordBounce(
  tx: DbOrTx,
  mailboxId: string,
  bounceMessageId: string,
  bounce: BounceInfo,
  now: Date,
): Promise<{ tasksFlagged: number }> {
  if (bounce.action !== "failed" || !bounce.originalMessageId) return { tasksFlagged: 0 };
  const [original] = await tx
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, bounce.originalMessageId)));
  if (!original) return { tasksFlagged: 0 };

  const linked = await tx
    .select({ taskId: taskLinks.taskId })
    .from(taskLinks)
    .where(and(eq(taskLinks.messageId, original.id), inArray(taskLinks.role, ["origin", "completion", "update"])));
  const taskIds = [...new Set(linked.map((l) => l.taskId))];
  let flagged = 0;
  for (const taskId of taskIds) {
    const already = await tx
      .select({ id: taskEvents.id })
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.op, "SYSTEM_BOUNCE"), eq(taskEvents.messageId, bounceMessageId)));
    if (already.length) continue;
    const [task] = await tx
      .update(tasks)
      .set({
        needsReview: true,
        // Scalar text parameter (a JS array would be expanded into a parameter list, not an array literal).
        reviewReasons: sql`case when ${R.BOUNCE}::text = any(${tasks.reviewReasons}) then ${tasks.reviewReasons} else array_append(${tasks.reviewReasons}, ${R.BOUNCE}::text) end`,
        version: sql`${tasks.version} + 1`,
        dormantAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .returning({ id: tasks.id, userId: tasks.userId });
    if (!task) continue;
    await tx.insert(taskEvents).values({
      taskId,
      userId: task.userId,
      mailboxId,
      messageId: bounceMessageId,
      threadId: original.threadId,
      actor: "system",
      op: "SYSTEM_BOUNCE",
      payload: { recipient: bounce.recipient, action: bounce.action, originalMessageId: original.id },
      applied: true,
      reasons: [R.BOUNCE],
      createdAt: now,
    });
    flagged++;
  }
  return { tasksFlagged: flagged };
}

/**
 * Reverse match: a DSN is usually ingested (IDLE, seconds after sending) before the Sent copy is
 * ingested or applied, so at that moment there are no tasks to flag. When a message is applied, the bounces
 * already stored for it are recorded against the tasks it just created/completed/updated. Call inside the apply
 * transaction, after its task_links are written. Idempotent (see {@link recordBounce}).
 */
export async function recordStoredBouncesFor(
  tx: DbOrTx,
  original: { mailboxId: string; messageIdHeader: string | null },
  now: Date,
): Promise<{ tasksFlagged: number }> {
  if (!original.messageIdHeader) return { tasksFlagged: 0 };
  // Served by the partial index messages_bounce_original (mailbox_id, bounce->>'originalMessageId') where filter_reason = 'BOUNCE'.
  const stored = await tx
    .select({ id: messages.id, bounce: messages.bounce })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, original.mailboxId),
        eq(messages.filterReason, "BOUNCE"),
        sql`(${messages.bounce} ->> 'originalMessageId') = ${original.messageIdHeader}`,
      ),
    )
    .orderBy(asc(messages.sortTs), asc(messages.id));
  let flagged = 0;
  for (const b of stored) {
    if (!b.bounce) continue;
    flagged += (await recordBounce(tx, original.mailboxId, b.id, b.bounce, now)).tasksFlagged;
  }
  return { tasksFlagged: flagged };
}
