import { beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { withSessionLock } from "../../src/db/client.js";
import { clearUnavailablePause } from "../../src/ai/settings.js";
import { createUnavailableExtractor } from "../../src/ai/unavailable.js";
import * as s from "../../src/db/schema.js";
import type { ExtractorResult } from "../../src/domain/types.js";
import { ApplyError, applyExtractionWith, type Planner } from "../../src/engine/apply.js";
import { buildExtractionContext } from "../../src/engine/context.js";
import { GLOBAL_PAUSE_KEY, backoffSec, drainMailboxWith, isGloballyPaused, type DrainInternals, type PipelineDeps } from "../../src/engine/pipeline.js";
import { insertMessage, insertThread, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";
import { createOp, errResult, fakeExtractor, fakePlanner, handleMapFor, insertExtraction, okResult, output, pipelineDeps, testClock, type TestClock, sharedTestDb } from "./fixtures.js";

let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;
let threadId: string;
let clock: TestClock;

const shared = sharedTestDb();
beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
  threadId = (await insertThread(t.db, seed.mailbox.id)).id;
  clock = testClock("2026-09-10T09:00:00Z"); // 12:00 Athens
});

const createFor = (input: { message: { subject: string } }) => okResult(output([createOp({ title: input.message.subject })]));

function internals(planner: Planner = fakePlanner().planner, apply?: DrainInternals["apply"]): DrainInternals {
  return { buildContext: buildExtractionContext, apply: apply ?? ((db, m, e, c) => applyExtractionWith(db, m, e, c, { planOperations: planner })) };
}

async function msg(subject: string, sortTs: string, over: Partial<Parameters<typeof insertMessage>[1]> = {}) {
  return insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, subject, sortTs: new Date(sortTs), ...over });
}
const state = async (id: string) => (await t.db.select().from(s.messages).where(eq(s.messages.id, id)))[0]!;
const drain = (deps: PipelineDeps, i: DrainInternals = internals(), opts: { maxMessages?: number; fullCycleAt?: Date | null } = {}) => drainMailboxWith(deps, seed.mailbox.id, opts, i);

