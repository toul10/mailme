// Regression for review finding until-reply-never-wakes-on-parked-reply: an inbound reply that reaches a terminal
// state without a valid plan (parked PER_MESSAGE, invalid output twice, unappliable) must still wake the thread's
// «until they reply» snoozes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { runAging } from "../../../src/digest/aging.js";
import { ApplyError } from "../../../src/engine/apply.js";
import { buildExtractionContext } from "../../../src/engine/context.js";
import { drainMailbox, drainMailboxWith } from "../../../src/engine/pipeline.js";
import { snoozeTask } from "../../../src/engine/user-actions.js";
import { createTestDb, insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { errResult, fakeExtractor, okResult, output, pipelineDeps, simpleOp, testClock } from "../../engine-db/fixtures.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
});
afterEach(() => t.close());

/** WAITING_FOR_OTHER task in thread T snoozed "until they reply" on 09-10; a message arrives in T on 09-11. */
async function setup(direction: "INBOUND" | "OUTBOUND" = "INBOUND") {
  const clock = testClock("2026-09-10T09:00:00Z");
  const thread = await insertThread(t.db, ctx.mailbox.id);
  const task = await insertTask(t.db, { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id, status: "WAITING_FOR_OTHER", threadId: thread.id });
  await snoozeTask({ db: t.db, clock, userId: ctx.user.id, via: "web" }, task.id, "until_reply", null);
  const reply = await insertMessage(t.db, {
    mailboxId: ctx.mailbox.id,
    threadId: thread.id,
    subject: "ΑΠ: Προσφορά",
    text: "Εγκρίνουμε την προσφορά, προχωρήστε.",
    sortTs: new Date("2026-09-11T08:00:00Z"),
    ...(direction === "OUTBOUND" ? { direction, from: "owner@contoso.example", to: ["client@abc-gr.example"] } : {}),
  });
  clock.set("2026-09-11T09:00:00Z");
  return { clock, task, reply };
}
const taskRow = async (id: string) => (await t.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;
const msgRow = async (id: string) => (await t.db.select().from(s.messages).where(eq(s.messages.id, id)))[0]!;
const unsnoozeEvents = (taskId: string) => t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.taskId, taskId), eq(s.taskEvents.op, "SYSTEM_UNSNOOZE")));

describe("until-reply-never-wakes-on-parked-reply", () => {
  it("control: an analysed reply wakes the until_reply snooze", async () => {
    const { clock, task, reply } = await setup();
    const ex = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
    expect((await msgRow(reply.id)).state).toBe("applied");
    expect((await taskRow(task.id)).snoozeMode).toBeNull();
  });

  it("the reply is parked (PER_MESSAGE): the snooze must still be woken (the reply did arrive)", async () => {
    const { clock, task, reply } = await setup();
    const ex = fakeExtractor(() => errResult("PER_MESSAGE"));
    await drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
    expect((await msgRow(reply.id)).state).toBe("failed");
    // Nothing else ever wakes it: aging skips until_reply rows.
    await runAging(t.db, new Date("2026-10-30T09:00:00Z"), "Europe/Athens");
    expect((await taskRow(task.id)).snoozeMode).toBeNull();
    const events = await unsnoozeEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "system", messageId: reply.id, applied: true, payload: { reason: "reply" } });
  });

  it("invalid output twice (parked as invalid_output): the snooze is woken", async () => {
    const { clock, task, reply } = await setup();
    // K9 is not a handle the context offered → the plan is invalid → one re-extraction → parked.
    const ex = fakeExtractor(() => okResult(output([simpleOp("COMPLETE", "K9", "Εγκρίνουμε την προσφορά")])));
    await drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
    expect(ex.calls).toHaveLength(2);
    expect(await msgRow(reply.id)).toMatchObject({ state: "failed", lastError: "invalid_output" });
    expect((await taskRow(task.id)).snoozeMode).toBeNull();
  });

  it("a reply that cannot be applied (ApplyError → parked): the snooze is woken", async () => {
    const { clock, task, reply } = await setup();
    const ex = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailboxWith(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() }, {
      buildContext: buildExtractionContext,
      apply: async () => {
        throw new ApplyError("extraction_unusable");
      },
    });
    expect((await msgRow(reply.id)).state).toBe("failed");
    expect((await taskRow(task.id)).snoozeMode).toBeNull();
  });

  it("the owner's own parked message (OUTBOUND) is not a reply: the snooze stays", async () => {
    const { clock, task, reply } = await setup("OUTBOUND");
    const ex = fakeExtractor(() => errResult("PER_MESSAGE"));
    await drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
    expect((await msgRow(reply.id)).state).toBe("failed");
    expect((await taskRow(task.id)).snoozeMode).toBe("until_reply");
  });

  it("a transient error is not terminal: the snooze stays until the reply is processed", async () => {
    const { clock, task, reply } = await setup();
    const ex = fakeExtractor(() => errResult("TRANSIENT"));
    await drainMailbox(pipelineDeps(t, ex, clock), ctx.mailbox.id, { fullCycleAt: clock.now() });
    expect((await msgRow(reply.id)).state).toBe("pending");
    expect((await taskRow(task.id)).snoozeMode).toBe("until_reply");
  });
});
