import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import { resolveThread, threadIndexRoot, type ThreadKeyInput } from "../../src/mail/thread.js";
import { createTestDb, insertMessage, insertTask, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db, { aliases: ["sales@contoso.example"] });
});
afterEach(() => t.close());

const at = (iso: string) => new Date(iso);
const key = (over: Partial<ThreadKeyInput>): ThreadKeyInput => ({
  messageKey: "new@x.example",
  inReplyTo: null,
  references: [],
  threadIndex: null,
  subject: "Ανανέωση συμβολαίου συντήρησης",
  participants: ["client@alfa.example", "owner@contoso.example"],
  sortTs: at("2026-09-10T08:00:00Z"),
  ...over,
});

/** Stored message that already belongs to a thread (created through resolveThread so stats are right). */
async function threaded(over: Partial<ThreadKeyInput> & { from?: string; to?: string[] }) {
  const k = key(over);
  const m = await insertMessage(t.db, {
    mailboxId: ctx.mailbox.id,
    messageIdHeader: k.messageKey,
    inReplyTo: k.inReplyTo,
    references: k.references,
    subject: k.subject,
    sortTs: k.sortTs,
    from: over.from ?? "client@alfa.example",
    to: over.to ?? ["owner@contoso.example"],
  });
  const r = await resolveThread(t.db, ctx.mailbox.id, k);
  await t.db.update(s.messages).set({ threadId: r.threadId }).where(eq(s.messages.id, m.id));
  return { message: m, ...r };
}

const thread = async (id: string) => (await t.db.select().from(s.threads).where(eq(s.threads.id, id)))[0]!;

describe("threadIndexRoot", () => {
  it("returns the first 22 decoded bytes, base64", () => {
    const root = Buffer.from("01dc41a0b2c30f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex");
    const child = Buffer.concat([root, Buffer.from("0000a1b2c3", "hex")]);
    expect(threadIndexRoot(root.toString("base64"))).toBe(root.toString("base64"));
    expect(threadIndexRoot(child.toString("base64"))).toBe(root.toString("base64"));
    expect(threadIndexRoot(" " + child.toString("base64") + "\r\n")).toBe(root.toString("base64"));
  });

  it("returns null for missing, short or invalid values", () => {
    expect(threadIndexRoot(null)).toBeNull();
    expect(threadIndexRoot("")).toBeNull();
    expect(threadIndexRoot(Buffer.alloc(10).toString("base64"))).toBeNull();
    expect(threadIndexRoot("not base64 !!")).toBeNull();
  });
});

