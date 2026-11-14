import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../../src/db/schema.js";
import { applyExtractionWith } from "../../src/engine/apply.js";
import { suggestionPayload } from "../../src/engine/db-events.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  completeTask,
  confirmTask,
  createManualTask,
  dismissTask,
  editTask,
  markStillValid,
  markWouldHaveMissed,
  mergeTasks,
  reopenTask,
  resolveSuggestion,
  snoozeTask,
  unsnoozeTask,
  type ActionCtx,
} from "../../src/engine/user-actions.js";
import { insertMessage, insertTask, insertThread, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { createOp, fakePlanner, handleMapFor, insertExtraction, output, sharedTestDb, simpleOp, testClock, updateOp, type TestClock } from "./fixtures.js";

const shared = sharedTestDb();
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let thread: Awaited<ReturnType<typeof insertThread>>;
let clock: TestClock;

beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
  thread = await insertThread(t.db, seed.mailbox.id);
  clock = testClock("2026-09-15T07:00:00Z"); // Tue 10:00 Athens
});

const ctx = (over: Partial<ActionCtx> = {}): ActionCtx => ({ db: t.db, clock, userId: seed.user.id, via: "web", ...over });
const ids = () => ({ orgId: seed.org.id, userId: seed.user.id, mailboxId: seed.mailbox.id });
const get = async (id: string) => (await t.db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0]!;
const userEvents = (taskId: string) => t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.taskId, taskId), eq(s.taskEvents.actor, "user")));

async function otherUser() {
  const [u] = await t.db.insert(s.users).values({ orgId: seed.org.id, name: "Άλλος", email: "other@contoso.example" }).returning();
  return u!;
}

/** Pending AI suggestion on a task (as apply writes it). */
async function pendingSuggestion(taskId: string | null, proposed: Parameters<typeof suggestionPayload>[0], extra: Partial<typeof s.taskEvents.$inferInsert> = {}) {
  const [ev] = await t.db
    .insert(s.taskEvents)
    .values({ taskId, userId: seed.user.id, mailboxId: seed.mailbox.id, threadId: thread.id, actor: "ai", op: "UPDATE", tier: "review", suggestionState: "pending", payload: suggestionPayload(proposed, { op: "X" }), ...extra })
    .returning();
  return ev!;
}

