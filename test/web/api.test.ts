import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../src/server/api-types.js";
import { ApiClient, ApiRequestError, CSRF_STORAGE_KEY, errorMessage, mailboxViewQuery, parseChatEvent, taskListQueryString, type KeyValueStore } from "../../web/src/api.js";

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch fake that records calls and answers from a queue. */
function fakeFetch(...responses: Array<Response | (() => Response)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return typeof next === "function" ? next() : next;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function header(call: Call | undefined, name: string): string | undefined {
  const h = (call?.init.headers ?? {}) as Record<string, string>;
  return h[name];
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const ME = {
  id: "u1",
  name: "Demo User",
  email: "k@contoso.example",
  role: "member",
  mfaVerified: true,
  csrfToken: "csrf-from-me",
  timezone: "Europe/Athens",
  digestTime: "07:30",
  digestDelivery: "append",
  digestEnabled: true,
};

describe("api client: CSRF and credentials", () => {
  it("takes the token from the login response and sends it only on mutations", async () => {
    const { fn, calls } = fakeFetch(
      jsonResponse(200, { ok: true, next: "none", csrfToken: "tok-1" }),
      jsonResponse(200, { items: [], counts: {}, nextCursor: null }),
      jsonResponse(200, { id: "t1" }),
    );
    const api = new ApiClient({ fetch: fn });
    await api.login({ email: "k@contoso.example", password: "pw" });
    await api.listTasks({ tab: "todo" });
    await api.editTask("t1", { version: 3, priority: "HIGH" });

    expect(header(calls[0], "x-csrf-token")).toBeUndefined(); // no token yet at login
    expect(header(calls[1], "x-csrf-token")).toBeUndefined(); // GET
    expect(calls[1]!.init.method).toBe("GET");
    expect(header(calls[2], "x-csrf-token")).toBe("tok-1");
    expect(calls[2]!.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ version: 3, priority: "HIGH" });
    for (const c of calls) expect(c.init.credentials).toBe("same-origin");
  });

  it("refreshes the token from /api/me and sends {} as the body of payload-less POSTs", async () => {
    const { fn, calls } = fakeFetch(jsonResponse(200, ME), jsonResponse(200, { token: "ingest-secret" }));
    const api = new ApiClient({ fetch: fn });
    api.setCsrfToken("stale");
    await api.me();
    await api.issueIngestToken("mb 1");
    expect(api.csrfToken).toBe("csrf-from-me");
    expect(calls[1]!.url).toBe("/api/mailboxes/mb%201/ingest-token");
    expect(header(calls[1], "x-csrf-token")).toBe("csrf-from-me");
    expect(header(calls[1], "content-type")).toBe("application/json");
    expect(calls[1]!.init.body).toBe("{}");
  });

  it("persists the token across reloads in the injected storage and clears it on logout", async () => {
    const store = memoryStore();
    const { fn } = fakeFetch(jsonResponse(200, { ok: true, next: "totp", csrfToken: "tok-2" }), jsonResponse(200, { ok: true }));
    const first = new ApiClient({ fetch: fn, storage: store });
    await first.login({ email: "a@b-gr.example", password: "x" });
    expect(store.data.get(CSRF_STORAGE_KEY)).toBe("tok-2");

    const { fn: fn2, calls } = fakeFetch(jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true }));
    const reloaded = new ApiClient({ fetch: fn2, storage: store });
    await reloaded.verifyTotp({ code: "123456", rememberDevice: true });
    expect(header(calls[0], "x-csrf-token")).toBe("tok-2");
    await reloaded.logout();
    expect(store.data.has(CSRF_STORAGE_KEY)).toBe(false);
    expect(reloaded.csrfToken).toBeNull();
  });

  it("survives a storage that throws", async () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const { fn, calls } = fakeFetch(jsonResponse(200, { ok: true, next: "none", csrfToken: "t" }), jsonResponse(200, { ok: true }));
    const api = new ApiClient({ fetch: fn, storage: broken });
    await api.login({ email: "a@b-gr.example", password: "x" });
    await api.confirmTotp("123456");
    expect(header(calls[1], "x-csrf-token")).toBe("t");
  });
});