describe("drainMailbox — ordering and eligibility", () => {
  it("processes pending messages in (sort_ts, id) order: extract → store → apply", async () => {
    const b = await msg("B", "2026-09-10T08:30:00Z");
    const a = await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const report = await drain(pipelineDeps(t, ex, clock));
    expect(report).toMatchObject({ processed: 2, extracted: 2, applied: 2, parked: 0, transientBackoff: false, globalPause: false, budgetPaused: false, lockBusy: false });
    expect(ex.calls.map((c) => c.message.subject)).toEqual(["A", "B"]);
    expect((await state(a.id)).state).toBe("applied");
    expect((await state(b.id)).state).toBe("applied");
    const exts = await t.db.select().from(s.extractions).orderBy(asc(s.extractions.createdAt));
    expect(exts).toHaveLength(2);
    expect(exts[0]).toMatchObject({ status: "ok", attempt: 1, pipelineVersion: "test-v1", model: "claude-test", requestedModel: "claude-test", inputTokens: 1000, cacheReadInputTokens: 800 });
    expect((exts[0]!.request as { message: { subject: string } }).message.subject).toBe("A");
    expect((await t.db.select().from(s.tasks)).map((x) => x.title).sort()).toEqual(["A", "B"]);
  });

  it("settle window: an unsettled head blocks the queue, even for already-settled later messages", async () => {
    const early = await msg("Early", "2026-09-10T07:00:00Z");
    await t.db.update(s.messages).set({ firstSeenAt: new Date("2026-09-10T08:59:00Z") }).where(eq(s.messages.id, early.id)); // late Sent copy
    await msg("Settled", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const deps = pipelineDeps(t, ex, clock);
    expect(await drain(deps)).toMatchObject({ processed: 0, transientBackoff: false });
    expect(ex.calls).toHaveLength(0);
    clock.advance(3 * 60_000);
    expect(await drain(deps)).toMatchObject({ processed: 2 });
    expect(ex.calls.map((c) => c.message.subject)).toEqual(["Early", "Settled"]);
  });

  it("fullCycleAt: messages first seen after the last full sync cycle wait", async () => {
    await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const deps = pipelineDeps(t, ex, clock);
    expect(await drain(deps, internals(), { fullCycleAt: new Date("2026-09-10T07:59:00Z") })).toMatchObject({ processed: 0 });
    expect(await drain(deps, internals(), { fullCycleAt: new Date("2026-09-10T08:00:00Z") })).toMatchObject({ processed: 1 });
  });

  it("maxMessages bounds one drain", async () => {
    await msg("A", "2026-09-10T08:00:00Z");
    await msg("B", "2026-09-10T08:01:00Z");
    await msg("C", "2026-09-10T08:02:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock), internals(), { maxMessages: 2 })).toMatchObject({ processed: 2 });
    expect(ex.calls).toHaveLength(2);
  });

  it("reports lockBusy when another drain holds the mailbox lock", async () => {
    await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const inner = await withSessionLock(t, "drain:" + seed.mailbox.id, () => drain(pipelineDeps(t, ex, clock)));
    expect(inner).toMatchObject({ acquired: true, value: { lockBusy: true, processed: 0 } });
    expect(ex.calls).toHaveLength(0);
  });

  it("the late flag reaches both the extractor input and the reconciler", async () => {
    const m = await msg("A", "2026-09-10T08:00:00Z");
    await t.db.update(s.messages).set({ late: true }).where(eq(s.messages.id, m.id));
    const ex = fakeExtractor((input) => createFor(input));
    const { planner, contexts } = fakePlanner();
    await drain(pipelineDeps(t, ex, clock), internals(planner));
    expect(ex.calls[0]!.message.late).toBe(true);
    expect(contexts[0]!.late).toBe(true);
  });
});

describe("drainMailbox — never pay twice", () => {
  it("a crash between extract and apply reuses the stored extraction (one extractor call)", async () => {
    const m = await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const crash = Object.assign(new Error("terminating connection"), { code: "57P01" });
    const crashing: DrainInternals = { buildContext: buildExtractionContext, apply: async () => Promise.reject(crash) };
    expect(await drain(pipelineDeps(t, ex, clock), crashing)).toMatchObject({ processed: 0, extracted: 1, transientBackoff: true, globalPause: false });
    expect((await state(m.id)).state).toBe("extracted");

    const report = await drain(pipelineDeps(t, ex, clock));
    expect(report).toMatchObject({ processed: 1, extracted: 0, applied: 1 });
    expect(ex.calls).toHaveLength(1);
    expect(await t.db.select().from(s.extractions)).toHaveLength(1);
    expect(await t.db.select().from(s.tasks)).toHaveLength(1);
  });

  it("a pending message with an ok extraction for the current pipeline version is not re-extracted", async () => {
    const m = await msg("A", "2026-09-10T08:00:00Z");
    await insertExtraction(t.db, m, output([createOp()]), handleMapFor(), { state: "pending" });
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock))).toMatchObject({ processed: 1, extracted: 0, applied: 1 });
    expect(ex.calls).toHaveLength(0);
  });

  it("an extraction for an older pipeline version is not reused for a pending message", async () => {
    const m = await msg("A", "2026-09-10T08:00:00Z");
    await insertExtraction(t.db, m, output([createOp()]), handleMapFor(), { state: "pending", pipelineVersion: "old" });
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock))).toMatchObject({ processed: 1, extracted: 1 });
    expect(ex.calls).toHaveLength(1);
  });

  it("an 'extracted' message without a usable extraction goes back to pending and is extracted", async () => {
    await msg("A", "2026-09-10T08:00:00Z", { state: "extracted" });
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock))).toMatchObject({ processed: 1, extracted: 1, applied: 1 });
  });

  it("an output the reconciler rejects is re-extracted once, then parked", async () => {
    const m = await msg("A", "2026-09-10T08:00:00Z");
    await msg("B", "2026-09-10T08:10:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const { planner: invalid } = fakePlanner(undefined, { valid: false, reasons: ["too_many_ops"] });
    const { planner: valid } = fakePlanner();
    const planner: Planner = (out, ctx) => (ctx.subject === "A" ? invalid(out, ctx) : valid(out, ctx));
    const report = await drain(pipelineDeps(t, ex, clock), internals(planner));
    expect(report).toMatchObject({ processed: 2, parked: 1, applied: 1, extracted: 3 });
    expect(ex.calls.map((c) => c.message.subject)).toEqual(["A", "A", "B"]);
    expect(await state(m.id)).toMatchObject({ state: "failed", lastError: "invalid_output" });
    const attempts = await t.db.select({ attempt: s.extractions.attempt, status: s.extractions.status }).from(s.extractions).where(eq(s.extractions.messageId, m.id)).orderBy(asc(s.extractions.attempt));
    expect(attempts).toEqual([
      { attempt: 1, status: "error" },
      { attempt: 2, status: "error" },
    ]);
  });
});