describe("completion, dismissal, reopen", () => {
  it("completeTask closes, locks status, writes a user event; repeating it is a no-op", async () => {
    const task = await insertTask(t.db, { ...ids(), status: "WAITING_FOR_ME" });
    await completeTask(ctx({ expectedVersion: 1 }), task.id);
    const after = await get(task.id);
    expect(after).toMatchObject({ status: "COMPLETED", closedBy: "user", lockedFields: ["status"], version: 2 });
    expect(after.closedAt?.toISOString()).toBe("2026-09-15T07:00:00.000Z");
    expect(after.lastActivityAt.toISOString()).toBe("2026-09-15T07:00:00.000Z");
    const evs = await userEvents(task.id);
    expect(evs).toEqual([expect.objectContaining({ op: "USER_COMPLETE", applied: true, before: expect.objectContaining({ status: "WAITING_FOR_ME" }), after: expect.objectContaining({ status: "COMPLETED", lockedFields: ["status"] }), payload: { via: "web" } })]);
    await completeTask(ctx({ via: "link" }), task.id);
    expect((await get(task.id)).version).toBe(2);
    expect(await userEvents(task.id)).toHaveLength(1);
  });

  it("version mismatch → ConflictError; another user's task → NotFoundError", async () => {
    const task = await insertTask(t.db, { ...ids() });
    await expect(completeTask(ctx({ expectedVersion: 7 }), task.id)).rejects.toBeInstanceOf(ConflictError);
    const other = await otherUser();
    await expect(completeTask(ctx({ userId: other.id }), task.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await get(task.id)).status).toBe("ACTION_REQUIRED");
  });

  it("a deadlock against a concurrent drain is retried once", async () => {
    const task = await insertTask(t.db, { ...ids() });
    let attempts = 0;
    const flaky = new Proxy(t.db, {
      get(target, prop, recv) {
        if (prop !== "transaction") return Reflect.get(target, prop, recv);
        return (fn: Parameters<typeof target.transaction>[0]) => {
          if (++attempts === 1) return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
          return target.transaction(fn);
        };
      },
    });
    await completeTask(ctx({ db: flaky }), task.id);
    expect(attempts).toBe(2);
    expect((await get(task.id)).status).toBe("COMPLETED");
  });

  it("not_a_task stores the origin evidence as a thread negative that the next apply sees", async () => {
    const m0 = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "applied" });
    const task = await insertTask(t.db, { ...ids(), threadId: thread.id, messageId: m0.id });
    await t.db.insert(s.taskEvents).values({ taskId: task.id, threadId: thread.id, actor: "ai", op: "CREATE", applied: true, evidenceSource: "NEW", evidenceQuote: "Μπορείτε να μου στείλετε τον ΤΙΜΟΚΑΤΑΛΟΓΟ;" });
    const sugg = await pendingSuggestion(task.id, { type: "complete" });
    await dismissTask(ctx(), task.id, "not_a_task");
    expect(await get(task.id)).toMatchObject({ status: "DISMISSED", closedBy: "user", lockedFields: ["status"] });
    const [ev] = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.op, "USER_NOT_A_TASK"));
    expect(ev).toMatchObject({ taskId: task.id, threadId: thread.id, evidenceQuote: "Μπορείτε να μου στείλετε τον ΤΙΜΟΚΑΤΑΛΟΓΟ;", evidenceNorm: "μπορειτε να μου στειλετε τον τιμοκαταλογο;", payload: { via: "web", kind: "not_a_task" } });
    expect((await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.id, sugg.id)))[0]!.suggestionState).toBe("expired");

    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted", sortTs: new Date("2026-09-15T08:00:00Z") });
    const ext = await insertExtraction(t.db, m, output([]), handleMapFor());
    const { planner, contexts } = fakePlanner();
    await applyExtractionWith(t.db, m.id, ext.id, clock, { planOperations: planner });
    expect(contexts[0]!.negativeEvidence.has("μπορειτε να μου στειλετε τον τιμοκαταλογο;")).toBe(true);
    expect(contexts[0]!.userDismissedCounterparties.has("client@abc-gr.example")).toBe(true);
  });

  it("handled_by_other / other map to their event ops", async () => {
    const a = await insertTask(t.db, { ...ids() });
    const b = await insertTask(t.db, { ...ids(), title: "Β" });
    await dismissTask(ctx(), a.id, "handled_by_other");
    await dismissTask(ctx(), b.id, "other");
    expect((await userEvents(a.id))[0]!.op).toBe("USER_HANDLED_BY_OTHER");
    expect((await userEvents(b.id))[0]!.op).toBe("USER_DISMISS");
    await expect(dismissTask(ctx(), a.id, "nope" as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it("reopenTask restores the prior open status with a fresh waiting period", async () => {
    const task = await insertTask(t.db, { ...ids(), status: "WAITING_FOR_OTHER" });
    await completeTask(ctx(), task.id);
    clock.advance(86_400_000); // Wed
    await reopenTask(ctx(), task.id);
    const after = await get(task.id);
    expect(after).toMatchObject({ status: "WAITING_FOR_OTHER", closedBy: null, closedAt: null, expectReplyBy: "2026-09-21", version: 3 });
    expect(after.waitingSince?.toISOString()).toBe("2026-09-16T07:00:00.000Z");
    await reopenTask(ctx(), task.id); // already open → no-op
    expect((await get(task.id)).version).toBe(3);
  });
});

describe("snooze", () => {
  it("until_date sets the date (and the follow-up of a waiting task); unsnooze clears it", async () => {
    const task = await insertTask(t.db, { ...ids(), status: "WAITING_FOR_OTHER" });
    await snoozeTask(ctx(), task.id, "until_date", "2026-09-22");
    expect(await get(task.id)).toMatchObject({ snoozeMode: "until_date", snoozedUntil: "2026-09-22", expectReplyBy: "2026-09-22", version: 2 });
    expect((await userEvents(task.id))[0]).toMatchObject({ op: "USER_SNOOZE", payload: { via: "web", mode: "until_date", until: "2026-09-22" } });
    await unsnoozeTask(ctx(), task.id);
    expect(await get(task.id)).toMatchObject({ snoozeMode: null, snoozedUntil: null, version: 3 });
    await unsnoozeTask(ctx(), task.id);
    expect((await get(task.id)).version).toBe(3);
  });

  it("validates mode and dates; a closed task can't be snoozed", async () => {
    const task = await insertTask(t.db, { ...ids() });
    await expect(snoozeTask(ctx(), task.id, "until_date", null)).rejects.toBeInstanceOf(ValidationError);
    await expect(snoozeTask(ctx(), task.id, "until_date", "22/09/2026")).rejects.toBeInstanceOf(ValidationError);
    await expect(snoozeTask(ctx(), task.id, "forever" as never, null)).rejects.toBeInstanceOf(ValidationError);
    await completeTask(ctx(), task.id);
    await expect(snoozeTask(ctx(), task.id, "until_reply", null)).rejects.toBeInstanceOf(ConflictError);
  });

  it("until_reply: the next inbound message in the thread wakes the task", async () => {
    const task = await insertTask(t.db, { ...ids(), status: "WAITING_FOR_OTHER", threadId: thread.id });
    await snoozeTask(ctx(), task.id, "until_reply", null);
    expect(await get(task.id)).toMatchObject({ snoozeMode: "until_reply", snoozedUntil: null });

    const reply = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted", sortTs: new Date("2026-09-15T09:30:00Z"), text: "Σας απαντάμε αύριο." });
    const ext = await insertExtraction(t.db, reply, output([], "FYI"), handleMapFor());
    clock.set("2026-09-15T09:35:00Z");
    await applyExtractionWith(t.db, reply.id, ext.id, clock, { planOperations: fakePlanner().planner });
    expect(await get(task.id)).toMatchObject({ snoozeMode: null, snoozedUntil: null, version: 3 });
    expect(await t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.taskId, task.id), eq(s.taskEvents.op, "SYSTEM_UNSNOOZE")))).toHaveLength(1);
  });
});