describe("api client: errors", () => {
  it("reports unauthorized and mfa_required from any endpoint except /api/auth/*", async () => {
    const onAuthError = vi.fn();
    const { fn } = fakeFetch(
      jsonResponse(401, { error: "no session", code: "unauthorized" }),
      jsonResponse(403, { error: "mfa", code: "mfa_required" }),
      jsonResponse(401, { error: "bad password", code: "unauthorized" }),
    );
    const api = new ApiClient({ fetch: fn, onAuthError });
    api.setCsrfToken("t");

    const e1 = await api.getTask("t1").catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ApiRequestError);
    expect((e1 as ApiRequestError).handled).toBe(true);
    expect(onAuthError).toHaveBeenLastCalledWith("unauthorized");
    expect(api.csrfToken).toBeNull();

    await expect(api.health()).rejects.toMatchObject({ code: "mfa_required", status: 403 });
    expect(onAuthError).toHaveBeenLastCalledWith("mfa_required");

    const e3 = await api.login({ email: "a@b-gr.example", password: "wrong" }).catch((e: unknown) => e);
    expect((e3 as ApiRequestError).code).toBe("unauthorized");
    expect((e3 as ApiRequestError).handled).toBe(false);
    expect(onAuthError).toHaveBeenCalledTimes(2);
  });

  it("turns 409 into a conflict error with a friendly message", async () => {
    const { fn } = fakeFetch(jsonResponse(409, { error: "version mismatch", code: "conflict" }));
    const api = new ApiClient({ fetch: fn });
    const err = await api.taskAction("t1", { action: "complete", version: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", status: 409 });
    expect(errorMessage(err)).toBe("Something changed in the meantime. Refresh and try again.");
  });

  it("infers a code from the status when the body is not the error contract", async () => {
    const { fn } = fakeFetch(
      new Response("<html>Bad gateway</html>", { status: 502 }),
      jsonResponse(429, {}),
      () => {
        throw new TypeError("Failed to fetch");
      },
    );
    const api = new ApiClient({ fetch: fn });
    await expect(api.health()).rejects.toMatchObject({ code: "http", status: 502 });
    await expect(api.companies()).rejects.toMatchObject({ code: "rate_limited" });
    const err = await api.me().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "network", status: 0 });
    expect(errorMessage(err)).toBe("No connection to the server.");
    expect(errorMessage(new Error("x"))).toBe("Something went wrong. Try again.");
  });
});

