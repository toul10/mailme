import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { AiCosts } from "../../src/server/api-types.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/** "AI costs" (GET /api/costs): billed cost per day, mailbox and model; today's budget as the caps count it. */
describe("GET /api/costs", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
    // 2026-09-15T07:00Z = 10:00 Athens.
    h = await makeHarness();
    me = await sessionFor(h, h.seed.user.id);
  });
  afterEach(async () => {
    await h.close();
  });

  let seq = 0;
  async function message(mailboxId: string, o: Partial<typeof s.messages.$inferInsert> = {}) {
    const [m] = await h.t.db
      .insert(s.messages)
      .values({ mailboxId, messageKey: `c${++seq}@x`, direction: "INBOUND", fromAddress: "maria@abc-gr.example", subject: `Subject ${seq}`, sortTs: new Date("2026-09-15T05:00:00Z"), state: "applied", ...o })
      .returning();
    return m!;
  }
  async function call(m: { id: string; mailboxId: string }, at: string, model: string | null, costUsd: number) {
    await h.t.db.insert(s.extractions).values({
      messageId: m.id,
      mailboxId: m.mailboxId,
      pipelineVersion: "p1",
      attempt: ++seq,
      status: "ok",
      requestedModel: model,
      model: model ?? "mock",
      costUsd,
      createdAt: new Date(at),
    });
  }
  async function asked(userId: string, at: string, costUsd: number) {
    await h.t.db.insert(s.securityAudit).values({ userId, event: "chat.ask", detail: { model: "gemini:gemini-3.8-flash@low", costUsd, outcome: "answer" }, createdAt: new Date(at) });
  }
  async function costs(sess: Session = me): Promise<AiCosts> {
    const res = await api(h, sess, "GET", "/api/costs");
    expect(res.statusCode).toBe(200);
    return res.json() as AiCosts;
  }
  async function otherUser() {
    const u = await addUser(h, { email: "colleague@contoso.example" });
    const [mb] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: u.id, address: "colleague@contoso.example", status: "active" }).returning();
    return { user: u, mailbox: mb! };
  }

  it("needs a session", async () => {
    expect((await api(h, null, "GET", "/api/costs")).statusCode).toBe(401);
  });

  it("nothing spent yet: no days and no models", async () => {
    const c = await costs();
    expect(c).toMatchObject({ scope: "own", today: "2026-09-15", monthStart: "2026-09-01", days: [], models: [], chat: { models: [] } });
    expect(c.mailboxes.map((m) => m.id)).toEqual([h.seed.mailbox.id]);
  });

  it("own mailboxes only: billed cost per local day (launch price halved), per model; no-AI calls left out", async () => {
    const mb = h.seed.mailbox.id;
    const [m1, m2, m3, m4] = [await message(mb), await message(mb), await message(mb), await message(mb)];
    await message(mb, { state: "pending" });
    await call(m1, "2026-09-14T08:00:00Z", "gemini-3.8-flash", 0.04); // billed at half until 2027
    await call(m2, "2026-09-15T06:00:00Z", "gemini-3.5-flash-lite", 0.01);
    await call(m2, "2026-09-15T06:01:00Z", "gemini-3.5-flash-lite", 0.01); // a second call for the same message
    await call(m3, "2026-09-15T05:00:00Z", null, 0); // test mode: no AI, but the daily budget still counts it
    await call(m4, "2026-09-12T20:00:00Z", "gemini-3.5-flash-lite", 0.01); // 23:00 Athens on 12/09
    const other = await otherUser();
    await call(await message(other.mailbox.id), "2026-09-15T06:00:00Z", "gemini-3.5-flash-lite", 1);

    const c = await costs();
    expect(c.scope).toBe("own");
    expect(c.days).toEqual([
      { date: "2026-09-12", mail: { [mb]: 0.01 }, mails: 1, chat: 0, questions: 0 },
      { date: "2026-09-13", mail: {}, mails: 0, chat: 0, questions: 0 },
      { date: "2026-09-14", mail: { [mb]: 0.02 }, mails: 1, chat: 0, questions: 0 },
      { date: "2026-09-15", mail: { [mb]: 0.02 }, mails: 1, chat: 0, questions: 0 },
    ]);
    expect(c.models).toEqual([
      { model: "gemini-3.5-flash-lite", mails: 2, calls: 3, usd: 0.03, firstDay: "2026-09-12", lastDay: "2026-09-15" },
      { model: "gemini-3.8-flash", mails: 1, calls: 1, usd: 0.02, firstDay: "2026-09-14", lastDay: "2026-09-14" },
    ]);
    expect(c.mailboxes).toEqual([
      {
        id: mb,
        address: h.seed.mailbox.address,
        name: null,
        // As the daily cap counts: every call since local midnight, at the table's price.
        today: { live: { calls: 3, usd: 0.02 }, early: { calls: 0, usd: 0 }, caps: { calls: 150, usd: 10 }, earlyFactor: 5 },
        paused: null,
        queued: 1,
      },
    ]);
  });

  it("a stored model id is read as the price table writes it (case, \"models/\")", async () => {
    const mb = h.seed.mailbox.id;
    await call(await message(mb), "2026-09-15T06:00:00Z", "models/Gemini-3.8-Flash", 0.04);
    await call(await message(mb), "2026-09-15T06:05:00Z", "gemini-3.8-flash", 0.02);
    const c = await costs();
    expect(c.models).toEqual([{ model: "gemini-3.8-flash", mails: 2, calls: 2, usd: 0.03, firstDay: "2026-09-15", lastDay: "2026-09-15" }]);
  });

  it("other providers' calls count at their stored cost: only Gemini has launch prices", async () => {
    const mb = h.seed.mailbox.id;
    await call(await message(mb), "2026-09-15T06:00:00Z", "claude-sonnet-5", 0.03);
    await call(await message(mb), "2026-09-15T06:05:00Z", "gpt-6", 0.05);
    const c = await costs();
    expect(c.days).toEqual([{ date: "2026-09-15", mail: { [mb]: 0.08 }, mails: 2, chat: 0, questions: 0 }]);
    expect(c.models.map((m) => [m.model, m.usd])).toEqual([
      ["gpt-6", 0.05],
      ["claude-sonnet-5", 0.03],
    ]);
  });

  it("the mailbox's own caps, its pause, and early mail counted apart", async () => {
    const mb = h.seed.mailbox.id;
    await h.t.db
      .update(s.mailboxes)
      .set({ aiDailyCallCap: 600, aiPaused: true, aiPausedReason: "budget:usd", createdAt: new Date("2026-09-15T06:00:00Z") })
      .where(eq(s.mailboxes.id, mb));
    await call(await message(mb, { backfill: true, sortTs: new Date("2026-09-10T08:00:00Z") }), "2026-09-15T06:10:00Z", "gemini-3.5-flash-lite", 0.01);
    await call(await message(mb, { sortTs: new Date("2026-09-15T06:30:00Z") }), "2026-09-15T06:40:00Z", "gemini-3.5-flash-lite", 0.02);
    const [box] = (await costs()).mailboxes;
    expect(box).toMatchObject({
      today: { live: { calls: 1, usd: 0.02 }, early: { calls: 1, usd: 0.01 }, caps: { calls: 600, usd: 10 }, earlyFactor: 5 },
      paused: "budget:usd",
    });
  });

  it("chat: the user's own questions per day, billed at the launch price; an admin sees everyone's and the shared cap", async () => {
    const other = await otherUser();
    await asked(h.seed.user.id, "2026-09-15T06:30:00Z", 0.02);
    await asked(other.user.id, "2026-09-15T06:40:00Z", 0.03);
    let c = await costs();
    expect(c.days).toEqual([{ date: "2026-09-15", mail: {}, mails: 0, chat: 0.01, questions: 1 }]);
    expect(c.chat).toEqual({ models: ["gemini-3.8-flash"], questionsToday: 1, questionCap: 100, all: null });

    await h.t.db.update(s.users).set({ platformAdmin: true }).where(eq(s.users.id, h.seed.user.id));
    c = await costs();
    expect(c.scope).toBe("all");
    expect(c.mailboxes.map((m) => m.address)).toEqual(["colleague@contoso.example", h.seed.mailbox.address]);
    expect(c.days).toEqual([{ date: "2026-09-15", mail: {}, mails: 0, chat: 0.025, questions: 2 }]);
    // The shared cap counts the table's price, as the chat route does.
    expect(c.chat).toEqual({ models: ["gemini-3.8-flash"], questionsToday: 1, questionCap: 100, all: { calls: 2, usd: 0.05, usdCap: 3 } });
  });
});
