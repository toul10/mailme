/**
 * Deleting an account (#/admin "Delete"): the person's mailboxes, mail, threads, tasks, reports,
 * sessions and remembered devices go; the security audit keeps only ids and counts. Two steps:
 *
 *   1. stop — committed at once: the account is disabled and signed out, its mailboxes are disabled and their
 *      stored IMAP passwords and ingest tokens are erased. The worker stops picking the mailboxes up.
 *   2. purge — one transaction, only while no sync holds a mailbox ("drain:<id>", src/engine/pipeline.ts);
 *      otherwise nothing is deleted and the caller retries a little later.
 *
 * Backups age out on their own schedule.
 */
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { digests, healthState, mailboxes, messages, sessions, tasks, threads, trustedDevices, users } from "../db/schema.js";

export interface DeletedCounts {
  mailboxes: number;
  messages: number;
  tasks: number;
}

export type DeleteResult = { ok: true; deleted: DeletedCounts } | { ok: false; reason: "syncing" };

export async function stopAccount(db: Db, userId: string, now: Date): Promise<void> {
  await db.update(users).set({ disabledAt: now, setupTokenHash: null, setupExpiresAt: null }).where(eq(users.id, userId));
  await db
    .update(mailboxes)
    .set({ status: "disabled", statusReason: "account_deleted", credentialsSealed: null, credentialsKid: null, ingestTokenHash: null })
    .where(eq(mailboxes.userId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(trustedDevices).where(eq(trustedDevices.userId, userId));
}

export async function purgeAccount(db: Db, userId: string): Promise<DeleteResult> {
  return db.transaction(async (tx) => {
    const boxes = (await tx.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, userId))).map((b) => b.id);
    // A sync in progress holds its mailbox's session lock: never delete under it.
    for (const id of boxes) {
      const r = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`drain:${id}`}, 0)) as ok`);
      const ok = (r.rows[0] as { ok?: boolean } | undefined)?.ok;
      if (!ok) return { ok: false, reason: "syncing" } as const;
    }
    const count = async (q: Promise<unknown[]>) => (await q).length;
    // Tasks first (task_events / task_links cascade); they reference the mailboxes without a cascade.
    const deletedTasks = await count(tx.delete(tasks).where(eq(tasks.userId, userId)).returning({ id: tasks.id }));
    await tx.delete(digests).where(eq(digests.userId, userId));
    let deletedMessages = 0;
    if (boxes.length) {
      // Messages cascade to extractions, labels and locations; mailboxes cascade to folders and login attempts.
      deletedMessages = await count(tx.delete(messages).where(inArray(messages.mailboxId, boxes)).returning({ id: messages.id }));
      await tx.delete(threads).where(inArray(threads.mailboxId, boxes));
      await tx.delete(mailboxes).where(inArray(mailboxes.id, boxes));
      for (const id of boxes) await tx.delete(healthState).where(sql`${healthState.key} like ${`%${id}%`}`);
    }
    // Sessions and trusted devices cascade with the user row.
    await tx.delete(users).where(eq(users.id, userId));
    return { ok: true, deleted: { mailboxes: boxes.length, messages: deletedMessages, tasks: deletedTasks } } as const;
  });
}
