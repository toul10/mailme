import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_TOKENS } from "../../src/ai/claude.js";
import { GEMINI_API_BASE } from "../../src/ai/gemini.js";
import { geminiCostUsd, ZERO_USAGE } from "../../src/ai/pricing.js";
import { chatFailureOf, createGeminiChatModel, MAX_CHAT_WAIT_MS, type GeminiChatConfig } from "../../src/chat/gemini.js";
import { ChatConfigError, createChatModel, type ChatModelCall } from "../../src/chat/model.js";
import { chatStepSchema } from "../../src/chat/prompt.js";
import { testConfig } from "../server/helpers.js";

const KEY = "fake-gemini-key-0123456789abcdefghijklmnop";
const STEP = '{"lookups":[],"answer":"Εντάξει.","draft":"","sources":[]}';

type Step = Response | Error | ((init: RequestInit) => Promise<Response>);
function fakeFetch(queue: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("fake queue empty");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(init ?? {}) : next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const cfg = (over: Partial<GeminiChatConfig> = {}): GeminiChatConfig => ({ apiKey: KEY, model: "gemini-3.8-flash", maxTokens: 8192, timeoutMs: 60_000, maxRetries: 1, ...over });
const call = (over: Partial<ChatModelCall> = {}): ChatModelCall => ({ system: "SYSTEM TEXT", user: "<question>Τι εκκρεμεί;</question>", schema: chatStepSchema(), ...over });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const USAGE = { promptTokenCount: 6_000, cachedContentTokenCount: 1_000, candidatesTokenCount: 700, thoughtsTokenCount: 1_300 };

function ok(over: { text?: string; parts?: unknown[]; finish?: string | null; usage?: Record<string, number> | null; modelVersion?: string | null } = {}) {
  return json({
    candidates: [{ content: { role: "model", parts: over.parts ?? [{ text: over.text ?? STEP }] }, ...(over.finish === null ? {} : { finishReason: over.finish ?? "STOP" }) }],
    ...(over.usage === null ? {} : { usageMetadata: over.usage ?? USAGE }),
    ...(over.modelVersion === null ? {} : { modelVersion: over.modelVersion ?? "gemini-3.8-flash-001" }),
  });
}
const gErr = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => json({ error }, status, headers);
/** A request that hangs until its signal fires, like fetch does. */
const hang = (init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const fail = () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) fail();
    else init.signal?.addEventListener("abort", fail, { once: true });
  });

