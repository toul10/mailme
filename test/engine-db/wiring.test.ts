import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// D1's reconciler is a stub in this worktree: mock the module so the real default wiring can run.
vi.mock("../../src/engine/reconcile.js", () => ({ planOperations: vi.fn() }));

import * as s from "../../src/db/schema.js";
import { applyExtraction } from "../../src/engine/apply.js";
import { drainMailbox } from "../../src/engine/pipeline.js";
import { planOperations, type Plan } from "../../src/engine/reconcile.js";
import { insertMessage, insertTask, insertThread, seedOrgUserMailbox } from "../helpers/db.js";
import { createOp, fakeExtractor, handleMapFor, insertExtraction, okResult, output, pipelineDeps, plannedOp, sharedTestDb, simpleOp, testClock } from "./fixtures.js";

const shared = sharedTestDb();
const planAll = (out: Parameters<typeof planOperations>[0], ctx: Parameters<typeof planOperations>[1]): Plan => ({
  valid: true,
  messageReview: false,
  reasons: [],
  ops: out.operations.map((op, i) => plannedOp(i, op, { taskId: op.op === "CREATE" ? null : (ctx.handleMap.tasks[op.task] ?? null) })),
});

beforeEach(() => {
  vi.mocked(planOperations).mockReset();
  vi.mocked(planOperations).mockImplementation(planAll);
});

describe("default wiring", () => {
  it("applyExtraction calls reconcile.planOperations with the parsed output and the reconcile context", async () => {
    const t = shared();
    const seed = await seedOrgUserMailbox(t.db);
    const thread = await insertThread(t.db, seed.mailbox.id);
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted" });
    const out = output([createOp()]);
    const ext = await insertExtraction(t.db, m, out, handleMapFor());
    const res = await applyExtraction(t.db, m.id, ext.id, testClock("2026-09-10T08:10:00Z"));
    expect(res.created).toHaveLength(1);
    expect(planOperations).toHaveBeenCalledTimes(1);
    const [calledOut, ctx] = vi.mocked(planOperations).mock.calls[0]!;
    expect(calledOut).toEqual(out);
    expect(ctx).toMatchObject({ direction: "INBOUND", zone: "Europe/Athens", handleMap: handleMapFor() });
  });

  it("drainMailbox: context handles round-trip through the stored extraction into apply", async () => {
    const t = shared();
    const seed = await seedOrgUserMailbox(t.db);
    const thread = await insertThread(t.db, seed.mailbox.id);
    const origin = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, sortTs: new Date("2026-09-09T08:00:00Z"), state: "applied" });
    const task = await insertTask(t.db, { orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id, status: "WAITING_FOR_ME", threadId: thread.id, messageId: origin.id });
    const reply = await insertMessage(t.db, {
      mailboxId: seed.mailbox.id,
      threadId: thread.id,
      direction: "OUTBOUND",
      from: "owner@contoso.example",
      to: ["client@abc-gr.example"],
      text: "Σας επισυνάπτω την προσφορά.",
      attachments: [{ filename: "Prosfora_ABC.pdf" }],
      sortTs: new Date("2026-09-10T08:00:00Z"),
    });
    const ex = fakeExtractor((input) => {
      const card = input.taskCards.find((c) => c.scope === "THREAD_OPEN");
      return okResult(output(card ? [simpleOp("COMPLETE", card.handle)] : []));
    });
    const report = await drainMailbox(pipelineDeps(t, ex, testClock("2026-09-10T09:00:00Z")), seed.mailbox.id);
    expect(report).toMatchObject({ processed: 1, extracted: 1, applied: 1 });
    expect(ex.calls[0]!.taskCards.map((c) => [c.handle, c.scope])).toEqual([["K1", "THREAD_OPEN"]]);
    const [after] = await t.db.select().from(s.tasks).where(eq(s.tasks.id, task.id));
    expect(after).toMatchObject({ status: "COMPLETED", closedBy: "ai" });
    const [ext] = await t.db.select().from(s.extractions).where(eq(s.extractions.messageId, reply.id));
    expect(ext!.handleMap?.tasks.K1).toBe(task.id);
    const ctx = vi.mocked(planOperations).mock.calls[0]![1];
    expect(ctx.tasks.get(task.id)).toMatchObject({ scope: "THREAD_OPEN", status: "WAITING_FOR_ME" });
  });
});