describe("api client: endpoints", () => {
  it("“Check now” is a CSRF-protected POST to /api/sync-now; a 429 keeps its rate_limited code", async () => {
    const { fn, calls } = fakeFetch(jsonResponse(200, { ...ME, csrfToken: "c-1" }), jsonResponse(202, { started: true }), jsonResponse(429, { error: "Too many", code: "rate_limited" }));
    const api = new ApiClient({ fetch: fn, baseUrl: "http://h" });
    await api.me();
    expect(await api.syncNow()).toEqual({ started: true });
    expect(`${calls[1]!.init.method} ${calls[1]!.url}`).toBe("POST http://h/api/sync-now");
    expect(header(calls[1], "x-csrf-token")).toBe("c-1");
    await expect(api.syncNow()).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("builds the task list query without empty values", () => {
    expect(taskListQueryString({ tab: "todo" })).toBe("tab=todo");
    expect(taskListQueryString({ tab: "all", company: "ABC Α.Ε.", q: "  προσφορά ", review: true, limit: 50, cursor: "c2" })).toBe(
      "tab=all&company=ABC+%CE%91.%CE%95.&q=%CF%80%CF%81%CE%BF%CF%83%CF%86%CE%BF%CF%81%CE%AC&review=1&limit=50&cursor=c2",
    );
    expect(taskListQueryString({ tab: "waiting", q: "   ", company: null })).toBe("tab=waiting");
  });

  it("names the mailbox of the per-mailbox view on the reads that follow it, and nothing when all are shown", async () => {
    const BOX = "22222222-2222-4222-8222-222222222222";
    expect(taskListQueryString({ tab: "all", mailbox: BOX, limit: 50 })).toBe(`tab=all&limit=50&mailbox=${BOX}`);
    expect(taskListQueryString({ tab: "all", mailbox: null })).toBe("tab=all");
    expect(taskListQueryString({ tab: "all", mailbox: "" })).toBe("tab=all");
    expect(mailboxViewQuery(BOX)).toBe(`?mailbox=${BOX}`);
    expect(mailboxViewQuery("a b&c=d")).toBe("?mailbox=a%20b%26c%3Dd");
    for (const none of [null, undefined, ""]) expect(mailboxViewQuery(none)).toBe("");

    const { fn, calls } = fakeFetch(...Array.from({ length: 7 }, () => jsonResponse(200, {})));
    const api = new ApiClient({ fetch: fn, baseUrl: "http://h" });
    await api.today();
    await api.today(null);
    await api.today(BOX);
    await api.companies();
    await api.companies(BOX);
    await api.listTasks({ tab: "review", mailbox: BOX });
    await api.createTask({ title: "x", status: "ACTION_REQUIRED", mailboxId: BOX });
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET http://h/api/today",
      "GET http://h/api/today",
      `GET http://h/api/today?mailbox=${BOX}`,
      "GET http://h/api/companies",
      `GET http://h/api/companies?mailbox=${BOX}`,
      `GET http://h/api/tasks?tab=review&mailbox=${BOX}`,
      "POST http://h/api/tasks",
    ]);
    expect(JSON.parse(String(calls[6]!.init.body))).toEqual({ title: "x", status: "ACTION_REQUIRED", mailboxId: BOX });
  });

  it("hits the contract paths with the right methods", async () => {
    const replies = Array.from({ length: 12 }, () => jsonResponse(200, {}));
    const { fn, calls } = fakeFetch(...replies);
    const api = new ApiClient({ fetch: fn, baseUrl: "http://h" });
    await api.taskAction("t/1", { action: "snooze", mode: "until_date", until: "2026-09-30", version: 2 });
    await api.mergeTasks({ survivorId: "a", mergedId: "b" });
    await api.bulkAction({ ids: ["a", "b"], action: { action: "dismiss", kind: "not_a_task" } });
    await api.resolveSuggestion("ev1", "accept");
    await api.createTask({ title: "x", status: "ACTION_REQUIRED" });
    await api.createMailbox({ address: "k@contoso.example" });
    await api.updateMailbox("m1", { status: "paused" });
    await api.setMailboxPassword("m1", "secret");
    await api.listFolders("m1");
    await api.updateFolder("m1", "f1", { syncEnabled: false });
    await api.startTotpEnroll();
    await api.listMailboxes();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "POST http://h/api/tasks/t%2F1/actions",
      "POST http://h/api/tasks/merge",
      "POST http://h/api/tasks/bulk",
      "POST http://h/api/suggestions/ev1",
      "POST http://h/api/tasks",
      "POST http://h/api/mailboxes",
      "PATCH http://h/api/mailboxes/m1",
      "POST http://h/api/mailboxes/m1/credentials",
      "GET http://h/api/mailboxes/m1/folders",
      "PATCH http://h/api/mailboxes/m1/folders/f1",
      "POST http://h/api/auth/totp/enroll",
      "GET http://h/api/mailboxes",
    ]);
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ decision: "accept" });
    expect(JSON.parse(String(calls[7]!.init.body))).toEqual({ password: "secret" });
    expect(calls[8]!.init.body).toBeUndefined();
  });

  it("Admin → AI: the contract paths, with the key only ever in a JSON body", async () => {
    const key = "fake-key-0123456789abcdefghij";
    const replies = Array.from({ length: 5 }, () => jsonResponse(200, {}));
    const { fn, calls } = fakeFetch(...replies);
    const api = new ApiClient({ fetch: fn, baseUrl: "http://h" });
    api.setCsrfToken("c-ai");
    await api.adminAi();
    await api.adminAiModels({ provider: "openai", apiKey: key });
    await api.adminAiSave({ provider: "openai", model: "gpt-x", apiKey: key });
    await api.adminAiSave({ provider: "mock", model: null });
    await api.adminAiDeleteKey("xai");
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      "GET http://h/api/admin/ai",
      "POST http://h/api/admin/ai/models",
      "PUT http://h/api/admin/ai",
      "PUT http://h/api/admin/ai",
      "DELETE http://h/api/admin/ai/keys/xai",
    ]);
    expect(calls[0]!.init.body).toBeUndefined();
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ provider: "openai", apiKey: key });
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ provider: "openai", model: "gpt-x", apiKey: key });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ provider: "mock", model: null });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({});
    for (const c of calls) expect(c.url).not.toContain(key);
    for (const c of calls.slice(1)) expect(header(c, "x-csrf-token")).toBe("c-ai");
  });
});