describe("the request", () => {
  it("is the extractor's: generateContent, the key only in x-goog-api-key, one instruction, one user content, JSON against the schema", async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const model = createGeminiChatModel(cfg({ fetch }));
    const res = await model.complete(call());
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${GEMINI_API_BASE}/models/gemini-3.8-flash:generateContent`);
    expect(url).not.toContain(KEY);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": KEY });
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toEqual({
      systemInstruction: { parts: [{ text: "SYSTEM TEXT" }] },
      contents: [{ role: "user", parts: [{ text: "<question>Τι εκκρεμεί;</question>" }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: chatStepSchema(), maxOutputTokens: 8192 },
    });
    expect([model.name, model.id]).toEqual(["gemini", "gemini:gemini-3.8-flash"]);
  });

  it("sends a thinking level only when one is set, and names it in the model id", async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const model = createGeminiChatModel(cfg({ fetch, thinkingLevel: "low" }));
    await model.complete(call());
    expect(JSON.parse(String(calls[0]!.init.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
    expect(model.id).toBe("gemini:gemini-3.8-flash@low");
  });
});

describe("results", () => {
  it("returns the text, the model that answered, and the cost at that model's rates (thinking billed as output)", async () => {
    const res = await createGeminiChatModel(cfg({ fetch: fakeFetch([ok({ parts: [{ text: "thinking…", thought: true }, { text: STEP }] })]).fetch })).complete(call());
    if (!res.ok) throw new Error(res.error);
    expect(res.text).toBe(STEP);
    expect(res.model).toBe("gemini-3.8-flash-001");
    expect(res.usage).toEqual({ inputTokens: 5_000, outputTokens: 2_000, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 0 });
    // 5000·1.5 + 2000·7.5 + 1000·0.15 = 22650 µ$
    expect(res.costUsd).toBeCloseTo(0.02265, 10);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    const bare = await createGeminiChatModel(cfg({ fetch: fakeFetch([ok({ usage: null, modelVersion: null, finish: null })]).fetch })).complete(call());
    expect(bare).toMatchObject({ ok: true, model: "gemini-3.8-flash", costUsd: 0 });
    // A model the price table does not know is counted at the ceiling, so the daily limit never undercounts.
    const dear = await createGeminiChatModel(cfg({ model: "gemini-9-unknown", fetch: fakeFetch([ok()]).fetch })).complete(call());
    expect(dear.costUsd).toBeCloseTo((5_000 * 10 + 2_000 * 50 + 1_000 * 10) / 1e6, 10);
  });

  it("asks once more with twice the room when the answer did not fit, and counts both requests", async () => {
    const { fetch, calls } = fakeFetch([ok({ finish: "MAX_TOKENS", text: '{"lookups":[' }), ok()]);
    const res = await createGeminiChatModel(cfg({ fetch })).complete(call());
    expect(res.ok).toBe(true);
    expect(calls.map((c) => JSON.parse(String(c.init.body)).generationConfig.maxOutputTokens)).toEqual([8192, 16_384]);
    expect(res.usage).toEqual({ inputTokens: 10_000, outputTokens: 4_000, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 0 });
    expect(res.costUsd).toBeCloseTo(0.0453, 10);

    const twice = fakeFetch([ok({ finish: "MAX_TOKENS" }), ok({ finish: "MAX_TOKENS" })]);
    const failed = await createGeminiChatModel(cfg({ fetch: twice.fetch })).complete(call());
    expect(failed).toMatchObject({ ok: false, kind: "bad_output", error: "max_tokens", model: "gemini-3.8-flash-001" });
    expect(failed.costUsd).toBeCloseTo(0.0453, 10);
    expect(twice.calls).toHaveLength(2);

    const atMax = fakeFetch([ok({ finish: "MAX_TOKENS" })]);
    expect(await createGeminiChatModel(cfg({ fetch: atMax.fetch, maxTokens: MAX_OUTPUT_TOKENS })).complete(call())).toMatchObject({ ok: false, error: "max_tokens" });
    expect(atMax.calls).toHaveLength(1);
  });

  it("tells a filtered answer from an unusable one", async () => {
    const one = async (body: Response) => createGeminiChatModel(cfg({ fetch: fakeFetch([body]).fetch })).complete(call());
    expect(await one(json({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: USAGE }))).toMatchObject({ ok: false, kind: "blocked", error: "blocked:SAFETY", costUsd: 0.02265 });
    expect(await one(json({ promptFeedback: { blockReason: "free text, not a tag" } }))).toMatchObject({ ok: false, kind: "blocked", error: "blocked:OTHER", usage: null, costUsd: 0 });
    expect(await one(ok({ finish: "SAFETY" }))).toMatchObject({ ok: false, kind: "blocked", error: "finish:SAFETY" });
    expect(await one(ok({ finish: "PROHIBITED_CONTENT" }))).toMatchObject({ ok: false, kind: "blocked" });
    expect(await one(ok({ finish: "RECITATION" }))).toMatchObject({ ok: false, kind: "bad_output", error: "finish:RECITATION" });
    expect(await one(json({ candidates: [], usageMetadata: USAGE }))).toMatchObject({ ok: false, kind: "bad_output", error: "no_candidate" });
    expect(await one(ok({ text: "   " }))).toMatchObject({ ok: false, kind: "bad_output", error: "no_text" });
    expect(await one(ok({ parts: [{ text: "only thoughts", thought: true }] }))).toMatchObject({ ok: false, kind: "bad_output", error: "no_text" });
  });
});

describe("failures", () => {
  it("an empty prepaid balance is its own kind, and is not retried", async () => {
    const { fetch, calls } = fakeFetch([gErr(402, { code: 402, status: "RESOURCE_EXHAUSTED", message: "Your prepayment credits are depleted." })]);
    expect(await createGeminiChatModel(cfg({ fetch })).complete(call())).toEqual({ ok: false, kind: "no_credit", error: "http_402:RESOURCE_EXHAUSTED", model: null, usage: null, costUsd: 0, latencyMs: expect.any(Number) });
    expect(calls).toHaveLength(1);
  });

  it("a short hiccup is retried once; a wait longer than a person sits through is not waited out", async () => {
    const quick = fakeFetch([gErr(429, { code: 429, status: "RESOURCE_EXHAUSTED" }, { "retry-after-ms": "1" }), ok()]);
    expect((await createGeminiChatModel(cfg({ fetch: quick.fetch })).complete(call())).ok).toBe(true);
    expect(quick.calls).toHaveLength(2);

    const twice = fakeFetch([gErr(503, { code: 503, status: "UNAVAILABLE" }, { "retry-after-ms": "1" }), gErr(503, { code: 503, status: "UNAVAILABLE" }, { "retry-after-ms": "1" }), ok()]);
    expect(await createGeminiChatModel(cfg({ fetch: twice.fetch })).complete(call())).toMatchObject({ ok: false, kind: "unavailable", error: "http_503:UNAVAILABLE" });
    expect(twice.calls).toHaveLength(2);

    const started = performance.now();
    const slow = fakeFetch([gErr(429, { code: 429, status: "RESOURCE_EXHAUSTED" }, { "retry-after": String(MAX_CHAT_WAIT_MS / 1000 + 1) }), ok()]);
    expect(await createGeminiChatModel(cfg({ fetch: slow.fetch })).complete(call())).toMatchObject({ ok: false, kind: "unavailable", error: "http_429:RESOURCE_EXHAUSTED" });
    expect(slow.calls).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("a refused key, an unknown model or a refused request is a setting to fix; the provider's message never leaves", async () => {
    const one = async (res: Response) => {
      const f = fakeFetch([res]);
      const out = await createGeminiChatModel(cfg({ fetch: f.fetch })).complete(call());
      expect(f.calls).toHaveLength(1);
      return out;
    };
    const bad = await one(gErr(400, { code: 400, status: "INVALID_ARGUMENT", message: `API key not valid (${KEY})`, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] }));
    expect(bad).toMatchObject({ ok: false, kind: "config", error: "http_400:API_KEY_INVALID" });
    expect(JSON.stringify(bad)).not.toContain(KEY);
    expect(await one(gErr(404, { code: 404, status: "NOT_FOUND", message: "models/x is not found" }))).toMatchObject({ kind: "config", error: "http_404:NOT_FOUND" });
    expect(await one(gErr(400, { code: 400, status: "INVALID_ARGUMENT", message: "Invalid JSON schema: secret words of a mail" }))).toMatchObject({ kind: "config", error: "http_400:INVALID_ARGUMENT" });
    expect(await one(gErr(400, { code: 400, status: "INVALID_ARGUMENT", message: "The input token count (1300000) exceeds the maximum number of tokens allowed" }))).toMatchObject({ kind: "too_long" });
    expect(await one(gErr(413, { code: 413 }))).toMatchObject({ kind: "too_long", error: "http_413:unknown" });
  });

  it("a request that takes too long is cut by its own timeout", async () => {
    const { fetch, calls } = fakeFetch([hang, hang]);
    const res = await createGeminiChatModel(cfg({ fetch, timeoutMs: 15, maxRetries: 0 })).complete(call());
    expect(res).toMatchObject({ ok: false, kind: "unavailable", error: "timeout" });
    expect(calls).toHaveLength(1);
    expect(await createGeminiChatModel(cfg({ fetch: fakeFetch([Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })]).fetch, maxRetries: 0 })).complete(call())).toMatchObject({ kind: "unavailable", error: "connection" });
  });

  it("a reader who went away ends the call at once, and nothing is retried", async () => {
    const gone = new AbortController();
    gone.abort();
    const never = fakeFetch([ok()]);
    expect(await createGeminiChatModel(cfg({ fetch: never.fetch })).complete(call({ signal: gone.signal }))).toMatchObject({ ok: false, kind: "aborted", error: "aborted", costUsd: 0 });
    expect(never.calls).toHaveLength(0);

    const mid = new AbortController();
    const during = fakeFetch([hang, ok()]);
    const pending = createGeminiChatModel(cfg({ fetch: during.fetch })).complete(call({ signal: mid.signal }));
    setTimeout(() => mid.abort(), 10);
    expect(await pending).toMatchObject({ ok: false, kind: "aborted", error: "aborted" });
    expect(during.calls).toHaveLength(1);

    // Gone while a retry was waiting: the second request is never sent.
    const waiting = new AbortController();
    const retry = fakeFetch([() => (setTimeout(() => waiting.abort(), 1), Promise.resolve(gErr(503, { code: 503, status: "UNAVAILABLE" }, { "retry-after-ms": "30" }))), ok()]);
    expect(await createGeminiChatModel(cfg({ fetch: retry.fetch })).complete(call({ signal: waiting.signal }))).toMatchObject({ ok: false, kind: "aborted" });
    expect(retry.calls).toHaveLength(1);
  });

  it("counts a request that left and was never answered at its input's price, so that stopping is not a way around the day's limit", async () => {
    const big = call({ system: "S".repeat(4_000), user: "U".repeat(36_000) });
    // Two characters a token, on purpose more than it can be: 40 000 characters → 20 000 input tokens.
    const one = geminiCostUsd("gemini-3.8-flash", { ...ZERO_USAGE, inputTokens: 20_000 });
    expect(one).toBeGreaterThan(0);

    // Stopped by the reader while the model was at work.
    const mid = new AbortController();
    const pending = createGeminiChatModel(cfg({ fetch: fakeFetch([hang]).fetch })).complete({ ...big, signal: mid.signal });
    setTimeout(() => mid.abort(), 10);
    expect(await pending).toMatchObject({ ok: false, kind: "aborted", usage: null, costUsd: one });

    // Cut by its own timeout, twice (the retry too).
    const twice = await createGeminiChatModel(cfg({ fetch: fakeFetch([hang, hang]).fetch, timeoutMs: 15, maxRetries: 1 })).complete(big);
    expect(twice).toMatchObject({ ok: false, kind: "unavailable", error: "timeout" });
    expect(twice.costUsd).toBeCloseTo(2 * one, 8);

    // A timeout and then an answer: the answer's own bill plus the lost request.
    const answered = await createGeminiChatModel(cfg({ fetch: fakeFetch([hang, ok()]).fetch, timeoutMs: 15, maxRetries: 1 })).complete(big);
    const billed = await createGeminiChatModel(cfg({ fetch: fakeFetch([ok()]).fetch })).complete(big);
    expect(answered.ok && billed.ok).toBe(true);
    expect(answered.costUsd).toBeCloseTo(billed.costUsd + one, 8);

    // What the provider answered with an error status was refused, not run: nothing is added for it.
    expect(await createGeminiChatModel(cfg({ fetch: fakeFetch([gErr(503, { code: 503, status: "UNAVAILABLE" }, { "retry-after-ms": "1" }), gErr(503, { code: 503, status: "UNAVAILABLE" }, { "retry-after-ms": "1" })]).fetch })).complete(big)).toMatchObject({
      ok: false,
      costUsd: 0,
    });
  });

  it("maps an adapter error to what the chat tells the user", () => {
    const e = (errorClass: "TRANSIENT" | "GLOBAL" | "PER_MESSAGE", error: string) => chatFailureOf({ errorClass, error, retryAfterSec: null });
    expect(e("PER_MESSAGE", "aborted")).toBe("aborted");
    expect(e("TRANSIENT", "http_402:RESOURCE_EXHAUSTED")).toBe("no_credit");
    expect(e("TRANSIENT", "http_429:RESOURCE_EXHAUSTED")).toBe("unavailable");
    expect(e("TRANSIENT", "timeout")).toBe("unavailable");
    expect(e("PER_MESSAGE", "http_400:INVALID_ARGUMENT:prompt_too_long")).toBe("too_long");
    expect(e("PER_MESSAGE", "http_413:unknown")).toBe("too_long");
    expect(e("GLOBAL", "http_403:PERMISSION_DENIED")).toBe("config");
    expect(e("GLOBAL", "unexpected:TypeError")).toBe("config");
  });
});

describe("the chat model of a process (CHAT_MODE)", () => {
  const withKey = { CHAT_API_KEY: KEY };
  it("is off unless switched on, and a real model needs its key and its model id", () => {
    expect(createChatModel(testConfig(), {})).toBeNull();
    expect(createChatModel(testConfig({ CHAT_MODE: "off", CHAT_MODEL: "gemini-3.8-flash" }), withKey)).toBeNull();
    expect(createChatModel(testConfig({ CHAT_MODE: "mock" }), {})).toMatchObject({ name: "mock", id: "mock" });
    expect(() => createChatModel(testConfig({ CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash" }), {})).toThrow(ChatConfigError);
    expect(() => createChatModel(testConfig({ CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash" }), { CHAT_API_KEY: "  " })).toThrow(/CHAT_API_KEY/);
    expect(() => createChatModel(testConfig({ CHAT_MODE: "gemini" }), withKey)).toThrow(/CHAT_MODEL/);
    expect(createChatModel(testConfig({ CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash", CHAT_THINKING_LEVEL: "low" }), withKey)).toMatchObject({ name: "gemini", id: "gemini:gemini-3.8-flash@low" });
    expect(() => testConfig({ CHAT_MODE: "claude" })).toThrow();
    expect(() => testConfig({ CHAT_MODEL: "not a model id" })).toThrow();
    expect(testConfig()).toMatchObject({ CHAT_MODE: "off", CHAT_MAX_TOKENS: 8192, CHAT_DAILY_QUESTION_CAP: 100, CHAT_DAILY_USD_CAP: 3 });
  });

  it("takes its key from CHAT_API_KEY alone: the worker's keys are not the chat's, and the key is not part of the config", () => {
    // The worker's own Gemini key in the same environment does not switch the chat on.
    expect(() => createChatModel(testConfig({ CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash" }), { GEMINI_API_KEY: KEY })).toThrow(/CHAT_API_KEY/);
    // The message names the variable and never a value.
    try {
      createChatModel(testConfig({ CHAT_MODE: "gemini" }), withKey);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
    // A key handed to the config loader is dropped there: nothing that prints the config can print it.
    expect(JSON.stringify(testConfig({ CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash", CHAT_API_KEY: KEY }))).not.toContain(KEY);
  });
});
