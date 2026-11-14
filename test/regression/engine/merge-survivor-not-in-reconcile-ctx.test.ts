// Regression for review finding merge-survivor-not-in-reconcile-ctx (reported by two lenses; one test file).
// The reconciler contract: "An op on a merged task whose survivor is in context is redirected to the survivor →
// review (task_merged)". For a non-CREATE op, review = a pending suggestion on the survivor ("Done already?"),
// not a direct apply — so the redirected COMPLETE leaves B open with a suggestion instead of being logged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { applyExtraction } from "../../../src/engine/apply.js";
import { mergeTasks } from "../../../src/engine/user-actions.js";
import { createTestDb, insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { handleMapFor, insertExtraction, output, simpleOp } from "../../engine-db/fixtures.js";

let t: TestDb;
let ctx: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
const clock = { now: () => new Date("2026-09-24T09:00:00Z") };
beforeEach(async () => {
  t = await createTestDb();
  ctx = await seedOrgUserMailbox(t.db);
});
afterEach(() => t.close());

/** Task A (thread T, WAITING_FOR_ME) and task B (another thread); the owner's outbound reply in T completes K1=A. */
async function setup() {
  const thread = await insertThread(t.db, ctx.mailbox.id, "προσφορα ηχειων");
  const other = await insertThread(t.db, ctx.mailbox.id, "παραγγελια 55");
  const base = { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id };
  const a = await insertTask(t.db, { ...base, title: "ABC — Προσφορά ηχείων", status: "WAITING_FOR_ME", threadId: thread.id });
  const b = await insertTask(t.db, { ...base, title: "ABC — Προσφορά ηχείων (2)", status: "WAITING_FOR_ME", threadId: other.id });
  const msg = await insertMessage(t.db, {
    mailboxId: ctx.mailbox.id,
    threadId: thread.id,
    direction: "OUTBOUND",
    from: "owner@contoso.example",
    to: ["client@abc-gr.example"],
    text: "Καλημέρα, σας επισυνάπτω την προσφορά.",
    sortTs: new Date("2026-09-24T08:30:00Z"),
  });
  const ext = await insertExtraction(t.db, msg, output([simpleOp("COMPLETE", "K1", "σας επισυνάπτω την προσφορά")]), handleMapFor({ tasks: { K1: a.id } }));
  return { a, b, msg, ext };
}
const task = async (id: string) => (await t.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;

describe("merge-survivor-not-in-reconcile-ctx", () => {
  it("control: without a merge, the owner's COMPLETE K1 closes A (real planner)", async () => {
    const { a, msg, ext } = await setup();
    const r = await applyExtraction(t.db, msg.id, ext.id, clock);
    expect(r.completed).toEqual([a.id]);
    expect((await task(a.id)).status).toBe("COMPLETED");
  });

  it("A merged into B between extraction and apply: the COMPLETE is redirected to the survivor B for review, not logged", async () => {
    const { a, b, msg, ext } = await setup();
    await mergeTasks({ db: t.db, clock, userId: ctx.user.id, via: "web" }, b.id, a.id);
    const r = await applyExtraction(t.db, msg.id, ext.id, clock);
    const evs = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.extractionId, ext.id));
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev.taskId).toBe(b.id);
    expect(ev.tier).toBe("review");
    expect(ev.reasons).toContain("task_merged");
    // Review of a COMPLETE = a pending "Done already?" suggestion on the survivor (reconciler contract).
    expect(ev.suggestionState).toBe("pending");
    expect(ev.payload).toMatchObject({ kind: "suggestion", proposedType: "complete" });
    expect(r).toMatchObject({ logged: 0, suggestions: 1, completed: [] });
    expect((await task(b.id)).status).toBe("WAITING_FOR_ME");
  });

  it("merged in the same thread after extraction (handle → A, survivor B): redirected for review, not logged as task_merged", async () => {
    const thread = await insertThread(t.db, ctx.mailbox.id);
    const ids = { orgId: ctx.org.id, userId: ctx.user.id, mailboxId: ctx.mailbox.id, threadId: thread.id };
    const a = await insertTask(t.db, { ...ids, title: "ABC — Αποστολή προσφοράς" });
    const b = await insertTask(t.db, { ...ids, title: "ABC — Προσφορά ηχείων" });
    const m = await insertMessage(t.db, {
      mailboxId: ctx.mailbox.id,
      threadId: thread.id,
      direction: "OUTBOUND",
      from: "owner@contoso.example",
      to: ["client@abc-gr.example"],
      text: "Σας επισυνάπτω την προσφορά.",
      state: "extracted",
    });
    const ext = await insertExtraction(t.db, m, output([simpleOp("COMPLETE", "K1", "Σας επισυνάπτω την προσφορά")]), handleMapFor({ tasks: { K1: a.id } }));
    // What mergeTasks leaves behind for A.
    await t.db.update(s.tasks).set({ mergedIntoId: b.id, status: "DISMISSED", closedBy: "user", closedAt: new Date("2026-09-24T08:59:00Z") }).where(eq(s.tasks.id, a.id));

    const r = await applyExtraction(t.db, m.id, ext.id, clock);
    const evs = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.extractionId, ext.id));
    expect({ logged: r.logged, tier: evs[0]?.tier }).toEqual({ logged: 0, tier: "review" });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.taskId).toBe(b.id);
    expect(evs[0]!.suggestionState === "pending" || evs[0]!.applied).toBe(true);
  });
});