describe("edit", () => {
  it("writes and locks only the fields whose value changed; later AI changes to them become suggestions", async () => {
    const task = await insertTask(t.db, { ...ids(), threadId: thread.id, dueDate: "2026-09-18" });
    await t.db.update(s.tasks).set({ duePhrase: "την Παρασκευή", dueKind: "WEEKDAY", priority: "NORMAL" }).where(eq(s.tasks.id, task.id));
    await editTask(ctx({ expectedVersion: 1 }), task.id, { title: task.title, priority: "NORMAL", dueDate: "2026-09-21", nextAction: "Τηλεφώνησε", company: "ABC Α.Ε." });
    const after = await get(task.id);
    expect(after).toMatchObject({ dueDate: "2026-09-21", duePhrase: null, dueKind: null, nextAction: "Τηλεφώνησε", company: "ABC Α.Ε.", priority: "NORMAL", version: 2 });
    expect([...after.lockedFields].sort()).toEqual(["company", "dueDate", "nextAction"]);
    expect(after.searchText).toContain("τηλεφωνησε");
    const [ev] = await userEvents(task.id);
    expect(ev).toMatchObject({ op: "USER_EDIT", before: { dueDate: "2026-09-18", nextAction: null } });

    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted", sortTs: new Date("2026-09-15T08:00:00Z") });
    const ext = await insertExtraction(t.db, m, output([updateOp("K1", { next_action: "Στείλε email", priority: "HIGH" })]), handleMapFor({ tasks: { K1: task.id } }));
    await applyExtractionWith(t.db, m.id, ext.id, clock, { planOperations: fakePlanner().planner });
    const ai = await get(task.id);
    expect(ai).toMatchObject({ nextAction: "Τηλεφώνησε", priority: "HIGH" });
    const [aiEv] = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.extractionId, ext.id));
    expect(aiEv).toMatchObject({ applied: true, suggestionState: "pending", payload: { proposed: { fields: { nextAction: "Στείλε email" } } } });
  });

  it("a status edit on a closed task reopens it; counterparty edits recompute the company domain", async () => {
    const task = await insertTask(t.db, { ...ids(), status: "COMPLETED", closedBy: "ai" });
    await editTask(ctx(), task.id, { status: "WAITING_FOR_ME", counterpartyAddress: "Buyer@xyz.example", counterpartyName: "Αγοραστής" });
    const after = await get(task.id);
    expect(after).toMatchObject({ status: "WAITING_FOR_ME", closedAt: null, closedBy: null, counterpartyAddress: "buyer@xyz.example", companyDomain: "xyz.example", counterpartyName: "Αγοραστής", lockedFields: ["status"] });
    expect(after.waitingSince?.toISOString()).toBe("2026-09-15T07:00:00.000Z");
  });

  it("rejects invalid input and does nothing when nothing changes", async () => {
    const task = await insertTask(t.db, { ...ids() });
    await expect(editTask(ctx(), task.id, { title: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(editTask(ctx(), task.id, { dueDate: "2026-02-30" })).rejects.toBeInstanceOf(ValidationError);
    await expect(editTask(ctx(), task.id, { counterpartyAddress: "not an address" })).rejects.toBeInstanceOf(ValidationError);
    await expect(editTask(ctx(), task.id, { status: "COMPLETED" as never })).rejects.toBeInstanceOf(ValidationError);
    await editTask(ctx(), task.id, { title: task.title, company: task.company });
    expect((await get(task.id)).version).toBe(1);
    expect(await userEvents(task.id)).toHaveLength(0);
  });
});

describe("merge", () => {
  it("moves links, fills blanks, dismisses the merged task with mergedIntoId and re-points earlier merges", async () => {
    const thread2 = await insertThread(t.db, seed.mailbox.id, "αλλο");
    const m1 = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "applied" });
    const m2 = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread2.id, state: "applied" });
    const survivor = await insertTask(t.db, { ...ids(), title: "ABC — Προσφορά", threadId: thread.id, messageId: m1.id });
    const merged = await insertTask(t.db, { ...ids(), title: "ABC — Προσφορά (2)", threadId: thread2.id, messageId: m2.id, dueDate: "2026-09-18" });
    await t.db.update(s.tasks).set({ items: ["Τιμές"], nextAction: "Κάλεσε" }).where(eq(s.tasks.id, merged.id));
    const older = await insertTask(t.db, { ...ids(), title: "ABC — Παλιά" });
    await t.db.update(s.tasks).set({ mergedIntoId: merged.id, status: "DISMISSED" }).where(eq(s.tasks.id, older.id));
    const sugg = await pendingSuggestion(merged.id, { type: "dismiss" });

    await mergeTasks(ctx({ expectedVersion: 1 }), survivor.id, merged.id);

    const sv = await get(survivor.id);
    expect(sv).toMatchObject({ items: ["Τιμές"], nextAction: "Κάλεσε", dueDate: "2026-09-18", version: 2, mergedIntoId: null, status: "ACTION_REQUIRED" });
    const mg = await get(merged.id);
    expect(mg).toMatchObject({ status: "DISMISSED", mergedIntoId: survivor.id, closedBy: "user", version: 2 });
    expect((await get(older.id)).mergedIntoId).toBe(survivor.id);
    const links = await t.db.select().from(s.taskLinks).where(eq(s.taskLinks.taskId, survivor.id));
    expect(links.map((l) => l.threadId).sort()).toEqual([thread.id, thread2.id].sort());
    expect(await t.db.select().from(s.taskLinks).where(eq(s.taskLinks.taskId, merged.id))).toHaveLength(0);
    expect((await userEvents(survivor.id))[0]).toMatchObject({ op: "USER_MERGE", payload: { role: "survivor", mergedId: merged.id } });
    expect((await userEvents(merged.id))[0]).toMatchObject({ op: "USER_MERGE", reasons: ["merged"], after: expect.objectContaining({ mergedIntoId: survivor.id, status: "DISMISSED" }) });
    expect((await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.id, sugg.id)))[0]!.suggestionState).toBe("expired");

    await expect(completeTask(ctx(), merged.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(mergeTasks(ctx(), survivor.id, merged.id)).rejects.toBeInstanceOf(ConflictError);
    await expect(mergeTasks(ctx(), survivor.id, survivor.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it("a merged task's thread keeps offering the survivor to the extractor (links moved)", async () => {
    const thread2 = await insertThread(t.db, seed.mailbox.id, "αλλο");
    const survivor = await insertTask(t.db, { ...ids(), threadId: thread.id });
    const merged = await insertTask(t.db, { ...ids(), title: "Β", threadId: thread2.id });
    await mergeTasks(ctx(), survivor.id, merged.id);
    const { buildExtractionContext } = await import("../../src/engine/context.js");
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread2.id, sortTs: new Date("2026-09-15T08:00:00Z") });
    const { input, handleMap } = await buildExtractionContext(t.db, m.id);
    expect(input.taskCards.map((c) => c.scope)).toEqual(["THREAD_OPEN"]);
    expect(handleMap.tasks.K1).toBe(survivor.id);
  });
});