describe("resolveThread", () => {
  it("creates a new thread with stats when nothing matches", async () => {
    const r = await resolveThread(t.db, ctx.mailbox.id, key({}));
    expect(r).toMatchObject({ linkConfidence: "HIGH", created: true });
    expect(await thread(r.threadId)).toMatchObject({
      mailboxId: ctx.mailbox.id,
      subjectNorm: "ανανεωση συμβολαιου συντηρησησ",
      linkConfidence: "HIGH",
      messageCount: 1,
      firstMessageAt: at("2026-09-10T08:00:00Z"),
      lastMessageAt: at("2026-09-10T08:00:00Z"),
    });
  });

  it("links by In-Reply-To / References (HIGH) and updates the thread window", async () => {
    const parent = await threaded({ messageKey: "parent@x.example", sortTs: at("2026-09-08T08:00:00Z") });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "child@x.example", inReplyTo: "<parent@X.EXAMPLE>", subject: "Άσχετο θέμα" }));
    expect(r).toEqual({ threadId: parent.threadId, linkConfidence: "HIGH", created: false });
    expect(await thread(parent.threadId)).toMatchObject({ messageCount: 2, firstMessageAt: at("2026-09-08T08:00:00Z"), lastMessageAt: at("2026-09-10T08:00:00Z") });
  });

  it("links a parent that arrives after its reply (reverse References lookup)", async () => {
    const child = await threaded({ messageKey: "child@x.example", references: ["root@x.example", "parent@x.example"] });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "parent@x.example", subject: "Άλλο", sortTs: at("2026-09-09T08:00:00Z") }));
    expect(r).toEqual({ threadId: child.threadId, linkConfidence: "HIGH", created: false });
    expect((await thread(child.threadId)).firstMessageAt).toEqual(at("2026-09-09T08:00:00Z"));
  });

  it("merges threads bridged by one message into the oldest; re-points messages, task links and events", async () => {
    const a = await threaded({ messageKey: "a@x.example", subject: "Θέμα Α", sortTs: at("2026-09-01T08:00:00Z") });
    const b = await threaded({ messageKey: "b@x.example", subject: "Θέμα Β", sortTs: at("2026-09-05T08:00:00Z") });
    expect(a.threadId).not.toBe(b.threadId);
    const task = await insertTask(t.db, { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id, threadId: b.threadId, messageId: b.message.id });
    await t.db.insert(s.taskEvents).values({ taskId: task.id, threadId: b.threadId, actor: "user", op: "USER_NOT_A_TASK" });

    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "c@x.example", references: ["a@x.example", "b@x.example"] }));
    expect(r).toEqual({ threadId: a.threadId, linkConfidence: "HIGH", created: false });
    expect(await thread(b.threadId)).toMatchObject({ mergedIntoId: a.threadId });
    expect(await thread(a.threadId)).toMatchObject({ messageCount: 3, firstMessageAt: at("2026-09-01T08:00:00Z"), lastMessageAt: at("2026-09-10T08:00:00Z") });
    const [bMsg] = await t.db.select().from(s.messages).where(eq(s.messages.id, b.message.id));
    expect(bMsg!.threadId).toBe(a.threadId);
    const links = await t.db.select().from(s.taskLinks).where(eq(s.taskLinks.taskId, task.id));
    expect(links.map((l) => l.threadId)).toEqual([a.threadId]);
    const events = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.taskId, task.id));
    expect(events.map((e) => e.threadId)).toEqual([a.threadId]);

    // Later messages that still reference the merged thread land on the survivor.
    const d = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "d@x.example", inReplyTo: "b@x.example" }));
    expect(d.threadId).toBe(a.threadId);
  });

  it("links by Thread-Index root (MEDIUM) and downgrades the thread", async () => {
    const root = Buffer.from("01dc41a0b2c30f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex");
    const first = await threaded({ messageKey: "ti1@x.example", threadIndex: root.toString("base64"), subject: "Εγγύηση ενισχυτών" });
    const childIndex = Buffer.concat([root, Buffer.from("0000a1b2c3", "hex")]).toString("base64");
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "ti2@x.example", threadIndex: childIndex, subject: "Εντελώς άλλο θέμα" }));
    expect(r).toEqual({ threadId: first.threadId, linkConfidence: "MEDIUM", created: false });
    expect((await thread(first.threadId)).linkConfidence).toBe("MEDIUM");
    expect((await thread(first.threadId)).conversationKey).toBe(root.toString("base64"));
  });

  it("links by normalized subject + a shared non-owner participant within 30 days (LOW)", async () => {
    const first = await threaded({ messageKey: "s1@x.example", subject: "Ανανέωση συμβολαίου συντήρησης", sortTs: at("2026-08-31T07:00:00Z") });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "s2@x.example", subject: "ΑΠ: ανανεωση ΣΥΜΒΟΛΑΙΟΥ συντήρησης" }));
    expect(r).toEqual({ threadId: first.threadId, linkConfidence: "LOW", created: false });
    expect((await thread(first.threadId)).linkConfidence).toBe("LOW");
  });

  it("does not link by subject when only the owner (or an alias) is shared", async () => {
    await threaded({ messageKey: "s1@x.example", from: "owner@contoso.example", to: ["sales@contoso.example"], participants: ["owner@contoso.example", "sales@contoso.example"] });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "s2@x.example", participants: ["other@beta.example", "owner@contoso.example", "sales@contoso.example"] }));
    expect(r.created).toBe(true);
  });

  it("never links generic subjects by subject alone", async () => {
    await threaded({ messageKey: "g1@x.example", subject: "Προσφορά" });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "g2@x.example", subject: "ΑΠ: Προσφορά" }));
    expect(r.created).toBe(true);
  });

  it("does not link by subject outside the 30-day window", async () => {
    await threaded({ messageKey: "o1@x.example", sortTs: at("2026-07-01T08:00:00Z") });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "o2@x.example" }));
    expect(r.created).toBe(true);
  });

  it("is scoped to the mailbox", async () => {
    const other = await seedOrgUserMailbox(t.db, { address: "someone@contoso.example" });
    await insertMessage(t.db, { mailboxId: other.mailbox.id, messageIdHeader: "parent@x.example", threadId: (await resolveThread(t.db, other.mailbox.id, key({ messageKey: "parent@x.example" }))).threadId });
    const r = await resolveThread(t.db, ctx.mailbox.id, key({ messageKey: "child@x.example", inReplyTo: "parent@x.example", subject: "Άσχετο" }));
    expect(r.created).toBe(true);
  });
});
