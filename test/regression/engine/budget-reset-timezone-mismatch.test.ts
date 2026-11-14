// Regression for review finding budget-reset-timezone-mismatch (engine side): a daily-budget pause follows the org's
// local day. The drain clears an expired budget pause itself, so a reset job running in another zone (the worker's
// 00:05 DEFAULT_TIMEZONE, fixed separately) can no longer leave the mailbox paused for most of the next org day.
// The repro drove the worker's schedule; here the early reset is simulated directly (what resetBudgetPauses does).
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { applyExtractionWith } from "../../../src/engine/apply.js";
import { buildExtractionContext } from "../../../src/engine/context.js";
import { drainMailboxWith, isBudgetPauseExpired, type DrainInternals, type PipelineDeps } from "../../../src/engine/pipeline.js";
import { insertMessage, insertThread, seedOrgUserMailbox, type TestDb } from "../../helpers/db.js";
import { createOp, fakeExtractor, fakePlanner, handleMapFor, insertExtraction, okResult, output, pipelineDeps, sharedTestDb, testClock } from "../../engine-db/fixtures.js";

const shared = sharedTestDb();
let t: TestDb;
let seed: Awaited<ReturnType<typeof seedOrgUserMailbox>>;

beforeEach(async () => {
  t = shared();
  seed = await seedOrgUserMailbox(t.db);
  await t.db.update(s.organizations).set({ timezone: "Europe/London" }).where(eq(s.organizations.id, seed.org.id));
});

const mailbox = async () => (await t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, seed.mailbox.id)))[0]!;
const config = { AI_DAILY_CALL_CAP: 150, AI_DAILY_USD_CAP: 10 };

/** $10 spent by 15:00 London on Thu 10 Sep (the cap) and one more message queued. */
async function overBudgetToday() {
  const threadId = (await insertThread(t.db, seed.mailbox.id)).id;
  const old = await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, subject: "Old", sortTs: new Date("2026-09-10T13:00:00Z"), state: "applied" });
  await insertExtraction(t.db, old, output([]), handleMapFor(), { createdAt: new Date("2026-09-10T14:00:00Z"), state: "applied" });
  await t.db.update(s.extractions).set({ costUsd: 10 });
  return insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, subject: "A", sortTs: new Date("2026-09-10T13:30:00Z") });
}

describe("budget-reset-timezone-mismatch", () => {
  it("an org in Europe/London: re-paused after an early (Athens-midnight) reset, resumed on the next London day", async () => {
    const clock = testClock("2026-09-10T14:01:00Z"); // 15:01 London, Thu 10 Sep
    const queued = await overBudgetToday();
    const ex = fakeExtractor((input) => okResult(output([createOp({ title: `ABC — ${input.message.subject}` })])));
    const internals: DrainInternals = { buildContext: buildExtractionContext, apply: (db, m, e, c) => applyExtractionWith(db, m, e, c, { planOperations: fakePlanner().planner }) };
    const deps: PipelineDeps = pipelineDeps(t, ex, clock, config);
    const drain = () => drainMailboxWith(deps, seed.mailbox.id, {}, internals);

    expect(await drain()).toMatchObject({ budgetPaused: true });
    expect(await mailbox()).toMatchObject({ aiPaused: true, aiPausedReason: "budget:usd" });

    // A reset at 00:05 Athens = 22:05 London (same London day) clears the flag too early …
    clock.set("2026-09-10T21:05:00Z");
    await t.db.update(s.mailboxes).set({ aiPaused: false, aiPausedReason: null }).where(eq(s.mailboxes.id, seed.mailbox.id));
    clock.advance(60_000);
    // … and the next drain pauses again: the London day has not rolled over.
    expect(await drain()).toMatchObject({ budgetPaused: true, processed: 0 });
    expect(ex.calls).toHaveLength(0);

    // Still Thursday in London at 23:59: stays paused (no reset job has to run for this).
    clock.set("2026-09-10T22:59:00Z");
    expect(await drain()).toMatchObject({ budgetPaused: true, processed: 0 });

    // 09:00 London on Fri 11 Sep, a fresh day with zero spend: the drain clears the pause itself and processes.
    clock.set("2026-09-11T08:00:00Z");
    const r = await drain();
    expect(r.budgetPaused).toBe(false);
    expect(r.processed).toBe(1);
    expect(await mailbox()).toMatchObject({ aiPaused: false, aiPausedReason: null });
    expect((await t.db.select().from(s.messages).where(eq(s.messages.id, queued.id)))[0]!.state).toBe("applied");
  });

  it("isBudgetPauseExpired: follows the org zone, not the server's; manual pauses never expire", async () => {
    await overBudgetToday();
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "budget:usd" }).where(eq(s.mailboxes.id, seed.mailbox.id));
    const mb = await mailbox();
    const env = { db: t.db, config };
    // 23:30 London on Thu = 01:30 Athens on Fri: still Thursday for the org.
    expect(await isBudgetPauseExpired(mb, "Europe/London", new Date("2026-09-10T22:30:00Z"), env)).toBe(false);
    expect(await isBudgetPauseExpired(mb, "Europe/Athens", new Date("2026-09-10T22:30:00Z"), env)).toBe(true);
    expect(await isBudgetPauseExpired(mb, "Europe/London", new Date("2026-09-10T23:05:00Z"), env)).toBe(true);
    // A raised cap also ends the pause.
    expect(await isBudgetPauseExpired(mb, "Europe/London", new Date("2026-09-10T15:00:00Z"), { db: t.db, config: { ...config, AI_DAILY_USD_CAP: 20 } })).toBe(true);
    // Not a budget pause / not paused.
    expect(await isBudgetPauseExpired({ ...mb, aiPausedReason: "manual" }, "Europe/London", new Date("2026-09-12T08:00:00Z"), env)).toBe(false);
    expect(await isBudgetPauseExpired({ ...mb, aiPaused: false }, "Europe/London", new Date("2026-09-12T08:00:00Z"), env)).toBe(false);
  });

  it("the drain never clears a manual pause", async () => {
    const clock = testClock("2026-09-12T08:00:00Z");
    await t.db.update(s.mailboxes).set({ aiPaused: true, aiPausedReason: "manual" }).where(eq(s.mailboxes.id, seed.mailbox.id));
    const threadId = (await insertThread(t.db, seed.mailbox.id)).id;
    await insertMessage(t.db, { mailboxId: seed.mailbox.id, threadId, sortTs: new Date("2026-09-12T07:00:00Z") });
    const ex = fakeExtractor(() => okResult(output([], "FYI")));
    const r = await drainMailboxWith(pipelineDeps(t, ex, clock, config), seed.mailbox.id, {}, { buildContext: buildExtractionContext, apply: (db, m, e, c) => applyExtractionWith(db, m, e, c) });
    expect(r).toMatchObject({ processed: 0, budgetPaused: false });
    expect(await mailbox()).toMatchObject({ aiPaused: true, aiPausedReason: "manual" });
  });
});