describe("signals", () => {
  it("confirm clears review; still-valid clears the aging marks; would-have-missed is recorded", async () => {
    const task = await insertTask(t.db, { ...ids() });
    await t.db.update(s.tasks).set({ needsReview: true, reviewReasons: ["implied"], stillValidAskedAt: new Date("2026-09-14T05:00:00Z"), dormantAt: new Date("2026-09-14T05:00:00Z") }).where(eq(s.tasks.id, task.id));
    await confirmTask(ctx(), task.id);
    expect(await get(task.id)).toMatchObject({ needsReview: false, reviewReasons: [], version: 2 });
    await markStillValid(ctx(), task.id);
    expect(await get(task.id)).toMatchObject({ stillValidAskedAt: null, dormantAt: null, version: 3 });
    await markWouldHaveMissed(ctx(), task.id);
    expect((await userEvents(task.id)).map((e) => e.op).sort()).toEqual(["USER_CONFIRM", "USER_STILL_VALID", "USER_WOULD_HAVE_MISSED"]);
    await completeTask(ctx(), task.id);
    await expect(markStillValid(ctx(), task.id)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("resolveSuggestion", () => {
  it("accepting a locked-field update applies it to the current state", async () => {
    const task = await insertTask(t.db, { ...ids(), threadId: thread.id });
    await editTask(ctx(), task.id, { nextAction: "Δικό μου" });
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted", sortTs: new Date("2026-09-15T08:00:00Z") });
    const ext = await insertExtraction(t.db, m, output([updateOp("K1", { next_action: "Στείλε προσφορά", add_items: ["Τιμές"] })]), handleMapFor({ tasks: { K1: task.id } }));
    await applyExtractionWith(t.db, m.id, ext.id, clock, { planOperations: fakePlanner().planner });
    const [ev] = await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.extractionId, ext.id));
    expect(ev!.suggestionState).toBe("pending");
    const version = (await get(task.id)).version;

    await resolveSuggestion(ctx({ expectedVersion: version }), ev!.id, "accept");
    expect(await get(task.id)).toMatchObject({ nextAction: "Στείλε προσφορά", items: ["Τιμές"], version: version + 1 });
    expect((await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.id, ev!.id)))[0]!.suggestionState).toBe("accepted");
    expect((await userEvents(task.id)).map((e) => e.op)).toContain("USER_ACCEPT_SUGGESTION");
    await expect(resolveSuggestion(ctx(), ev!.id, "accept")).rejects.toBeInstanceOf(ConflictError);
  });

  it("complete / dismiss / reopen suggestions; conflicts when the task state moved on", async () => {
    const a = await insertTask(t.db, { ...ids(), status: "WAITING_FOR_ME" });
    const complete = await pendingSuggestion(a.id, { type: "complete" });
    await resolveSuggestion(ctx(), complete.id, "accept");
    expect(await get(a.id)).toMatchObject({ status: "COMPLETED", closedBy: "user", lockedFields: ["status"] });

    const reopen = await pendingSuggestion(a.id, { type: "reopen" });
    await resolveSuggestion(ctx(), reopen.id, "accept");
    expect((await get(a.id)).status).toBe("WAITING_FOR_ME");

    const b = await insertTask(t.db, { ...ids(), title: "Β" });
    const dismiss = await pendingSuggestion(b.id, { type: "dismiss" });
    const lateComplete = await pendingSuggestion(b.id, { type: "complete" });
    await resolveSuggestion(ctx(), dismiss.id, "accept");
    expect((await get(b.id)).status).toBe("DISMISSED");
    // Closing expired the other pending suggestion.
    await expect(resolveSuggestion(ctx(), lateComplete.id, "accept")).rejects.toBeInstanceOf(ConflictError);

    const c = await insertTask(t.db, { ...ids(), title: "Γ", status: "COMPLETED", closedBy: "user" });
    const upd = await pendingSuggestion(c.id, { type: "update", fields: { nextAction: "x" } });
    await expect(resolveSuggestion(ctx(), upd.id, "accept")).rejects.toBeInstanceOf(ConflictError);
  });

  it("an accepted hand-over dismissal is «handled by someone else»: later requests from the customer are not held back", async () => {
    const colleague = { P3: { address: "maria@contoso.example", name: "Μαρία Σταύρου", isOwner: false, isInternal: true } };
    const mine = await insertTask(t.db, { ...ids(), title: "Πιστοποιητικά CE", threadId: thread.id });
    // P1 → Maria: «μπορείς να το αναλάβεις;» ("can you take this on?") → CREATE owner = colleague + SUGGEST_DISMISS of P1's card.
    const handover = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, direction: "OUTBOUND", from: "owner@contoso.example", to: ["maria@contoso.example"], state: "extracted", sortTs: new Date("2026-09-14T08:00:00Z") });
    const ext = await insertExtraction(t.db, handover, output([createOp({ owner: "P3", counterparty: "P2" }), simpleOp("SUGGEST_DISMISS", "K1", "μπορείς να το αναλάβεις;")]), handleMapFor({ tasks: { K1: mine.id }, extra: colleague }));
    await applyExtractionWith(t.db, handover.id, ext.id, clock, { planOperations: fakePlanner().planner });
    const [suggestion] = await t.db.select().from(s.taskEvents).where(and(eq(s.taskEvents.extractionId, ext.id), eq(s.taskEvents.op, "SUGGEST_DISMISS")));
    await resolveSuggestion(ctx(), suggestion!.id, "accept");
    expect(await get(mine.id)).toMatchObject({ status: "DISMISSED", closedBy: "user" });
    expect((await userEvents(mine.id)).find((e) => e.op === "USER_ACCEPT_SUGGESTION")!.payload).toMatchObject({ proposedType: "dismiss", kind: "handled_by_other" });

    // "Someone else has it" by hand: the same.
    const other = await insertTask(t.db, { ...ids(), title: "Άλλο", counterparty: "b@xyz.example", threadId: thread.id });
    await dismissTask(ctx(), other.id, "handled_by_other");

    const dismissedIn = async (sortTs: string) => {
      const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted", sortTs: new Date(sortTs) });
      const e = await insertExtraction(t.db, m, output([]), handleMapFor());
      const { planner, contexts } = fakePlanner();
      await applyExtractionWith(t.db, m.id, e.id, clock, { planOperations: planner });
      return contexts[0]!.userDismissedCounterparties;
    };
    expect([...(await dismissedIn("2026-09-14T09:00:00Z"))]).toEqual([]);

    // A plain "no longer needed" dismissal (no hand-over in its message) still counts, as does "Not a task".
    const cancelled = await insertTask(t.db, { ...ids(), title: "Φωτισμός", counterparty: "c@hotel.example", threadId: thread.id });
    const plain = await pendingSuggestion(cancelled.id, { type: "dismiss" }, { op: "SUGGEST_DISMISS" });
    await resolveSuggestion(ctx(), plain.id, "accept");
    // Reopened and dismissed again as «not a task»: the latest dismissal decides.
    clock.advance(60_000);
    await reopenTask(ctx(), other.id);
    clock.advance(60_000);
    await dismissTask(ctx(), other.id, "not_a_task");
    expect(new Set(await dismissedIn("2026-09-14T10:00:00Z"))).toEqual(new Set(["c@hotel.example", "b@xyz.example"]));
  });

  it("rejecting records the decision; another user's suggestion is not found", async () => {
    const task = await insertTask(t.db, { ...ids() });
    const ev = await pendingSuggestion(task.id, { type: "complete" });
    const other = await otherUser();
    await expect(resolveSuggestion(ctx({ userId: other.id }), ev.id, "reject")).rejects.toBeInstanceOf(NotFoundError);
    await resolveSuggestion(ctx(), ev.id, "reject");
    expect((await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.id, ev.id)))[0]!.suggestionState).toBe("rejected");
    expect(await get(task.id)).toMatchObject({ status: "ACTION_REQUIRED", version: 2 });
    expect((await userEvents(task.id))[0]).toMatchObject({ op: "USER_REJECT_SUGGESTION", payload: { proposedType: "complete" } });
  });

  it("a CREATE suggestion: accept creates the task; reject becomes a negative example for the thread", async () => {
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted" });
    const ext = await insertExtraction(t.db, m, output([createOp(), createOp({ title: "ABC — Δεύτερη", evidence: { source: "NEW", segment_id: "S1", quote: "Καλέστε με αύριο" } })]), handleMapFor());
    await applyExtractionWith(t.db, m.id, ext.id, clock, { planOperations: fakePlanner(() => ({ disposition: "suggest", tier: "review" })).planner });
    const evs = (await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.extractionId, ext.id))).sort((x, y) => x.opIndex! - y.opIndex!);
    expect(await t.db.select().from(s.tasks)).toHaveLength(0);

    await resolveSuggestion(ctx(), evs[0]!.id, "accept");
    const [created] = await t.db.select().from(s.tasks);
    expect(created).toMatchObject({ title: "Προσφορά για 4 ηχεία", ref: 1, origin: "ai", originMessageId: m.id, counterpartyAddress: "client@abc-gr.example" });
    expect((await t.db.select().from(s.taskEvents).where(eq(s.taskEvents.id, evs[0]!.id)))[0]).toMatchObject({ suggestionState: "accepted", taskId: created!.id });
    expect(await t.db.select().from(s.taskLinks).where(and(eq(s.taskLinks.taskId, created!.id), eq(s.taskLinks.role, "origin")))).toHaveLength(1);

    await resolveSuggestion(ctx(), evs[1]!.id, "reject");
    const m2 = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "extracted", sortTs: new Date("2026-09-11T08:00:00Z") });
    const ext2 = await insertExtraction(t.db, m2, output([]), handleMapFor());
    const { planner, contexts } = fakePlanner();
    await applyExtractionWith(t.db, m2.id, ext2.id, clock, { planOperations: planner });
    expect(contexts[0]!.negativeEvidence.has("καλεστε με αυριο")).toBe(true);
  });
});