describe("api client: chat (“Ask your mail”)", () => {
  const MAIL_SOURCE = {
    kind: "mail",
    handle: "M3fa9c1",
    messageId: "3fa9c1d2-0000-4000-8000-000000000001",
    date: "2026-11-18T08:42:00.000Z",
    fromName: "George Papadopoulos",
    fromAddress: "g@abc-hotels.example",
    own: false,
    unverified: false,
    subject: "Quote for 4 ceiling speakers",
    excerpt: "Good morning",
    attachments: ["Quote.pdf"],
    task: { id: "t-184", ref: 184 },
  };
  const TASK_SOURCE = { kind: "task", handle: "#184", taskId: "t-184", ref: 184, title: "Quote for 4 ceiling speakers", status: "ACTION_REQUIRED" };
  const REQUEST = { question: "What does ABC want?", history: [] };

  /** A response whose body arrives in the given pieces, one per read; then it ends, or breaks. */
  function streamed(chunks: Uint8Array[], failAfter = false): Response {
    const left = [...chunks];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = left.shift();
        if (next) controller.enqueue(next);
        else if (failAfter) controller.error(new Error("connection reset"));
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }

  it("reads the stream line by line, wherever the network cut it", async () => {
    const lines = [
      JSON.stringify({ type: "step", label: "Searching your mail: “quote”" }),
      "",
      "<html>a proxy's own words</html>",
      JSON.stringify({ type: "step", label: "Reading the conversation “Quote”" }),
      // No newline after the last line: it still counts.
      JSON.stringify({ type: "answer", answer: "They want a quote [M3fa9c1].", draft: null, sources: [MAIL_SOURCE, TASK_SOURCE] }),
    ].join("\n");
    const bytes = new TextEncoder().encode(lines);
    // The first cut falls inside the first character of more than one byte (the opening quotation mark of the first
    // label), the last one in the middle of a line.
    const cut = bytes.findIndex((b) => b >= 0x80) + 1;
    expect(cut).toBeGreaterThan(1);
    expect(bytes[cut]! & 0xc0).toBe(0x80);
    const chunks = [bytes.slice(0, cut), bytes.slice(cut, cut + 1), bytes.slice(cut + 1, 200), bytes.slice(200)];
    expect(bytes.length).toBeGreaterThan(260);
    const mutated = vi.fn();
    const { fn, calls } = fakeFetch(jsonResponse(200, { ...ME, csrfToken: "c-1" }), streamed(chunks));
    const api = new ApiClient({ fetch: fn, baseUrl: "http://h", onMutated: mutated });
    await api.me();
    const events: ChatEvent[] = [];
    const abort = new AbortController();
    await api.chat(REQUEST, (e) => events.push(e), abort.signal);

    expect(events).toEqual([
      { type: "step", label: "Searching your mail: “quote”" },
      { type: "step", label: "Reading the conversation “Quote”" },
      { type: "answer", answer: "They want a quote [M3fa9c1].", draft: null, sources: [MAIL_SOURCE, TASK_SOURCE] },
    ]);
    expect(`${calls[1]!.init.method} ${calls[1]!.url}`).toBe("POST http://h/api/chat");
    expect(header(calls[1], "x-csrf-token")).toBe("c-1");
    expect(header(calls[1], "accept")).toBe("application/x-ndjson");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual(REQUEST);
    expect(calls[1]!.init.signal).toBe(abort.signal);
    expect(calls[1]!.init.credentials).toBe("same-origin");
    // A question changes nothing on the server: the lists are not reloaded because of it.
    expect(mutated).not.toHaveBeenCalled();
  });

  it("reads a response that has no stream to read", async () => {
    const whole = `${JSON.stringify({ type: "step", label: "Searching" })}\n${JSON.stringify({ type: "error", code: "no_answer", message: "No answer came out." })}\n`;
    const bodyless = { ok: true, status: 200, body: null, text: async () => whole } as unknown as Response;
    const { fn } = fakeFetch(bodyless);
    const events: ChatEvent[] = [];
    await new ApiClient({ fetch: fn }).chat(REQUEST, (e) => events.push(e));
    expect(events).toEqual([
      { type: "step", label: "Searching" },
      { type: "error", code: "no_answer", message: "No answer came out." },
    ]);
  });

  it("reports a refusal as the error it is, with the server's own sentence", async () => {
    const onAuthError = vi.fn();
    const { fn } = fakeFetch(
      jsonResponse(429, { error: "Wait for your previous question to finish.", code: "rate_limited" }),
      jsonResponse(404, { error: "Not found", code: "not_found" }),
      jsonResponse(401, { error: "Sign in first", code: "unauthorized" }),
    );
    const api = new ApiClient({ fetch: fn, onAuthError });
    api.setCsrfToken("c-1");
    const events: ChatEvent[] = [];
    const ask = () => api.chat(REQUEST, (e) => events.push(e));
    await expect(ask()).rejects.toMatchObject({ status: 429, code: "rate_limited", serverMessage: "Wait for your previous question to finish." });
    await expect(ask()).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(onAuthError).not.toHaveBeenCalled();
    // A session that ended is the whole app's business, as on every other call.
    await expect(ask()).rejects.toMatchObject({ status: 401, code: "unauthorized", handled: true });
    expect(onAuthError).toHaveBeenCalledWith("unauthorized");
    expect(api.csrfToken).toBeNull();
    expect(events).toEqual([]);
  });

  it("reports a connection that never opened or broke on the way as a network error", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(new ApiClient({ fetch: down }).chat(REQUEST, () => undefined)).rejects.toMatchObject({ status: 0, code: "network" });

    const first = new TextEncoder().encode(`${JSON.stringify({ type: "step", label: "Searching" })}\n{"type":"ans`);
    const { fn } = fakeFetch(streamed([first], true));
    const events: ChatEvent[] = [];
    await expect(new ApiClient({ fetch: fn }).chat(REQUEST, (e) => events.push(e))).rejects.toMatchObject({ status: 0, code: "network" });
    // What had arrived whole was delivered; the cut line was not.
    expect(events).toEqual([{ type: "step", label: "Searching" }]);
  });

  it("takes only well-formed events from a line", () => {
    expect(parseChatEvent('  {"type":"step","label":"Searching"}  ')).toEqual({ type: "step", label: "Searching" });
    expect(parseChatEvent(JSON.stringify({ type: "error", code: "too_slow", message: "Too slow" }))).toEqual({ type: "error", code: "too_slow", message: "Too slow" });
    for (const bad of ["", "   ", "ok", "[1,2]", '{"type":"step"}', '{"type":"step","label":7}', '{"type":"error","code":"x"}', '{"type":"answer","answer":"x"}', '{"type":"answer","sources":[]}', '{"type":"nope"}', '{"type":"step","label":"cut']) {
      expect(parseChatEvent(bad), bad).toBeNull();
    }
  });

  it("drops a source it cannot show and an empty draft, and keeps the rest of the answer", () => {
    const broken = [
      { ...MAIL_SOURCE, handle: "Mbroken1", date: null },
      { ...MAIL_SOURCE, handle: "Mbroken2", attachments: [1] },
      { ...MAIL_SOURCE, handle: "Mbroken3", task: { id: "t" } },
      { ...TASK_SOURCE, handle: "#9", ref: "9" },
      { kind: "note", handle: "N1" },
      null,
      "M3fa9c1",
    ];
    const line = JSON.stringify({ type: "answer", answer: "Yes.", draft: "  \n", sources: [MAIL_SOURCE, ...broken, { ...MAIL_SOURCE, handle: "Mnotask1", task: null, fromName: null, fromAddress: null }, TASK_SOURCE] });
    expect(parseChatEvent(line)).toEqual({
      type: "answer",
      answer: "Yes.",
      draft: null,
      sources: [MAIL_SOURCE, { ...MAIL_SOURCE, handle: "Mnotask1", task: null, fromName: null, fromAddress: null }, TASK_SOURCE],
    });
    expect(parseChatEvent(JSON.stringify({ type: "answer", answer: "Yes.", draft: "Good morning,", sources: [] }))).toEqual({ type: "answer", answer: "Yes.", draft: "Good morning,", sources: [] });
  });

  it("a sender is unconfirmed only when the server says so in so many words", () => {
    const parsed = (source: unknown) => {
      const e = parseChatEvent(JSON.stringify({ type: "answer", answer: "Yes.", draft: "", sources: [source] }));
      return e?.type === "answer" ? e.sources[0] : null;
    };
    expect(parsed({ ...MAIL_SOURCE, own: true, unverified: true })).toMatchObject({ own: true, unverified: true });
    // A server from before the field existed, or anything that is not `true`.
    const { unverified: _dropped, ...older } = MAIL_SOURCE;
    expect(parsed(older)).toMatchObject({ handle: "M3fa9c1", unverified: false });
    expect(parsed({ ...MAIL_SOURCE, unverified: "true" })).toMatchObject({ unverified: false });
  });
});