describe("drainMailbox — error classes", () => {
  it("TRANSIENT: head backs off (retry-after honoured) and blocks later messages until due", async () => {
    const a = await msg("A", "2026-09-10T08:00:00Z");
    const b = await msg("B", "2026-09-10T08:30:00Z");
    const ex = fakeExtractor((input, n): ExtractorResult => (n === 1 ? errResult("TRANSIENT", 120) : createFor(input)));
    const deps = pipelineDeps(t, ex, clock);

    expect(await drain(deps)).toMatchObject({ processed: 0, transientBackoff: true });
    const afterA = await state(a.id);
    expect(afterA).toMatchObject({ state: "pending", attempts: 1, lastError: "TRANSIENT: transient_error" });
    expect(afterA.nextAttemptAt?.toISOString()).toBe(new Date(clock.now().getTime() + 120_000).toISOString());
    expect((await state(b.id)).state).toBe("pending");

    clock.advance(60_000);
    expect(await drain(deps)).toMatchObject({ processed: 0, transientBackoff: true });
    expect(ex.calls).toHaveLength(1); // B did not overtake A

    clock.advance(61_000);
    expect(await drain(deps)).toMatchObject({ processed: 2, applied: 2, transientBackoff: false });
    expect(ex.calls.map((c) => c.message.subject)).toEqual(["A", "A", "B"]);
    const exts = await t.db.select().from(s.extractions).where(eq(s.extractions.messageId, a.id)).orderBy(asc(s.extractions.attempt));
    expect(exts.map((e) => [e.attempt, e.status, e.errorClass])).toEqual([
      [1, "error", "TRANSIENT"],
      [2, "ok", null],
    ]);
  });

  it("backoff grows exponentially and is capped at 30 minutes", () => {
    expect([1, 2, 3, 4, 7, 20].map(backoffSec)).toEqual([30, 60, 120, 240, 1800, 1800]);
  });

  it("PER_MESSAGE: the message is parked and the queue moves on", async () => {
    const a = await msg("A", "2026-09-10T08:00:00Z");
    const b = await msg("B", "2026-09-10T08:30:00Z");
    const ex = fakeExtractor((input, n) => (n === 1 ? errResult("PER_MESSAGE") : createFor(input)));
    expect(await drain(pipelineDeps(t, ex, clock))).toMatchObject({ processed: 2, parked: 1, applied: 1, extracted: 1 });
    expect(await state(a.id)).toMatchObject({ state: "failed", attempts: 1, lastError: "PER_MESSAGE: per_message_error" });
    expect((await state(b.id)).state).toBe("applied");
  });

  it("GLOBAL: sets the global pause without consuming the message; every drain stops until resumed", async () => {
    const a = await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input, n) => (n === 1 ? errResult("GLOBAL") : createFor(input)));
    const deps = pipelineDeps(t, ex, clock);
    expect(await drain(deps)).toMatchObject({ processed: 0, globalPause: true });
    expect(await state(a.id)).toMatchObject({ state: "pending", attempts: 0 });
    const [flag] = await t.db.select().from(s.appState).where(eq(s.appState.key, GLOBAL_PAUSE_KEY));
    expect(flag!.value).toMatchObject({ reason: "extractor", mailboxId: seed.mailbox.id, messageId: a.id });

    expect(await drain(deps)).toMatchObject({ processed: 0, globalPause: true });
    expect(ex.calls).toHaveLength(1);

    await t.db.delete(s.appState).where(eq(s.appState.key, GLOBAL_PAUSE_KEY));
    expect(await drain(deps)).toMatchObject({ processed: 1, applied: 1, globalPause: false });
  });

  it("a chosen provider that cannot run (no usable key) pauses AI: the message is neither parked nor charged an attempt", async () => {
    const a = await msg("A", "2026-09-10T08:00:00Z");
    expect(await drain(pipelineDeps(t, createUnavailableExtractor("openai", "no_key"), clock))).toMatchObject({ processed: 0, parked: 0, globalPause: true });
    expect(await state(a.id)).toMatchObject({ state: "pending", attempts: 0, nextAttemptAt: null });
    const [flag] = await t.db.select().from(s.appState).where(eq(s.appState.key, GLOBAL_PAUSE_KEY));
    expect(flag!.value).toMatchObject({ reason: "extractor", error: "ai_unavailable:no_key:openai", messageId: a.id });

    // The worker lifts exactly this pause once AI can run (src/worker/ai-runtime.ts); the message then gets the real provider.
    expect(await clearUnavailablePause(t.db)).toBe(true);
    expect(await drain(pipelineDeps(t, fakeExtractor((input) => createFor(input)), clock))).toMatchObject({ processed: 1, applied: 1, globalPause: false });
  });

  it("a stored { paused: false } does not pause", async () => {
    await t.db.insert(s.appState).values({ key: GLOBAL_PAUSE_KEY, value: { paused: false } });
    expect(await isGloballyPaused(t.db)).toBe(false);
  });

  it("an unexpected error is a global pause (code bug), the message stays unconsumed", async () => {
    const a = await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const boom: DrainInternals = { buildContext: buildExtractionContext, apply: async () => Promise.reject(new TypeError("x is undefined")) };
    expect(await drain(pipelineDeps(t, ex, clock), boom)).toMatchObject({ globalPause: true, processed: 0 });
    expect((await state(a.id)).state).toBe("extracted");
    const [flag] = await t.db.select().from(s.appState).where(eq(s.appState.key, GLOBAL_PAUSE_KEY));
    expect(flag!.value).toMatchObject({ reason: "internal_error", error: "TypeError" });
  });

  it("an ApplyError parks only that message", async () => {
    const a = await msg("A", "2026-09-10T08:00:00Z");
    const b = await msg("B", "2026-09-10T08:30:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    const { planner } = fakePlanner();
    const flaky: DrainInternals = {
      buildContext: buildExtractionContext,
      apply: async (db, m, e, c) => (m === a.id ? Promise.reject(new ApplyError("extraction_unusable")) : applyExtractionWith(db, m, e, c, { planOperations: planner })),
    };
    expect(await drain(pipelineDeps(t, ex, clock), flaky)).toMatchObject({ processed: 2, parked: 1, applied: 1, globalPause: false });
    expect(await state(a.id)).toMatchObject({ state: "failed", lastError: "apply: extraction_unusable" });
    expect((await state(b.id)).state).toBe("applied");
  });
});

