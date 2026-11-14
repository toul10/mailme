import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { buildExtractionContext } from "../../../src/engine/context.js";
import { drainMailbox } from "../../../src/engine/pipeline.js";
import { insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { fakeExtractor, okResult, output, pipelineDeps, sharedTestDb, testClock } from "../../engine-db/fixtures.js";

/**
 * 2026-10-02 08:13 UTC: a message with an empty subject and no new text, from a sender with an open task, gave
 * relatedOpenTasks no query tokens. Its rank became the constant `0`, and `ORDER BY 0 DESC` is a column position in
 * PostgreSQL: 42P10 "ORDER BY position 0 is not in select list". The drain treated it as an internal error and set the
 * global AI pause, so nothing was analysed for any mailbox for a day (25 messages waiting). Without tokens the related
 * tasks are ranked by recency only.
 */
const shared = sharedTestDb();
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;

beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
});

async function relatedTasksForClient() {
  const ids = { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id };
  const older = await insertTask(t.db, { ...ids, title: "ABC — Παλιά προσφορά", counterparty: "client@abc-gr.example" });
  const newer = await insertTask(t.db, { ...ids, title: "ABC — Νέα παραγγελία", counterparty: "client@abc-gr.example" });
  await t.db.update(s.tasks).set({ lastActivityAt: new Date("2026-09-20T09:00:00Z") }).where(eq(s.tasks.id, older.id));
  await t.db.update(s.tasks).set({ lastActivityAt: new Date("2026-09-30T09:00:00Z") }).where(eq(s.tasks.id, newer.id));
  return { older, newer };
}

describe("subjectless-message-order-by-zero", () => {
  it("a message without subject or text still gets its related open tasks, newest first", async () => {
    const { older, newer } = await relatedTasksForClient();
    const thread = await insertThread(t.db, seed.mailbox.id, "");
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, from: "client@abc-gr.example", subject: "", text: "" });

    const { input, handleMap } = await buildExtractionContext(t.db, m.id);

    expect(input.taskCards.map((c) => c.scope)).toEqual(["RELATED_OPEN", "RELATED_OPEN"]);
    expect([handleMap.tasks.K1, handleMap.tasks.K2]).toEqual([newer.id, older.id]);
  });

  it("draining it analyses the message and never pauses AI for every mailbox", async () => {
    await relatedTasksForClient();
    const thread = await insertThread(t.db, seed.mailbox.id, "");
    await insertMessage(t.db, {
      mailboxId: seed.mailbox.id,
      threadId: thread.id,
      from: "client@abc-gr.example",
      subject: "",
      text: "",
      sortTs: new Date("2026-10-02T08:10:00Z"),
    });
    const ex = fakeExtractor(() => okResult(output([], "FYI")));

    const r = await drainMailbox(pipelineDeps(t, ex, testClock("2026-10-02T09:00:00Z")), seed.mailbox.id, { fullCycleAt: new Date("2026-10-02T08:55:00Z") });

    expect(r.globalPause).toBe(false);
    expect(r.processed).toBe(1);
    expect(ex.calls).toHaveLength(1);
    const pause = await t.db.select().from(s.appState).where(eq(s.appState.key, "ai_global_pause"));
    expect(pause).toHaveLength(0);
  });
});
