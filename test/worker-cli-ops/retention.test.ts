import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import { runRetention } from "../../src/ops/retention.js";
import { createTestDb, insertFolder, insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const cfg = { BODY_RETENTION_DAYS: 90, CLOSED_TASK_RETENTION_DAYS: 540 };

describe("runRetention", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("purges per the retention table, keeps what is still needed, and is idempotent", async () => {
    const { db } = t;
    const { org, user, mailbox } = await seedOrgUserMailbox(db);
    const folder = await insertFolder(db, mailbox.id, "INBOX", "inbox");
    const th = await insertThread(db, mailbox.id);

    const oldApplied = await insertMessage(db, { mailboxId: mailbox.id, threadId: th.id, sortTs: daysAgo(100), state: "applied" });
    const oldPending = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(100), state: "pending" });
    const recent = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(10), state: "applied" });
    const oldFiltered = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(100), state: "filtered" });
    const oldFilteredLinked = await insertMessage(db, { mailboxId: mailbox.id, threadId: th.id, sortTs: daysAgo(100), state: "filtered" });
    const personal = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(1), state: "applied" });
    await db.update(s.messages).set({ classification: "PERSONAL" }).where(eq(s.messages.id, personal.id));
    const skipped = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(95), state: "skipped_old" });
    await db.insert(s.messageLocations).values({ messageId: skipped.id, folderId: folder.id, uid: 7 });
    const recentFiltered = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(30), state: "filtered" });
    const closedTaskFiltered = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(100), state: "filtered" });

    // Extractions: old (purge), old for a queued message (keep), recent (keep).
    const ext = (messageId: string, createdAt: Date) =>
      db.insert(s.extractions).values({ messageId, mailboxId: mailbox.id, pipelineVersion: "v1", status: "ok", request: { x: 1 }, output: { y: 2 }, handleMap: { tasks: {}, participants: {} }, costUsd: 0.05, inputTokens: 1000, createdAt }).returning();
    const [e1] = await ext(oldApplied.id, daysAgo(100));
    const [e2] = await ext(oldPending.id, daysAgo(100));
    const [e3] = await ext(recent.id, daysAgo(10));

    // Tasks: closed long ago (delete), closed recently (keep), open old (keep).
    const oldClosed = await insertTask(db, { orgId: org.id, userId: user.id, mailboxId: mailbox.id, status: "COMPLETED", threadId: th.id, messageId: closedTaskFiltered.id });
    await db.update(s.tasks).set({ closedAt: daysAgo(600) }).where(eq(s.tasks.id, oldClosed.id));
    await db.insert(s.taskEvents).values({ taskId: oldClosed.id, actor: "ai", op: "CREATE", evidenceQuote: "q", createdAt: daysAgo(700) });
    await db.insert(s.actionNonces).values({ nonce: "n-old-task", userId: user.id, taskId: oldClosed.id, action: "complete", expiresAt: daysAgo(1) });
    const recentClosed = await insertTask(db, { orgId: org.id, userId: user.id, mailboxId: mailbox.id, status: "DISMISSED" });
    const openOld = await insertTask(db, { orgId: org.id, userId: user.id, mailboxId: mailbox.id, status: "ACTION_REQUIRED", threadId: th.id, messageId: oldApplied.id });
    await db.insert(s.taskLinks).values({ taskId: openOld.id, threadId: th.id, messageId: oldFilteredLinked.id, role: "reference" });

    // Orphan AI candidates (tier=logged): old → delete, recent → keep.
    await db.insert(s.taskEvents).values([
      { taskId: null, actor: "ai", op: "CREATE", tier: "logged", evidenceQuote: "old quote", createdAt: daysAgo(120) },
      { taskId: null, actor: "ai", op: "CREATE", tier: "logged", evidenceQuote: "new quote", createdAt: daysAgo(5) },
    ]);

    await db.insert(s.digests).values([
      { userId: user.id, localDate: "2026-06-01", status: "delivered", html: "<p>x</p>", text: "x", createdAt: daysAgo(115) },
      { userId: user.id, localDate: "2026-09-23", status: "delivered", html: "<p>y</p>", text: "y", createdAt: daysAgo(1) },
    ]);
    await db.insert(s.mailboxLoginAttempts).values([
      { mailboxId: mailbox.id, purpose: "sync", outcome: "ok", at: daysAgo(100) },
      { mailboxId: mailbox.id, purpose: "sync", outcome: "ok", at: daysAgo(10) },
    ]);
    await db.insert(s.sessions).values([
      { id: "expired", userId: user.id, csrfToken: "c", expiresAt: daysAgo(1) },
      { id: "valid", userId: user.id, csrfToken: "c", expiresAt: daysAgo(-1) },
    ]);
    await db.insert(s.trustedDevices).values([{ id: "td-old", userId: user.id, expiresAt: daysAgo(2) }]);
    await db.insert(s.actionNonces).values([
      { nonce: "expired-long", userId: user.id, taskId: openOld.id, action: "complete", expiresAt: daysAgo(10) },
      { nonce: "expired-recent", userId: user.id, taskId: openOld.id, action: "complete", expiresAt: daysAgo(2) },
    ]);
    await db.insert(s.securityAudit).values([
      { event: "login", createdAt: daysAgo(400) },
      { event: "login", createdAt: daysAgo(100) },
    ]);
    const [emptyOldThread] = await db.insert(s.threads).values({ mailboxId: mailbox.id, createdAt: daysAgo(100) }).returning();
    const [emptyNewThread] = await db.insert(s.threads).values({ mailboxId: mailbox.id, createdAt: daysAgo(3) }).returning();

    const r = await runRetention(db, NOW, cfg);
    expect(r).toMatchObject({
      bodiesPurged: 5, // oldApplied, oldFiltered, oldFilteredLinked, skipped, closedTaskFiltered
      sensitiveBodiesPurged: 1,
      extractionsPurged: 1,
      orphanEventsDeleted: 1,
      digestsPurged: 1,
      tasksDeleted: 1,
      messagesDeleted: 3, // oldFiltered, skipped, closedTaskFiltered (unlinked once its closed task went)
      noncesDeleted: 1,
      loginAttemptsDeleted: 1,
      sessionsDeleted: 1,
      trustedDevicesDeleted: 1,
      auditRowsDeleted: 1,
    });

    const msg = async (id: string) => (await db.select().from(s.messages).where(eq(s.messages.id, id)))[0];
    const purged = await msg(oldApplied.id);
    expect(purged!.textPlain).toBeNull();
    expect(purged!.segments).toEqual([]);
    expect(purged!.bodyPurgedAt?.getTime()).toBe(NOW.getTime());
    expect(purged!.subject).toBe(oldApplied.subject); // metadata stays while linked
    expect((await msg(oldPending.id))!.textPlain).not.toBeNull();
    expect((await msg(recent.id))!.textPlain).not.toBeNull();
    expect((await msg(personal.id))!.textPlain).toBeNull();
    expect(await msg(oldFiltered.id)).toBeUndefined();
    expect(await msg(skipped.id)).toBeUndefined();
    expect(await msg(recentFiltered.id)).toBeDefined();
    expect(await msg(oldFilteredLinked.id)).toBeDefined();
    expect(await msg(closedTaskFiltered.id)).toBeUndefined();
    expect((await db.select().from(s.messageLocations)).length).toBe(0);

    const exts = await db.select().from(s.extractions);
    const byId = new Map(exts.map((e) => [e.id, e]));
    expect(byId.get(e1!.id)!.request).toBeNull();
    expect(byId.get(e1!.id)!.output).toBeNull();
    expect(byId.get(e1!.id)!.handleMap).toBeNull();
    expect(byId.get(e1!.id)!.costUsd).toBeCloseTo(0.05);
    expect(byId.get(e1!.id)!.inputTokens).toBe(1000);
    expect(byId.get(e2!.id)!.request).not.toBeNull();
    expect(byId.get(e3!.id)!.output).not.toBeNull();

    const taskIds = (await db.select({ id: s.tasks.id }).from(s.tasks)).map((x) => x.id).sort();
    expect(taskIds).toEqual([recentClosed.id, openOld.id].sort());
    const events = await db.select().from(s.taskEvents);
    expect(events.map((e) => e.evidenceQuote)).toEqual(["new quote"]);
    expect((await db.select().from(s.actionNonces)).map((n) => n.nonce)).toEqual(["expired-recent"]);
    const digests = await db.select().from(s.digests);
    expect(digests.find((d) => d.localDate === "2026-06-01")!.html).toBeNull();
    expect(digests.find((d) => d.localDate === "2026-09-23")!.html).toBe("<p>y</p>");
    expect((await db.select().from(s.sessions)).map((x) => x.id)).toEqual(["valid"]);
    const threads = (await db.select({ id: s.threads.id }).from(s.threads)).map((x) => x.id);
    expect(threads).toContain(th.id);
    expect(threads).toContain(emptyNewThread!.id);
    expect(threads).not.toContain(emptyOldThread!.id);
    expect(r.threadsDeleted).toBe(1);

    const audit = await db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "retention_purge"));
    expect(audit).toHaveLength(1);

    // Second run the same night: nothing left to do, no extra audit row.
    const again = await runRetention(db, NOW, cfg);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
    const auditAfter = await db.execute(sql`select count(*)::int as n from security_audit where event = 'retention_purge'`);
    expect(Number((auditAfter.rows[0] as { n: number }).n)).toBe(1);
  });

  it("uses BODY_RETENTION_DAYS for bodies and extraction text", async () => {
    const { db } = t;
    const { mailbox } = await seedOrgUserMailbox(db);
    const m = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(40), state: "applied" });
    expect((await runRetention(db, NOW, cfg)).bodiesPurged).toBe(0);
    expect((await runRetention(db, NOW, { ...cfg, BODY_RETENTION_DAYS: 30 })).bodiesPurged).toBe(1);
    const [row] = await db.select().from(s.messages).where(eq(s.messages.id, m.id));
    expect(row!.textPlain).toBeNull();
  });
});