describe("drainMailbox — AI budget", () => {
  it("pauses the mailbox when the daily call cap is reached", async () => {
    const [a, b, c] = [await msg("A", "2026-09-10T08:00:00Z"), await msg("B", "2026-09-10T08:01:00Z"), await msg("C", "2026-09-10T08:02:00Z")];
    const ex = fakeExtractor((input) => createFor(input));
    const deps = pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 2 });
    expect(await drain(deps)).toMatchObject({ processed: 2, budgetPaused: true });
    expect([(await state(a.id)).state, (await state(b.id)).state, (await state(c.id)).state]).toEqual(["applied", "applied", "pending"]);
    const [mb] = await t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, seed.mailbox.id));
    expect(mb).toMatchObject({ aiPaused: true, aiPausedReason: "budget:calls" });
    expect(await drain(deps)).toMatchObject({ processed: 0, budgetPaused: true });
    expect(ex.calls).toHaveLength(2);
  });

  it("the per-mailbox cap overrides the config cap; the $ cap applies too", async () => {
    await msg("A", "2026-09-10T08:00:00Z");
    await msg("B", "2026-09-10T08:01:00Z");
    await t.db.update(s.mailboxes).set({ aiDailyCallCap: 1 }).where(eq(s.mailboxes.id, seed.mailbox.id));
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 150 }))).toMatchObject({ processed: 1, budgetPaused: true });

    await t.db.update(s.mailboxes).set({ aiDailyCallCap: null, aiPaused: false, aiPausedReason: null }).where(eq(s.mailboxes.id, seed.mailbox.id));
    await t.db.update(s.mailboxes).set({ aiDailyUsdCap: 0.01 }).where(eq(s.mailboxes.id, seed.mailbox.id));
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_USD_CAP: 10 }))).toMatchObject({ processed: 0, budgetPaused: true });
    expect((await t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, seed.mailbox.id)))[0]!.aiPausedReason).toBe("budget:usd");
  });

  it("counts only calls since local midnight in the org zone", async () => {
    const other = await msg("Old", "2026-09-09T08:00:00Z", { state: "applied" });
    // 23:59 Athens on 09-09 → yesterday; the budget window starts 2026-09-09T21:00Z.
    await insertExtraction(t.db, other, output([]), handleMapFor(), { createdAt: new Date("2026-09-09T20:59:00Z"), state: "applied" });
    await msg("A", "2026-09-10T08:00:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 1 }))).toMatchObject({ processed: 1, budgetPaused: false });

    await insertExtraction(t.db, other, output([]), handleMapFor(), { createdAt: new Date("2026-09-09T21:01:00Z"), attempt: 2, state: "applied" });
    await msg("B", "2026-09-10T08:30:00Z");
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 2 }))).toMatchObject({ processed: 0, budgetPaused: true });
  });

  it("early mail (in the mailbox before it was added) has a budget of its own, 5× the caps, apart from new mail", async () => {
    // The mailbox was added at 08:30Z: A and B came in its backfill and are older (early mail); C is backfill too
    // but arrived after the mailbox was added, and D is live: both are new mail.
    await t.db.update(s.mailboxes).set({ createdAt: new Date("2026-09-10T08:30:00Z") }).where(eq(s.mailboxes.id, seed.mailbox.id));
    const a = await msg("A", "2026-09-10T08:00:00Z", { backfill: true });
    const b = await msg("B", "2026-09-10T08:10:00Z", { backfill: true });
    const c = await msg("C", "2026-09-10T08:40:00Z", { backfill: true });
    const d = await msg("D", "2026-09-10T08:50:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    // Cap 1: the early mail may make 5 calls, and it leaves the one call of the new mail untouched.
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 1 }))).toMatchObject({ processed: 3, budgetPaused: true });
    expect([(await state(a.id)).state, (await state(b.id)).state, (await state(c.id)).state, (await state(d.id)).state]).toEqual(["applied", "applied", "applied", "pending"]);
    expect((await t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, seed.mailbox.id)))[0]!.aiPausedReason).toBe("budget:calls");
  });

  it("the early-mail budget stops at 5× the cap, and a higher cap lets it go on the same day", async () => {
    await t.db.update(s.mailboxes).set({ createdAt: new Date("2026-09-10T08:30:00Z") }).where(eq(s.mailboxes.id, seed.mailbox.id));
    for (let i = 0; i < 7; i++) await msg(`E${i}`, `2026-09-10T08:0${i}:00Z`, { backfill: true });
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 1 }))).toMatchObject({ processed: 5, budgetPaused: true });
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 1 }))).toMatchObject({ processed: 0, budgetPaused: true });
    // Cap 2: 10 early calls a day, so the pause lifts and the last two are analysed.
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 2 }))).toMatchObject({ processed: 2, budgetPaused: false });
    expect(ex.calls).toHaveLength(7);
  });

  it("new mail paused at its cap stays paused while only the early budget has room", async () => {
    await t.db.update(s.mailboxes).set({ createdAt: new Date("2026-09-10T08:30:00Z") }).where(eq(s.mailboxes.id, seed.mailbox.id));
    await msg("N1", "2026-09-10T08:40:00Z");
    await msg("N2", "2026-09-10T08:45:00Z");
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 1 }))).toMatchObject({ processed: 1, budgetPaused: true });
    expect(await drain(pipelineDeps(t, ex, clock, { AI_DAILY_CALL_CAP: 1 }))).toMatchObject({ processed: 0, budgetPaused: true });
    expect(ex.calls).toHaveLength(1);
  });

  it("a manual AI pause stops the drain without calling it a budget pause", async () => {
    await msg("A", "2026-09-10T08:00:00Z");
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "manual" }).where(eq(s.mailboxes.id, seed.mailbox.id));
    const ex = fakeExtractor((input) => createFor(input));
    expect(await drain(pipelineDeps(t, ex, clock))).toMatchObject({ processed: 0, budgetPaused: false });
    expect(ex.calls).toHaveLength(0);
  });
});
