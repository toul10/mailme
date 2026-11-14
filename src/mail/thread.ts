import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client.js";
import { mailboxes, messages, taskEvents, taskLinks, threads } from "../db/schema.js";
import type { LinkConfidence } from "../domain/types.js";
import { normalizeMessageId } from "../lib/text.js";
import { isGenericSubject, normalizeSubject } from "./subject.js";

export interface ThreadKeyInput {
  messageKey: string;
  inReplyTo: string | null;
  references: string[];
  threadIndex: string | null;
  subject: string;
  participants: string[];
  sortTs: Date;
}

/** Subject-only links must fall inside this window around the thread's messages. */
export const SUBJECT_LINK_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const RANK: Record<LinkConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const weakest = (a: LinkConfidence, b: LinkConfidence): LinkConfidence => (RANK[a] <= RANK[b] ? a : b);

/**
 * References/In-Reply-To → Thread-Index root → subject+participants+window. Threads are merge-only.
 *
 * - Header links (either direction: our parents, or children that arrived first) → HIGH. Several threads found →
 *   merged into the oldest (messages, task_links and task_events are re-pointed; losers get merged_into_id).
 * - Same Thread-Index root → MEDIUM. Same normalized, non-generic subject with a shared non-owner participant
 *   within ±30 days → LOW. The thread's link_confidence keeps the weakest link seen.
 * The caller's message row must not carry thread_id yet (it is excluded from the lookups by messageKey).
 */
export async function resolveThread(db: DbOrTx, mailboxId: string, msg: ThreadKeyInput): Promise<{ threadId: string; linkConfidence: LinkConfidence; created: boolean }> {
  const key = msg.messageKey;
  const ids = [...new Set([...msg.references, msg.inReplyTo].map((x) => normalizeMessageId(x)).filter((x): x is string => !!x && x !== key))];
  const conversationKey = threadIndexRoot(msg.threadIndex);
  const subjectNorm = normalizeSubject(msg.subject);

  // 1. Header links, both directions.
  const found = new Set<string>();
  if (ids.length) {
    const rows = await db
      .selectDistinct({ threadId: messages.threadId })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          isNotNull(messages.threadId),
          ne(messages.messageKey, key),
          or(inArray(messages.messageKey, ids), inArray(messages.messageIdHeader, ids)),
        ),
      );
    rows.forEach((r) => r.threadId && found.add(r.threadId));
  }
  if (!key.startsWith("h:")) {
    const rows = await db
      .selectDistinct({ threadId: messages.threadId })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          isNotNull(messages.threadId),
          ne(messages.messageKey, key),
          or(eq(messages.inReplyTo, key), sql`${key} = any(${messages.references})`),
        ),
      );
    rows.forEach((r) => r.threadId && found.add(r.threadId));
  }
  if (found.size) {
    const roots = new Set<string>();
    for (const id of found) roots.add(await rootOf(db, id));
    const survivor = await mergeThreads(db, [...roots]);
    await joinThread(db, survivor, msg.sortTs, "HIGH", conversationKey);
    return { threadId: survivor, linkConfidence: "HIGH", created: false };
  }

  // 2. Thread-Index root.
  if (conversationKey) {
    const [row] = await db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.mailboxId, mailboxId), eq(threads.conversationKey, conversationKey)))
      .orderBy(asc(threads.createdAt))
      .limit(1);
    if (row) {
      const root = await rootOf(db, row.id);
      await joinThread(db, root, msg.sortTs, "MEDIUM", conversationKey);
      return { threadId: root, linkConfidence: "MEDIUM", created: false };
    }
  }

  // 3. Subject + participants within the window (never for generic subjects).
  if (!isGenericSubject(subjectNorm)) {
    const owners = await ownerAddresses(db, mailboxId);
    const people = [...new Set(msg.participants.map((p) => p.trim().toLowerCase()).filter((p) => p.includes("@") && !owners.has(p)))];
    if (people.length) {
      const from = new Date(msg.sortTs.getTime() - SUBJECT_LINK_WINDOW_DAYS * DAY_MS);
      const to = new Date(msg.sortTs.getTime() + SUBJECT_LINK_WINDOW_DAYS * DAY_MS);
      const peopleSql = sql.join(people.map((p) => sql`${p}`), sql`, `);
      const [row] = await db
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.mailboxId, mailboxId),
            isNull(threads.mergedIntoId),
            eq(threads.subjectNorm, subjectNorm),
            sql`coalesce(${threads.lastMessageAt}, ${threads.createdAt}) >= ${from}`,
            sql`coalesce(${threads.firstMessageAt}, ${threads.createdAt}) <= ${to}`,
            sql`exists (
              select 1 from ${messages} m
              where m.thread_id = ${threads.id}
                and (lower(m.from_address) in (${peopleSql})
                  or exists (select 1 from jsonb_array_elements(m."to" || m.cc) e where lower(e->>'address') in (${peopleSql})))
            )`,
          ),
        )
        .orderBy(desc(threads.lastMessageAt))
        .limit(1);
      if (row) {
        await joinThread(db, row.id, msg.sortTs, "LOW", conversationKey);
        return { threadId: row.id, linkConfidence: "LOW", created: false };
      }
    }
  }

  // 4. New thread.
  const [created] = await db
    .insert(threads)
    .values({
      mailboxId,
      subjectNorm,
      conversationKey,
      linkConfidence: "HIGH",
      firstMessageAt: msg.sortTs,
      lastMessageAt: msg.sortTs,
      messageCount: 1,
    })
    .returning({ id: threads.id });
  return { threadId: created!.id, linkConfidence: "HIGH", created: true };
}