describe("createManualTask", () => {
  it("creates with the next ref, manual origin, defaults and a link to the message it came from", async () => {
    await t.db.insert(s.companyDomains).values({ orgId: seed.org.id, domain: "xyz.example", company: "XYZ Ε.Π.Ε." });
    await insertTask(t.db, { ...ids() }); // ref 1
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, state: "applied" });
    const res = await createManualTask(ctx(), { title: "  XYZ — Αποστολή δειγμάτων ", status: "WAITING_FOR_OTHER", counterpartyAddress: "Info@xyz.example", fromMessageId: m.id });
    expect(res.ref).toBe(2);
    const task = await get(res.id);
    expect(task).toMatchObject({ title: "XYZ — Αποστολή δειγμάτων", origin: "manual", ownerKind: "ME", mailboxId: seed.mailbox.id, counterpartyAddress: "info@xyz.example", company: "XYZ Ε.Π.Ε.", companyDomain: "xyz.example", expectReplyBy: "2026-09-18", priority: "NORMAL", originMessageId: m.id });
    expect(task.searchText).toContain("xyz");
    expect(await t.db.select().from(s.taskLinks).where(and(eq(s.taskLinks.taskId, res.id), eq(s.taskLinks.role, "manual")))).toEqual([expect.objectContaining({ threadId: thread.id, messageId: m.id })]);
    expect((await userEvents(res.id))[0]).toMatchObject({ op: "USER_CREATE", payload: { via: "web", fromMessageId: m.id } });
  });

  it("validates input and scopes the source message to the user", async () => {
    await expect(createManualTask(ctx(), { title: " ", status: "ACTION_REQUIRED" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createManualTask(ctx(), { title: "Χ", status: "DONE" as never })).rejects.toBeInstanceOf(ValidationError);
    await expect(createManualTask(ctx(), { title: "Χ", status: "ACTION_REQUIRED", dueDate: "tomorrow" })).rejects.toBeInstanceOf(ValidationError);
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id });
    const other = await otherUser();
    await expect(createManualTask(ctx({ userId: other.id }), { title: "Χ", status: "ACTION_REQUIRED", fromMessageId: m.id })).rejects.toBeInstanceOf(NotFoundError);
    const own = await createManualTask(ctx(), { title: "Χωρίς μήνυμα", status: "ACTION_REQUIRED" });
    expect(await get(own.id)).toMatchObject({ mailboxId: seed.mailbox.id, originMessageId: null, waitingSince: null, expectReplyBy: null });
  });
});

describe("apply after user actions", () => {
  it("an AI COMPLETE of a user-locked status becomes a suggestion", async () => {
    const task = await insertTask(t.db, { ...ids(), threadId: thread.id });
    await editTask(ctx(), task.id, { status: "WAITING_FOR_ME" });
    const m = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId: thread.id, direction: "OUTBOUND", from: "owner@contoso.example", state: "extracted", sortTs: new Date("2026-09-15T08:00:00Z") });
    const ext = await insertExtraction(t.db, m, output([simpleOp("COMPLETE", "K1")]), handleMapFor({ tasks: { K1: task.id } }));
    const res = await applyExtractionWith(t.db, m.id, ext.id, clock, { planOperations: fakePlanner().planner });
    expect(res).toMatchObject({ completed: [], suggestions: 1 });
    expect((await get(task.id)).status).toBe("WAITING_FOR_ME");
  });
});
