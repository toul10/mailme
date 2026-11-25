import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatModel, ChatModelCall, ChatModelResult } from "../../src/chat/model.js";
import { createMockChatModel } from "../../src/chat/mock.js";
import * as s from "../../src/db/schema.js";
import type { ChatEvent, ChatRequest, Me } from "../../src/server/api-types.js";
import { RATE_RULES } from "../../src/server/rate-limit.js";
import { CHAT_DEADLINE_MS } from "../../src/server/routes/chat.js";
import { insertMessage as insertWaitingMessage, insertTask, seedOrgUserMailbox, type MessageSeed, type TestDb } from "../helpers/db.js";
import { api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

/** Mail as the chat reads it: analysed already (mail that still waits for the AI is not shown). */
const insertMessage = (db: TestDb["db"], m: MessageSeed) => insertWaitingMessage(db, { state: "applied", ...m });

const EMPTY = { all_of: [], any_of: [], person: "", after: "", before: "", sender: "anyone", handle: "", status: "open" };
const look = (...lookups: unknown[]) => JSON.stringify({ lookups, answer: "", draft: "", sources: [] });
const answer = (text: string, sources: string[] = []) => JSON.stringify({ lookups: [], answer: text, draft: "", sources });
const USAGE = { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

type Reply = string | ((call: ChatModelCall) => string | Promise<string>);
/** A model that plays a script of JSON texts (the last entry repeats). */
function scripted(script: Reply[], costUsd = 0.002): ChatModel & { calls: ChatModelCall[] } {
  const calls: ChatModelCall[] = [];
  return {
    name: "scripted",
    id: "scripted:test",
    calls,
    async complete(call): Promise<ChatModelResult> {
      calls.push(call);
      const entry = script[Math.min(calls.length - 1, script.length - 1)]!;
      const text = typeof entry === "function" ? await entry(call) : entry;
      return { ok: true, text, model: "scripted-001", usage: USAGE, costUsd, latencyMs: 1 };
    },
  };
}

/** A model whose first call ends only when its signal fires, like a request that hangs; later calls answer. */
function hanging(): ChatModel & { calls: ChatModelCall[]; started: Promise<void> } {
  const calls: ChatModelCall[] = [];
  let begun!: () => void;
  const started = new Promise<void>((r) => (begun = r));
  return {
    name: "hanging",
    id: "hanging:test",
    calls,
    started,
    complete(call): Promise<ChatModelResult> {
      calls.push(call);
      begun();
      if (calls.length > 1) return Promise.resolve({ ok: true, text: answer("τώρα ναι"), model: "hanging-001", usage: USAGE, costUsd: 0, latencyMs: 1 });
      const aborted: ChatModelResult = { ok: false, kind: "aborted", error: "aborted", model: null, usage: null, costUsd: 0, latencyMs: 1 };
      return new Promise((resolve) => {
        if (call.signal?.aborted) resolve(aborted);
        else call.signal?.addEventListener("abort", () => resolve(aborted), { once: true });
      });
    },
  };
}

const events = (payload: string): ChatEvent[] => payload.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChatEvent);
const ask = (h: Harness, sess: Session | null, body: Partial<ChatRequest> | Record<string, unknown> = { question: "Τι εκκρεμεί;" }) => api(h, sess, "POST", "/api/chat", { history: [], ...body });
const auditRows = async (h: Harness) => (await h.t.db.select().from(s.securityAudit).where(eq(s.securityAudit.event, "chat.ask"))).sort((a, b) => a.id - b.id);

describe("“Ask your mail” (POST /api/chat)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  const harnessWith = async (chatModel: ChatModel | null, opts: { config?: Record<string, string>; chatDeadlineMs?: number } = {}) => {
    h = await makeHarness({ chatModel, ...opts });
    return sessionFor(h, h.seed.user.id);
  };

  it("is not there where the chat is off (the default), and /api/me says so", async () => {
    const sess = await harnessWith(null);
    expect((await ask(h, sess)).statusCode).toBe(404);
    expect(((await api(h, sess, "GET", "/api/me")).json() as Me).chat).toBe(false);
    expect(await auditRows(h)).toEqual([]);
  });

  it("needs a signed-in session with MFA passed, and the CSRF token", async () => {
    const model = scripted([answer("ok")]);
    const sess = await harnessWith(model);
    expect(((await api(h, sess, "GET", "/api/me")).json() as Me).chat).toBe(true);
    expect((await ask(h, null)).statusCode).toBe(401);
    const noCsrf = await h.app.inject({ method: "POST", url: "/api/chat", cookies: sess.cookies, payload: { question: "Γεια", history: [] } });
    expect(noCsrf.statusCode).toBe(403);
    const halfway = await sessionFor(h, h.seed.user.id, false);
    expect((await ask(h, halfway)).json()).toMatchObject({ code: "mfa_required" });
    expect((await h.app.inject({ method: "GET", url: "/api/chat", cookies: sess.cookies })).statusCode).toBe(404);
    expect(model.calls).toHaveLength(0);
    expect(await auditRows(h)).toEqual([]);
  });

  it("refuses a body that is not a question, before any model call", async () => {
    const model = scripted([answer("ok")]);
    const sess = await harnessWith(model);
    const turn = { question: "q", answer: "a", draft: null, sources: [] };
    const bad: Array<Record<string, unknown>> = [
      { question: "" },
      { question: "   " },
      { question: "α".repeat(2001) },
      { question: 42 },
      { question: "ok", history: "none" },
      { question: "ok", history: Array.from({ length: 13 }, () => turn) },
      { question: "ok", history: [{ ...turn, answer: "α".repeat(12_001) }] },
      { question: "ok", history: [{ ...turn, sources: [{ kind: "folder", id: "x" }] }] },
      { question: "ok", history: [{ ...turn, sources: [{ kind: "mail", id: "x".repeat(65) }] }] },
      // More sources than an answer can have (CHAT_LIMITS.answerSources) or the web client sends (HISTORY_SOURCES).
      { question: "ok", history: [{ ...turn, sources: Array.from({ length: 61 }, () => ({ kind: "mail", id: "x" })) }] },
    ];
    for (const body of bad) {
      const res = await ask(h, sess, body);
      expect([res.statusCode, (res.json() as { code: string }).code]).toEqual([400, "invalid"]);
      // The refusal names the field, never its value.
      expect(res.payload).not.toContain("ααα");
    }
    expect((await h.app.inject({ method: "POST", url: "/api/chat", cookies: sess.cookies, headers: { "x-csrf-token": sess.csrf, "content-type": "text/plain" }, payload: "Τι εκκρεμεί;" })).statusCode).toBe(415);
    expect(model.calls).toHaveLength(0);
    // Optional parts may be left out: no history, a turn without a draft.
    expect((await api(h, sess, "POST", "/api/chat", { question: "ok" })).statusCode).toBe(200);
    expect((await ask(h, sess, { question: "ok", history: [{ question: "q", answer: "a", sources: [] }] })).statusCode).toBe(200);
  });

  it("streams what is being looked up and then the answer, and records the use without any of the content", async () => {
    // The script is filled in once the mail exists (the model reads it when it is called).
    const script: Reply[] = [];
    const model = scripted(script);
    const sess = await harnessWith(model);
    const mail = await insertMessage(h.t.db, { mailboxId: h.seed.mailbox.id, subject: "Προσφορά ηχείων", from: "g.pap@abc-gr.example", fromName: "Γιώργος", text: "Θέλουμε προσφορά για 4 ηχεία, ΑΦΜ 099999999.", sortTs: new Date("2026-09-14T08:00:00Z") });
    const task = await insertTask(h.t.db, { orgId: h.seed.org.id, userId: h.seed.user.id, mailboxId: h.seed.mailbox.id, title: "ABC — Προσφορά για 4 ηχεία", messageId: mail.id });
    const handle = `M${mail.id.replace(/-/g, "").slice(0, 6)}`;
    script.push(look({ ...EMPTY, tool: "search_mail", all_of: ["προσφορ"] }, { ...EMPTY, tool: "search_tasks", status: "mine" }), look({ ...EMPTY, tool: "read_thread", handle }), answer(`Η ABC ζητά προσφορά για 4 ηχεία [${handle}] — εκκρεμότητα [#${task.ref}].`));

    const res = await ask(h, sess, { question: "Τι μου ζήτησε η ABC; (μυστική ερώτηση)" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.payload.endsWith("\n")).toBe(true);
    const got = events(res.payload);
    expect(got.slice(0, 3)).toEqual([
      { type: "step", label: "Searching your mail: “προσφορ”" },
      { type: "step", label: "Looking at your tasks" },
      { type: "step", label: "Reading the conversation “Προσφορά ηχείων”" },
    ]);
    expect(got[3]).toEqual({
      type: "answer",
      answer: `Η ABC ζητά προσφορά για 4 ηχεία [${handle}] — εκκρεμότητα [#${task.ref}].`,
      draft: null,
      sources: [
        { kind: "mail", handle, messageId: mail.id, date: "2026-09-14T08:00:00.000Z", fromName: "Γιώργος", fromAddress: "g.pap@abc-gr.example", own: false, unverified: false, subject: "Προσφορά ηχείων", excerpt: "Θέλουμε προσφορά για 4 ηχεία, ΑΦΜ 099999999.", attachments: [], task: { id: task.id, ref: task.ref } },
        { kind: "task", handle: `#${task.ref}`, taskId: task.id, ref: task.ref, title: "ABC — Προσφορά για 4 ηχεία", status: "ACTION_REQUIRED" },
      ],
    });
    expect(got).toHaveLength(4);
    // The model was told the user's zone and the retention this install runs with.
    expect(model.calls[0]!.user).toContain('time_zone="Europe/Athens"');
    expect(model.calls[0]!.system).toContain(`kept for about ${h.config.BODY_RETENTION_DAYS} days`);

    const rows = await auditRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: h.seed.org.id, userId: h.seed.user.id, ip: "127.0.0.1" });
    expect(rows[0]!.detail).toEqual({ outcome: "answer", model: "scripted:test", calls: 3, rounds: 2, lookups: 3, sources: 2, inputTokens: 3000, outputTokens: 150, cachedTokens: 0, costUsd: 0.006, ms: expect.any(Number) });
    // Neither the audit row nor the log holds a word of the question, the mail or the answer.
    const written = JSON.stringify(rows) + JSON.stringify(h.logs);
    for (const secret of ["μυστική", "ABC", "ηχεί", "099999999", "g.pap", "Προσφορ", "προσφορ", handle]) expect(written).not.toContain(secret);
    expect(h.logs.filter((l) => l.msg === "http").at(-1)!.obj).toMatchObject({ method: "POST", route: "/api/chat", status: 200 });
  });

  it("answers only from the asking user's own mail, whoever shares the organization", async () => {
    const sess = await harnessWith(createMockChatModel());
    const { eq: equals } = await import("drizzle-orm");
    const [colleague] = await h.t.db.insert(s.users).values({ orgId: h.seed.org.id, name: "Συνάδελφος", email: "boss@contoso.example", role: "admin" }).returning();
    const [box] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: colleague!.id, address: "boss@contoso.example" }).returning();
    await insertMessage(h.t.db, { mailboxId: box!.id, subject: "Μισθοδοσία Νοεμβρίου", text: "Εμπιστευτικό: μισθοδοσία.", sortTs: new Date("2026-09-14T08:00:00Z") });
    await insertMessage(h.t.db, { mailboxId: h.seed.mailbox.id, subject: "Μισθοδοσία: ερώτηση πελάτη", text: "Πότε πληρώνετε;", sortTs: new Date("2026-09-14T09:00:00Z") });
    expect((await h.t.db.select().from(s.messages).where(equals(s.messages.mailboxId, box!.id))).length).toBe(1);

    const mine = events((await ask(h, sess, { question: "Μισθοδοσία;" })).payload).at(-1)!;
    expect(mine.type === "answer" && mine.sources.map((x) => (x.kind === "mail" ? x.subject : x.title))).toEqual(["Μισθοδοσία: ερώτηση πελάτη"]);
    const theirs = events((await ask(h, await sessionFor(h, colleague!.id), { question: "Μισθοδοσία;" })).payload).at(-1)!;
    expect(theirs.type === "answer" && theirs.sources.map((x) => (x.kind === "mail" ? x.subject : x.title))).toEqual(["Μισθοδοσία Νοεμβρίου"]);
  });

  it("asks about one mailbox when the request names one of the user's own, and about all of them otherwise", async () => {
    const sess = await harnessWith(createMockChatModel());
    const [second] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: h.seed.user.id, address: "purchasing@contoso.example", status: "active" }).returning();
    await insertMessage(h.t.db, { mailboxId: h.seed.mailbox.id, subject: "Τιμολόγιο ηχείων", text: "Το τιμολόγιο των ηχείων.", sortTs: new Date("2026-09-14T08:00:00Z") });
    await insertMessage(h.t.db, { mailboxId: second!.id, subject: "Τιμολόγιο καλωδίων", text: "Το τιμολόγιο των καλωδίων.", sortTs: new Date("2026-09-14T09:00:00Z") });
    const subjectsOf = async (body: Record<string, unknown>) => {
      const res = await ask(h, sess, { question: "Τιμολόγιο;", ...body });
      expect(res.statusCode).toBe(200);
      const last = events(res.payload).at(-1)!;
      return last.type === "answer" ? last.sources.map((x) => (x.kind === "mail" ? x.subject : x.title)).sort() : last;
    };
    expect(await subjectsOf({})).toEqual(["Τιμολόγιο ηχείων", "Τιμολόγιο καλωδίων"]);
    expect(await subjectsOf({ mailboxId: null })).toEqual(["Τιμολόγιο ηχείων", "Τιμολόγιο καλωδίων"]);
    expect(await subjectsOf({ mailboxId: second!.id })).toEqual(["Τιμολόγιο καλωδίων"]);
    expect(await subjectsOf({ mailboxId: h.seed.mailbox.id })).toEqual(["Τιμολόγιο ηχείων"]);
    // The use is recorded as for any question; which mailbox was asked about is not part of the record.
    expect(JSON.stringify(await auditRows(h))).not.toContain(second!.id);
  });

  it("refuses a mailbox that is not the user's own before any model call, and the refusal does not keep the lock", async () => {
    const model = scripted([answer("ok")]);
    const sess = await harnessWith(model);
    const [colleague] = await h.t.db.insert(s.users).values({ orgId: h.seed.org.id, name: "Συνάδελφος", email: "boss@contoso.example" }).returning();
    const [theirs] = await h.t.db.insert(s.mailboxes).values({ orgId: h.seed.org.id, userId: colleague!.id, address: "boss@contoso.example" }).returning();
    for (const mailboxId of [theirs!.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const res = await ask(h, sess, { question: "Τι εκκρεμεί;", mailboxId });
      expect([res.statusCode, (res.json() as { code: string }).code], mailboxId).toEqual([404, "not_found"]);
    }
    for (const mailboxId of [42, "x".repeat(65), { id: theirs!.id }]) {
      const res = await ask(h, sess, { question: "Τι εκκρεμεί;", mailboxId });
      expect([res.statusCode, (res.json() as { code: string }).code]).toEqual([400, "invalid"]);
    }
    expect(model.calls).toHaveLength(0);
    expect(await auditRows(h)).toEqual([]);
    // Nothing is left running: the next question is answered.
    expect((await ask(h, sess)).statusCode).toBe(200);
    expect(model.calls).toHaveLength(1);
  });

  it("reads the install's deny-list from its settings, and leaves out mail the AI has not read yet", async () => {
    const sess = await harnessWith(createMockChatModel(), { config: { DENY_LIST: "@lawyers.example, doctor@clinic.example" } });
    const base = { mailboxId: h.seed.mailbox.id, sortTs: new Date("2026-09-14T08:00:00Z") };
    await insertMessage(h.t.db, { ...base, subject: "Γνωμάτευση δικηγόρου", from: "maria@lawyers.example", text: "Εμπιστευτικό." });
    await insertMessage(h.t.db, { ...base, subject: "Γνωμάτευση γιατρού", from: "Doctor@Clinic.example", text: "Εμπιστευτικό." });
    await insertWaitingMessage(h.t.db, { ...base, subject: "Γνωμάτευση σε αναμονή", from: "new@abc-gr.example", text: "Δεν έχει διαβαστεί ακόμα." });
    await insertMessage(h.t.db, { ...base, subject: "Γνωμάτευση μηχανικού", from: "eng@abc-gr.example", text: "Η γνωμάτευση του μηχανικού." });

    const res = await ask(h, sess, { question: "Γνωμάτευση;" });
    const last = events(res.payload).at(-1)!;
    expect(last.type === "answer" && last.sources.map((x) => (x.kind === "mail" ? x.subject : x.title))).toEqual(["Γνωμάτευση μηχανικού"]);
    expect(res.payload).not.toMatch(/δικηγόρου|γιατρού|σε αναμονή/);
  });

  it("one question at a time for each user", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = scripted([async () => (await gate, answer("πρώτη")), answer("επόμενη")]);
    const sess = await harnessWith(model);
    const other = await seedOrgUserMailbox(h.t.db, { address: "second@contoso.example" });
    const otherSess = await sessionFor(h, other.user.id);

    const first = ask(h, sess);
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    const second = await ask(h, sess);
    expect([second.statusCode, second.headers["retry-after"]]).toEqual([429, "5"]);
    expect(second.json()).toEqual({ code: "rate_limited", error: "Wait for your previous question to finish." });
    // Somebody else is not held up.
    expect(events((await ask(h, otherSess)).payload).at(-1)).toMatchObject({ type: "answer", answer: "επόμενη" });

    release();
    expect(events((await first).payload).at(-1)).toMatchObject({ type: "answer", answer: "πρώτη" });
    expect(events((await ask(h, sess)).payload).at(-1)).toMatchObject({ type: "answer" });
    // The refused one called no model and left no record.
    expect(model.calls).toHaveLength(3);
    expect(await auditRows(h)).toHaveLength(3);
  });

  it("questions of one user that arrive together: one is answered, the others are refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = scripted([async () => (await gate, answer("πρώτη")), answer("επόμενη")]);
    const sess = await harnessWith(model);
    // A database over a network answers some milliseconds later. The embedded one of the tests answers within the
    // same turn of the event loop, which hides what the other requests do in between: here the day's usage is slow.
    const execute = h.t.db.execute.bind(h.t.db);
    vi.spyOn(h.t.db, "execute").mockImplementation((async (query: Parameters<typeof execute>[0]) => {
      await new Promise((r) => setTimeout(r, 25));
      return execute(query);
    }) as typeof h.t.db.execute);

    // All three are on their way before any of them has read the day's usage.
    const together = [ask(h, sess), ask(h, sess), ask(h, sess)];
    await vi.waitFor(() => expect(model.calls).toHaveLength(1));
    release();
    const replies = await Promise.all(together);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 429, 429]);
    expect(events(replies.find((r) => r.statusCode === 200)!.payload).at(-1)).toMatchObject({ type: "answer", answer: "πρώτη" });
    expect(model.calls).toHaveLength(1);
    expect(await auditRows(h)).toHaveLength(1);
    // The lock is free again afterwards.
    expect(events((await ask(h, sess)).payload).at(-1)).toMatchObject({ type: "answer", answer: "επόμενη" });
  });

  it("a question refused for the day's limit does not keep the lock", async () => {
    const model = scripted([answer("ναι")]);
    const sess = await harnessWith(model, { config: { CHAT_DAILY_QUESTION_CAP: "1" } });
    expect((await ask(h, sess)).statusCode).toBe(200);
    // Refused for the limit, twice: the second refusal is still about the limit, not about a question "still running".
    for (let i = 0; i < 2; i++) {
      const refused = await ask(h, sess);
      expect([refused.statusCode, refused.json().error]).toEqual([429, "You've reached today's limit of questions. Try again tomorrow."]);
    }
    expect(model.calls).toHaveLength(1);
  });

  it("a user's questions per day and everyone's cost per day have a limit; the next day starts again", async () => {
    const model = scripted([answer("ok")], 0.04);
    const sess = await harnessWith(model, { config: { CHAT_DAILY_QUESTION_CAP: "2", CHAT_DAILY_USD_CAP: "0.1" } });
    const other = await seedOrgUserMailbox(h.t.db, { address: "second@contoso.example" });
    const otherSess = await sessionFor(h, other.user.id);
    // The harness clock is not the database's: the rows of this test are stamped with the harness's day.
    const stamp = () => h.t.db.update(s.securityAudit).set({ createdAt: h.clock.now() });

    expect((await ask(h, sess)).statusCode).toBe(200);
    expect((await ask(h, sess)).statusCode).toBe(200);
    await stamp();
    const third = await ask(h, sess);
    expect([third.statusCode, third.json()]).toEqual([429, { code: "rate_limited", error: "You've reached today's limit of questions. Try again tomorrow." }]);
    expect(third.headers["retry-after"]).toBeUndefined();

    // 0.08 $ so far: one more question fits under 0.10 $, and then the chat is closed for everybody.
    expect((await ask(h, otherSess)).statusCode).toBe(200);
    await stamp();
    const closed = await ask(h, otherSess);
    expect([closed.statusCode, closed.json()]).toEqual([429, { code: "rate_limited", error: "The chat has reached its daily limit. Try again tomorrow." }]);
    expect(model.calls).toHaveLength(3);

    h.clock.advance(24 * 3_600_000);
    expect((await ask(h, sess)).statusCode).toBe(200);
    expect((await ask(h, otherSess)).statusCode).toBe(200);
  });

  it("many questions in a short time are slowed down, each user on their own", async () => {
    const model = scripted([answer("ok")], 0);
    const sess = await harnessWith(model);
    const other = await seedOrgUserMailbox(h.t.db, { address: "second@contoso.example" });
    for (let i = 0; i < RATE_RULES.chat.capacity; i++) expect((await ask(h, sess)).statusCode).toBe(200);
    const refused = await ask(h, sess);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect((await ask(h, await sessionFor(h, other.user.id))).statusCode).toBe(200);
    h.clock.advance(RATE_RULES.chat.windowMs / RATE_RULES.chat.capacity + 1000);
    expect((await ask(h, sess)).statusCode).toBe(200);
    expect(model.calls).toHaveLength(RATE_RULES.chat.capacity + 2);
  });

  it("a question that takes too long is stopped with a message of its own", async () => {
    const model = hanging();
    const sess = await harnessWith(model, { chatDeadlineMs: 40 });
    const res = await ask(h, sess);
    expect(res.statusCode).toBe(200);
    expect(events(res.payload)).toEqual([{ type: "error", code: "too_slow", message: "That took too long, so I stopped. Try a more specific question." }]);
    expect(model.calls[0]!.signal?.aborted).toBe(true);
    expect((await auditRows(h))[0]!.detail).toMatchObject({ outcome: "aborted", calls: 1 });
    // The lock is free again.
    expect(events((await ask(h, sess)).payload)).toEqual([{ type: "answer", answer: "τώρα ναι", draft: null, sources: [] }]);
    // The platform in front cuts a request at 120 s (deploy/gcp/40-deploy.sh): our own limit must come first.
    expect(CHAT_DEADLINE_MS).toBeLessThan(120_000);
  });

  it("a failure of the model or of a lookup ends the stream with an error line, and is recorded", async () => {
    const boom: ChatModel = { name: "boom", id: "boom:test", complete: async () => Promise.reject(new Error("secret detail of the failure")) };
    const sess = await harnessWith(boom);
    const res = await ask(h, sess);
    expect(res.statusCode).toBe(200);
    expect(events(res.payload)).toEqual([{ type: "error", code: "internal", message: "Something went wrong. Try again." }]);
    expect((await auditRows(h))[0]!.detail).toMatchObject({ outcome: "error:internal" });
    expect(JSON.stringify(h.logs)).not.toContain("secret detail");
    expect(h.logs.find((l) => l.msg === "chat: the question failed")).toMatchObject({ level: "error" });

    await h.close();
    const down: ChatModel = { name: "down", id: "down:test", complete: async () => ({ ok: false, kind: "no_credit", error: "http_402:RESOURCE_EXHAUSTED", model: null, usage: null, costUsd: 0, latencyMs: 3 }) };
    const sess2 = await harnessWith(down);
    expect(events((await ask(h, sess2)).payload)).toEqual([{ type: "error", code: "ai_unavailable", message: "The AI isn't available right now. Tell your administrator." }]);
    expect((await auditRows(h))[0]!.detail).toMatchObject({ outcome: "error:no_credit", calls: 1 });
    expect(h.logs.find((l) => l.msg === "chat: the model call failed")).toMatchObject({ level: "error", obj: { code: "http_402:RESOURCE_EXHAUSTED", kind: "no_credit" } });
  });

  it("a reader who closes the page stops the model call, frees the lock and is recorded as such", async () => {
    const model = hanging();
    const sess = await harnessWith(model);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = h.app.server.address() as AddressInfo;
    const body = JSON.stringify({ question: "Τι εκκρεμεί;", history: [] });
    const cookie = Object.entries(sess.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const req = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), cookie, "x-csrf-token": sess.csrf } });
    req.on("error", () => {});
    req.end(body);

    await model.started;
    expect(model.calls[0]!.signal?.aborted).toBe(false);
    req.destroy();
    await vi.waitFor(() => expect(model.calls[0]!.signal?.aborted).toBe(true));
    await vi.waitFor(async () => expect((await auditRows(h)).map((r) => (r.detail as { outcome: string }).outcome)).toEqual(["aborted"]));
    // Nothing is stuck: the same user can ask again at once.
    expect(events((await ask(h, sess)).payload)).toEqual([{ type: "answer", answer: "τώρα ναι", draft: null, sources: [] }]);
  });

  it("a reader who goes away before the question has started costs nothing and does not keep the lock", async () => {
    const model = scripted([answer("ναι")]);
    const sess = await harnessWith(model);
    // The day's usage is being read when the reader leaves.
    const execute = h.t.db.execute.bind(h.t.db);
    let reading!: () => void;
    const usageRead = new Promise<void>((r) => (reading = r));
    let letGo!: () => void;
    const gate = new Promise<void>((r) => (letGo = r));
    vi.spyOn(h.t.db, "execute").mockImplementationOnce((async (query: Parameters<typeof execute>[0]) => {
      reading();
      await gate;
      return execute(query);
    }) as typeof h.t.db.execute);
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = h.app.server.address() as AddressInfo;
    const body = JSON.stringify({ question: "Τι εκκρεμεί;", history: [] });
    const cookie = Object.entries(sess.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const req = http.request({ host: "127.0.0.1", port, path: "/api/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), cookie, "x-csrf-token": sess.csrf } });
    req.on("error", () => {});
    req.end(body);

    await usageRead;
    req.destroy();
    await new Promise((r) => setTimeout(r, 60)); // the server has seen the closed connection
    letGo();
    await new Promise((r) => setTimeout(r, 60));
    expect(model.calls).toHaveLength(0);
    // Nothing is stuck: the same user can ask again at once.
    expect(events((await ask(h, sess)).payload)).toEqual([{ type: "answer", answer: "ναι", draft: null, sources: [] }]);
    expect(model.calls).toHaveLength(1);
  });
});