/** Thread-Index root key (first 22 decoded bytes, base64) or null. */
export function threadIndexRoot(threadIndex: string | null): string | null {
  if (!threadIndex) return null;
  const clean = threadIndex.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  const bytes = Buffer.from(clean, "base64");
  if (bytes.length < 22) return null;
  return bytes.subarray(0, 22).toString("base64");
}

async function ownerAddresses(db: DbOrTx, mailboxId: string): Promise<Set<string>> {
  const [mb] = await db.select({ address: mailboxes.address, aliases: mailboxes.aliases }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return new Set([mb?.address ?? "", ...(mb?.aliases ?? [])].map((a) => a.trim().toLowerCase()).filter(Boolean));
}

/** Follow merged_into_id to the surviving thread. */
async function rootOf(db: DbOrTx, threadId: string): Promise<string> {
  let id = threadId;
  for (let hop = 0; hop < 20; hop++) {
    const [row] = await db.select({ mergedIntoId: threads.mergedIntoId }).from(threads).where(eq(threads.id, id));
    if (!row?.mergedIntoId) return id;
    id = row.mergedIntoId;
  }
  return id;
}

/** Merge several root threads into the oldest one. Returns the survivor. */
async function mergeThreads(db: DbOrTx, roots: string[]): Promise<string> {
  if (roots.length === 1) return roots[0]!;
  const rows = await db.select().from(threads).where(inArray(threads.id, roots)).orderBy(asc(threads.createdAt), asc(threads.id));
  const survivor = rows[0]!;
  const losers = rows.slice(1);
  let first = survivor.firstMessageAt;
  let last = survivor.lastMessageAt;
  let count = survivor.messageCount;
  let confidence = survivor.linkConfidence;
  let conv = survivor.conversationKey;
  let subject = survivor.subjectNorm;
  for (const l of losers) {
    if (l.firstMessageAt && (!first || l.firstMessageAt < first)) first = l.firstMessageAt;
    if (l.lastMessageAt && (!last || l.lastMessageAt > last)) last = l.lastMessageAt;
    count += l.messageCount;
    confidence = weakest(confidence, l.linkConfidence);
    conv ??= l.conversationKey;
    if (!subject) subject = l.subjectNorm;
  }
  const loserIds = losers.map((l) => l.id);
  await db.update(threads).set({ mergedIntoId: survivor.id }).where(inArray(threads.id, loserIds));
  await db.update(threads).set({ mergedIntoId: survivor.id }).where(inArray(threads.mergedIntoId, loserIds));
  await db.update(messages).set({ threadId: survivor.id }).where(inArray(messages.threadId, loserIds));
  await db.update(taskLinks).set({ threadId: survivor.id }).where(inArray(taskLinks.threadId, loserIds));
  await db.update(taskEvents).set({ threadId: survivor.id }).where(inArray(taskEvents.threadId, loserIds));
  await db
    .update(threads)
    .set({ firstMessageAt: first, lastMessageAt: last, messageCount: count, linkConfidence: confidence, conversationKey: conv, subjectNorm: subject })
    .where(eq(threads.id, survivor.id));
  return survivor.id;
}

async function joinThread(db: DbOrTx, threadId: string, sortTs: Date, link: LinkConfidence, conversationKey: string | null): Promise<void> {
  const [t] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!t) return;
  await db
    .update(threads)
    .set({
      messageCount: t.messageCount + 1,
      firstMessageAt: t.firstMessageAt && t.firstMessageAt < sortTs ? t.firstMessageAt : sortTs,
      lastMessageAt: t.lastMessageAt && t.lastMessageAt > sortTs ? t.lastMessageAt : sortTs,
      linkConfidence: weakest(t.linkConfidence, link),
      conversationKey: t.conversationKey ?? conversationKey,
    })
    .where(eq(threads.id, threadId));
}
