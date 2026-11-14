import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { runRetention } from "../../../src/ops/retention.js";
import { createTestDb, insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const cfg = { BODY_RETENTION_DAYS: 90, CLOSED_TASK_RETENTION_DAYS: 540 };

describe("retention-unlinked-metadata-kept", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it("drops the metadata of analysed / parked messages that no task references after 90 days", async () => {
    const { db } = t;
    const { org, user, mailbox } = await seedOrgUserMailbox(db);
    // An FYI mail analysed 100 days ago: no task link, only a logged-only AI candidate (itself deleted at 90 days).
    const fyi = await insertMessage(db, {
      mailboxId: mailbox.id,
      sortTs: daysAgo(100),
      state: "applied",
      subject: "Ενημέρωση τιμοκαταλόγου",
      to: ["owner@contoso.example", "partner@abc-gr.example"],
      cc: ["boss@abc-gr.example"],
      attachments: [{ filename: "timokatalogos-2026.pdf" }],
      references: ["<a@abc-gr.example>"],
    });
    await db.update(s.messages).set({ classification: "FYI", headers: { "list-id": "news.abc-gr.example" } }).where(eq(s.messages.id, fyi.id));
    await db.insert(s.taskEvents).values({ taskId: null, messageId: fyi.id, actor: "ai", op: "CREATE", tier: "logged", evidenceQuote: "q", createdAt: daysAgo(100) });
    // Its extraction's usage/cost is kept for the KPIs (a hard delete would cascade it away).
    await db.insert(s.extractions).values({ messageId: fyi.id, mailboxId: mailbox.id, pipelineVersion: "v1", status: "ok", costUsd: 0.02, inputTokens: 900, createdAt: daysAgo(100) });
    // A parked message from 100 days ago.
    const parked = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(100), state: "failed", subject: "Parked" });
    // Control: a filtered one of the same age is deleted today.
    const filtered = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(100), state: "filtered" });
    // Kept: an old analysed message in a thread an open task is linked to (the report shows its subject/sender).
    const th = await insertThread(db, mailbox.id);
    const inTaskThread = await insertMessage(db, { mailboxId: mailbox.id, threadId: th.id, sortTs: daysAgo(100), state: "applied", subject: "Στο νήμα της εργασίας" });
    await insertTask(db, { orgId: org.id, userId: user.id, mailboxId: mailbox.id, threadId: th.id });
    // Kept: younger than 90 days.
    const recent = await insertMessage(db, { mailboxId: mailbox.id, sortTs: daysAgo(30), state: "applied", subject: "Πρόσφατο" });

    const r = await runRetention(db, NOW, cfg);
    expect(r.orphanEventsDeleted).toBe(1);
    expect(r.metadataPurged).toBe(2);
    const rows = new Map((await db.select().from(s.messages)).map((m) => [m.id, m]));
    expect(rows.has(filtered.id)).toBe(false); // precondition: the metadata step ran

    for (const id of [fyi.id, parked.id]) {
      const m = rows.get(id)!;
      expect(m).toMatchObject({ subject: "", subjectNorm: "", fromAddress: null, fromName: null, to: [], cc: [], bcc: [], replyTo: [], headers: {}, attachments: [], references: [], inReplyTo: null });
    }
    expect(rows.get(parked.id)!.state).toBe("failed");
    expect(JSON.stringify(rows.get(fyi.id))).not.toMatch(/partner@abc|boss@abc|timokatalogos|Ενημέρωση|news\.abc/);
    const [ext] = await db.select().from(s.extractions).where(eq(s.extractions.messageId, fyi.id));
    expect(ext!.costUsd).toBeCloseTo(0.02);
    expect(ext!.inputTokens).toBe(900);

    expect(rows.get(inTaskThread.id)!.subject).toBe("Στο νήμα της εργασίας");
    expect(rows.get(recent.id)!.subject).toBe("Πρόσφατο");

    // Idempotent: nothing left the second time.
    expect((await runRetention(db, NOW, cfg)).metadataPurged).toBe(0);
  });
});
