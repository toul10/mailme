import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../src/db/schema.js";
import { runRetention } from "../../../src/ops/retention.js";
import { createTestDb, insertMessage, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const cfg = { BODY_RETENTION_DAYS: 90, CLOSED_TASK_RETENTION_DAYS: 540 };

describe("retention-personal-extractions", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(() => t.close());

  it("drops the body copies in extractions and logged-only events of a PERSONAL message at once", async () => {
    const { db } = t;
    const { mailbox } = await seedOrgUserMailbox(db);
    const msg = await insertMessage(db, { mailboxId: mailbox.id, sortTs: new Date("2026-09-23T08:00:00Z"), state: "applied", text: "secret personal body" });
    await db.update(s.messages).set({ classification: "PERSONAL" }).where(eq(s.messages.id, msg.id));
    const [ext] = await db
      .insert(s.extractions)
      .values({
        messageId: msg.id,
        mailboxId: mailbox.id,
        pipelineVersion: "v1",
        status: "ok",
        request: { segments: [{ text: "secret personal body" }] },
        output: { message_class: "PERSONAL", summary: "secret personal body" },
        handleMap: { tasks: {}, participants: {} },
        createdAt: new Date("2026-09-23T08:05:00Z"),
      })
      .returning();
    await db.insert(s.taskEvents).values({ taskId: null, messageId: msg.id, extractionId: ext!.id, opIndex: 0, actor: "ai", op: "CREATE", tier: "logged", evidenceQuote: "secret personal body", createdAt: new Date("2026-09-23T08:05:00Z") });

    const r = await runRetention(db, NOW, cfg);
    expect(r.sensitiveBodiesPurged).toBe(1); // precondition: the sensitive step did run for this message
    const [m] = await db.select().from(s.messages).where(eq(s.messages.id, msg.id));
    expect(m!.textPlain).toBeNull();

    const [e] = await db.select().from(s.extractions).where(eq(s.extractions.id, ext!.id));
    expect(JSON.stringify(e!.request ?? null)).not.toContain("secret personal body");
    expect(JSON.stringify(e!.output ?? null)).not.toContain("secret personal body");
    const events = await db.select().from(s.taskEvents).where(eq(s.taskEvents.messageId, msg.id));
    expect(events.map((x) => x.evidenceQuote).filter(Boolean)).toEqual([]);
  });
});
