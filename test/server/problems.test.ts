import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema.js";
import type { ParkedMessage } from "../../src/server/api-types.js";
import { parkedErrorCode } from "../../src/server/routes/problems.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/** Parked messages ("Not analysed"): list, retry, acknowledge — own mailboxes only. */
describe("GET/POST /api/problems", () => {
  let h: Harness;
  let me: Session;
  beforeEach(async () => {
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
      .values({
        mailboxId,
        messageKey: `k${++seq}@x`,
        direction: "INBOUND",
        fromAddress: "maria@abc-gr.example",
        fromName: "Μαρία",
        subject: `Παραγγελία ${seq}`,
        sortTs: new Date(Date.UTC(2026, 8, 10 + seq, 8)),
        state: "failed",
        attempts: 2,
        lastError: "PER_MESSAGE: the model said something about the customer",
        ...o,
      })
      .returning();
    return m!;
  }

  it("lists the user's unacknowledged parked messages, newest first, with an error code only", async () => {
    const older = await message(h.seed.mailbox.id);
    const newer = await message(h.seed.mailbox.id, { lastError: "apply: context" });
    await message(h.seed.mailbox.id, { state: "applied" });
    await message(h.seed.mailbox.id, { failureAcknowledgedAt: new Date("2026-09-14T08:00:00Z") });
    const res = await api(h, me, "GET", "/api/problems");
    expect(res.statusCode).toBe(200);
    const { parked } = res.json() as { parked: ParkedMessage[] };
    expect(parked.map((p) => p.messageId)).toEqual([newer.id, older.id]);
    expect(parked[1]).toEqual({
      messageId: older.id,
      mailboxId: h.seed.mailbox.id,
      date: older.sortTs.toISOString(),
      fromName: "Μαρία",
      fromAddress: "maria@abc-gr.example",
      subject: older.subject,
      error: "PER_MESSAGE",
      attempts: 2,
    } satisfies ParkedMessage);
    expect(parked[0]!.error).toBe("apply:context");
    expect(res.body).not.toContain("the model said");
  });

  it("retry sends the message back to the queue; acknowledge stops reporting it", async () => {
    const a = await message(h.seed.mailbox.id);
    const b = await message(h.seed.mailbox.id);
    expect((await api(h, me, "POST", `/api/problems/${a.id}`, { action: "retry" })).json()).toEqual({ ok: true });
    const [ra] = await h.t.db.select().from(s.messages).where(eq(s.messages.id, a.id));
    expect(ra).toMatchObject({ state: "pending", attempts: 0, nextAttemptAt: null, lastError: null, failureAcknowledgedAt: null });

    expect((await api(h, me, "POST", `/api/problems/${b.id}`, { action: "acknowledge" })).statusCode).toBe(200);
    const [rb] = await h.t.db.select().from(s.messages).where(eq(s.messages.id, b.id));
    expect(rb!.state).toBe("failed");
    expect(rb!.failureAcknowledgedAt!.toISOString()).toBe(h.clock.now().toISOString());
    // Idempotent: a second "Got it" keeps the first time.
    h.clock.advance(60_000);
    expect((await api(h, me, "POST", `/api/problems/${b.id}`, { action: "acknowledge" })).statusCode).toBe(200);
    const [rb2] = await h.t.db.select().from(s.messages).where(eq(s.messages.id, b.id));
    expect(rb2!.failureAcknowledgedAt!.getTime()).toBe(rb!.failureAcknowledgedAt!.getTime());

    expect(((await api(h, me, "GET", "/api/problems")).json() as { parked: ParkedMessage[] }).parked).toEqual([]);
    // A message that is no longer parked cannot be "retried" again.
    expect((await api(h, me, "POST", `/api/problems/${a.id}`, { action: "retry" })).statusCode).toBe(404);
    expect((await api(h, me, "POST", `/api/problems/${a.id}`, { action: "delete" })).statusCode).toBe(400);
  });

  it("never shows or touches someone else's parked messages — admins included", async () => {
    const colleague = await addUser(h, { email: "colleague@contoso.example" });
    const [theirBox] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: colleague.id, address: "colleague@contoso.example", imapHost: "mail.contoso.example" }).returning();
    const theirs = await message(theirBox!.id);
    const admin = await sessionFor(h, (await addUser(h, { email: "admin@contoso.example", role: "admin" })).id);
    for (const sess of [me, admin]) {
      expect(((await api(h, sess, "GET", "/api/problems")).json() as { parked: ParkedMessage[] }).parked).toEqual([]);
      expect((await api(h, sess, "POST", `/api/problems/${theirs.id}`, { action: "acknowledge" })).statusCode).toBe(404);
      expect((await api(h, sess, "POST", `/api/problems/${theirs.id}`, { action: "retry" })).statusCode).toBe(404);
    }
    const [row] = await h.t.db.select().from(s.messages).where(eq(s.messages.id, theirs.id));
    expect(row).toMatchObject({ state: "failed", failureAcknowledgedAt: null });
    expect((await api(h, null, "GET", "/api/problems")).statusCode).toBe(401);
    expect((await api(h, me, "POST", "/api/problems/not-a-uuid", { action: "retry" })).statusCode).toBe(404);
  });

  it("error codes never carry provider or model text", () => {
    expect(parkedErrorCode("PER_MESSAGE: refusal because of <customer text>")).toBe("PER_MESSAGE");
    expect(parkedErrorCode("apply: context")).toBe("apply:context");
    expect(parkedErrorCode("invalid_output")).toBe("invalid_output");
    expect(parkedErrorCode("some free text from somewhere")).toBeNull();
    expect(parkedErrorCode(null)).toBeNull();
  });
});
