import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_TOKENS, STREAM_DEADLINE_ERROR } from "../../src/ai/claude.js";
import { candidateText, classifyGeminiThrown, createGeminiExtractor, GEMINI_API_BASE, geminiModelPath, geminiUsage } from "../../src/ai/gemini.js";
import { portableExtractionSchema } from "../../src/ai/portable-schema.js";
import { ceilingCostUsd } from "../../src/ai/pricing.js";
import { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "../../src/ai/prompt.js";
import type { GeminiExtractorConfig } from "../../src/ai/providers.js";
import { SCHEMA_VERSION } from "../../src/ai/schema.js";
import type { ExtractorErrorClass } from "../../src/domain/types.js";
import { makeInput, VALID_OUTPUT } from "./helpers.js";

const KEY = "fake-gemini-key-0123456789abcdefghijklmnop";
const input = makeInput();

type Step = Response | Error | (() => Promise<Response>);
function fakeFetch(queue: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("fake queue empty");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function cfg(over: Partial<GeminiExtractorConfig> = {}): GeminiExtractorConfig {
  return { apiKey: KEY, model: "gemini-test", maxTokens: 16_000, timeoutMs: 300_000, maxRetries: 0, componentVersions: { cleaner: "c1", resolver: "r2" }, ...over };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function ok(over: { text?: string; parts?: unknown[]; finish?: string | null; usage?: Record<string, number> | null; modelVersion?: string } = {}) {
  return json({
    candidates: [
      {
        content: { role: "model", parts: over.parts ?? [{ text: over.text ?? JSON.stringify(VALID_OUTPUT) }] },
        ...(over.finish === null ? {} : { finishReason: over.finish ?? "STOP" }),
      },
    ],
    ...(over.usage === null ? {} : { usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 200, totalTokenCount: 1_200, ...over.usage } }),
    modelVersion: over.modelVersion ?? "gemini-test-001",
  });
}

const gErr = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => json({ error }, status, headers);
const keyInvalid = (status: number) =>
  gErr(status, {
    code: status,
    message: `API key not valid. Please pass a valid API key. (${KEY})`,
    status: "INVALID_ARGUMENT",
    details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } },
      { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en-US", message: "API key not valid. Please pass a valid API key." },
    ],
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createGeminiExtractor — request", () => {
  it("POSTs generateContent with the key only in x-goog-api-key, and a JSON-schema generationConfig", async () => {
    const { fetch, calls } = fakeFetch([ok()]);
    const res = await createGeminiExtractor(cfg({ fetch })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`${GEMINI_API_BASE}/models/gemini-test:generateContent`);
    expect(url).not.toContain("FAKEKEY");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": KEY });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: renderUserPrompt(input) }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: portableExtractionSchema(), maxOutputTokens: 16_000 },
    });
  });

  it("escapes the model id and accepts a listed models/ id", () => {
    expect(geminiModelPath("gemini-test")).toBe("models/gemini-test");
    expect(geminiModelPath("models/gemini-test")).toBe("models/gemini-test");
    expect(geminiModelPath("gemini x?y")).toBe("models/gemini%20x%3Fy");
  });

  it("is named gemini and versions the model into pipelineVersion", () => {
    const ex = createGeminiExtractor(cfg({ fetch: fakeFetch([]).fetch }));
    expect(ex.name).toBe("gemini");
    expect(ex.pipelineVersion).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|gemini:gemini-test|c1|r2`);
  });
});

describe("createGeminiExtractor — results", () => {
  it("parses the joined text parts (thoughts skipped), with disjoint usage and the ceiling cost", async () => {
    const text = JSON.stringify(VALID_OUTPUT);
    const parts = [{ text: "thinking about it", thought: true }, { text: text.slice(0, 20) }, { text: text.slice(20) }];
    const usage = { promptTokenCount: 1_000, cachedContentTokenCount: 200, candidatesTokenCount: 300, thoughtsTokenCount: 50 };
    const { fetch } = fakeFetch([ok({ parts, usage })]);
    const res = await createGeminiExtractor(cfg({ fetch })).extract(input);
    if (!res.ok) throw new Error(res.error);
    expect(res.output).toEqual(VALID_OUTPUT);
    expect(res.model).toBe("gemini-test-001");
    expect(res.stopReason).toBe("STOP");
    expect(res.usage).toEqual({ inputTokens: 800, outputTokens: 350, cacheReadInputTokens: 200, cacheCreationInputTokens: 0 });
    expect(res.costUsd).toBe(ceilingCostUsd(res.usage));
    expect(res.request).toMatchObject({ extractor: "gemini", model: "gemini-test", promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, maxTokens: 16_000, input });
  });

  it("reads usage defensively", () => {
    expect(geminiUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    expect(candidateText(undefined)).toBe("");
    expect(candidateText([{ text: 1 }, { thought: true, text: "x" }, { text: "y" }])).toBe("y");
  });

  it("MAX_TOKENS: doubles maxOutputTokens once and sums both calls", async () => {
    const { fetch, calls } = fakeFetch([ok({ finish: "MAX_TOKENS", text: '{"message_' }), ok()]);
    const res = await createGeminiExtractor(cfg({ fetch })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls.map((c) => JSON.parse(String(c.init.body)).generationConfig.maxOutputTokens)).toEqual([16_000, 32_000]);
    expect(res.usage?.outputTokens).toBe(400);
    expect(res).toMatchObject({ request: { maxTokens: 32_000 } });
  });

  it("MAX_TOKENS twice → PER_MESSAGE max_tokens; the bump stops at MAX_OUTPUT_TOKENS", async () => {
    const { fetch, calls } = fakeFetch([ok({ finish: "MAX_TOKENS" }), ok({ finish: "MAX_TOKENS" })]);
    const res = await createGeminiExtractor(cfg({ maxTokens: 100_000, fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "max_tokens" });
    expect(calls.map((c) => JSON.parse(String(c.init.body)).generationConfig.maxOutputTokens)).toEqual([100_000, MAX_OUTPUT_TOKENS]);
    expect(res.usage?.outputTokens).toBe(400);
  });

  it.each([
    ["a blocked prompt", json({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 900 } }), "blocked:SAFETY"],
    ["a blocked prompt, unknown reason text", json({ promptFeedback: { blockReason: "some reason" } }), "blocked:OTHER"],
    ["finish SAFETY", ok({ finish: "SAFETY" }), "finish:SAFETY"],
    ["finish RECITATION", ok({ finish: "RECITATION" }), "finish:RECITATION"],
    ["no candidate", json({ candidates: [], usageMetadata: { promptTokenCount: 900 } }), "no_candidate"],
  ])("%s → PER_MESSAGE", async (_name, response, error) => {
    const { fetch, calls } = fakeFetch([response]);
    const res = await createGeminiExtractor(cfg({ fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error, retryAfterSec: null });
    expect(calls).toHaveLength(1);
  });

  it("a candidate without finishReason is parsed", async () => {
    const { fetch } = fakeFetch([ok({ finish: null })]);
    const res = await createGeminiExtractor(cfg({ fetch })).extract(input);
    expect(res).toMatchObject({ ok: true, stopReason: "STOP" });
  });

  it("retries an off-schema answer once, then PER_MESSAGE schema_invalid", async () => {
    const once = fakeFetch([ok({ text: "nope" }), ok()]);
    expect((await createGeminiExtractor(cfg({ fetch: once.fetch })).extract(input)).ok).toBe(true);
    expect(once.calls).toHaveLength(2);

    const bad = JSON.stringify({ ...VALID_OUTPUT, operations: "x" });
    const twice = fakeFetch([ok({ text: bad }), ok({ text: bad })]);
    const res = await createGeminiExtractor(cfg({ fetch: twice.fetch })).extract(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^schema_invalid:operations:/);
    expect(twice.calls).toHaveLength(2);
  });
});

describe("createGeminiExtractor — errors", () => {
  const table: Array<[string, () => Step, ExtractorErrorClass, string, number | null]> = [
    ["400 API_KEY_INVALID (message echoes the key)", () => keyInvalid(400), "GLOBAL", "http_400:API_KEY_INVALID", null],
    ["403 API_KEY_SERVICE_BLOCKED", () => gErr(403, { code: 403, message: "blocked", status: "PERMISSION_DENIED", details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] }), "GLOBAL", "http_403:API_KEY_SERVICE_BLOCKED", null],
    ["401", () => gErr(401, { code: 401, message: "unauthenticated", status: "UNAUTHENTICATED" }), "GLOBAL", "http_401:UNAUTHENTICATED", null],
    ["402", () => gErr(402, { code: 402, message: "payment required" }), "GLOBAL", "http_402:unknown", null],
    ["403", () => gErr(403, { code: 403, message: "denied", status: "PERMISSION_DENIED" }), "GLOBAL", "http_403:PERMISSION_DENIED", null],
    ["404 unknown model", () => gErr(404, { code: 404, message: "models/x is not found", status: "NOT_FOUND" }), "GLOBAL", "http_404:NOT_FOUND", null],
    ["400 FAILED_PRECONDITION", () => gErr(400, { code: 400, message: "User location is not supported for the API use.", status: "FAILED_PRECONDITION" }), "GLOBAL", "http_400:FAILED_PRECONDITION", null],
    ["400 bad request", () => gErr(400, { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT" }), "GLOBAL", "http_400:INVALID_ARGUMENT", null],
    [
      "400 input too long",
      () => gErr(400, { code: 400, message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).", status: "INVALID_ARGUMENT" }),
      "PER_MESSAGE",
      "http_400:INVALID_ARGUMENT:prompt_too_long",
      null,
    ],
    ["413", () => gErr(413, { code: 413, message: "Request Entity Too Large" }), "PER_MESSAGE", "http_413:unknown", null],
    [
      "429 RESOURCE_EXHAUSTED with RetryInfo",
      () => gErr(429, { code: 429, message: "quota", status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] }),
      "TRANSIENT",
      "http_429:RESOURCE_EXHAUSTED",
      37,
    ],
    ["429 with Retry-After", () => gErr(429, { code: 429, message: "slow down", status: "RESOURCE_EXHAUSTED" }, { "retry-after": "12" }), "TRANSIENT", "http_429:RESOURCE_EXHAUSTED", 12],
    ["429 bare", () => gErr(429, { code: 429, message: "slow down" }), "TRANSIENT", "http_429:unknown", 60],
    ["408", () => gErr(408, { code: 408, message: "timeout" }), "TRANSIENT", "http_408:unknown", 30],
    ["500", () => gErr(500, { code: 500, message: "internal", status: "INTERNAL" }), "TRANSIENT", "http_500:INTERNAL", 30],
    ["503", () => gErr(503, { code: 503, message: "overloaded", status: "UNAVAILABLE" }), "TRANSIENT", "http_503:UNAVAILABLE", 60],
    ["504", () => gErr(504, { code: 504, message: "deadline", status: "DEADLINE_EXCEEDED" }), "TRANSIENT", "http_504:DEADLINE_EXCEEDED", 30],
    ["502 HTML body", () => new Response("<html>bad gateway</html>", { status: 502 }), "TRANSIENT", "http_502:unknown", 30],
    ["snake_case 400", () => gErr(400, { code: "invalid_request", message: `bad ${KEY}` }), "GLOBAL", "http_400:invalid_request", null],
    ["snake_case 429", () => gErr(429, { code: "rate_limit_exceeded", message: "slow" }), "TRANSIENT", "http_429:rate_limit_exceeded", 60],
    ["200 that is not JSON", () => new Response("<html>", { status: 200 }), "TRANSIENT", "invalid_response", 30],
    ["fetch failed (ECONNRESET)", () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }), "TRANSIENT", "connection", 30],
    ["fetch failed (undici)", () => new TypeError("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "TRANSIENT", "connection", 30],
    ["DNS failure", () => Object.assign(new Error(`getaddrinfo ENOTFOUND ${KEY}`), { code: "ENOTFOUND" }), "TRANSIENT", "connection", 30],
    ["an abort from elsewhere", () => new DOMException("This operation was aborted", "AbortError"), "TRANSIENT", "aborted", 5],
    ["anything else", () => new RangeError(`boom ${KEY}`), "GLOBAL", "unexpected:RangeError", null],
  ];

  it.each(table)("%s", async (_name, make, errorClass, error, retryAfterSec) => {
    const { fetch, calls } = fakeFetch([make()]);
    const res = await createGeminiExtractor(cfg({ fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass, error, retryAfterSec, usage: null, costUsd: 0 });
    expect(res.request).toMatchObject({ extractor: "gemini", model: "gemini-test", maxTokens: 16_000 });
    expect(JSON.stringify(res)).not.toContain("FAKEKEY");
    expect(calls).toHaveLength(1);
  });

  it("its own timeout → TRANSIENT timeout", async () => {
    const calls: unknown[] = [];
    const waiting = ((_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      });
    }) as typeof fetch;
    const res = await createGeminiExtractor(cfg({ timeoutMs: 20, fetch: waiting })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "timeout", retryAfterSec: 30 });
    expect(calls).toHaveLength(1);
  });

  it("a failure after ≥ 270 s is the deadline, never retried", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { fetch, calls } = fakeFetch([
      async () => {
        now = 301_000;
        throw new TypeError("fetch failed");
      },
    ]);
    const res = await createGeminiExtractor(cfg({ maxRetries: 2, fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [true, 270_000, STREAM_DEADLINE_ERROR],
    [true, 269_999, "timeout"],
    [false, 300_000, STREAM_DEADLINE_ERROR],
  ])("classifyGeminiThrown(timedOut %s, %i ms) → %s", (timedOut, elapsed, error) => {
    expect(classifyGeminiThrown(new TypeError("fetch failed"), elapsed, timedOut).error).toBe(error);
  });
});

describe("createGeminiExtractor — quick retries (maxRetries)", () => {
  it("retries a TRANSIENT failure after the server's short wait", async () => {
    const { fetch, calls } = fakeFetch([gErr(503, { code: 503, status: "UNAVAILABLE" }, { "retry-after-ms": "1" }), ok()]);
    const res = await createGeminiExtractor(cfg({ maxRetries: 2, fetch })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    const fail500 = () => gErr(500, { code: 500, status: "INTERNAL" }, { "retry-after-ms": "1" });
    const { fetch, calls } = fakeFetch([fail500(), fail500(), fail500()]);
    const res = await createGeminiExtractor(cfg({ maxRetries: 2, fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "http_500:INTERNAL" });
    expect(calls).toHaveLength(3);
  });

  it("backs off without a server wait (a connection blip)", async () => {
    const { fetch, calls } = fakeFetch([new TypeError("fetch failed"), ok()]);
    const res = await createGeminiExtractor(cfg({ maxRetries: 1, fetch })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("hands a long server wait back to the pipeline instead of sleeping", async () => {
    const { fetch, calls } = fakeFetch([gErr(429, { code: 429, status: "RESOURCE_EXHAUSTED" }, { "retry-after": "120" })]);
    const res = await createGeminiExtractor(cfg({ maxRetries: 2, fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", retryAfterSec: 120 });
    expect(calls).toHaveLength(1);
  });

  it("never retries GLOBAL or PER_MESSAGE failures", async () => {
    const { fetch, calls } = fakeFetch([keyInvalid(400)]);
    const res = await createGeminiExtractor(cfg({ maxRetries: 2, fetch })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "GLOBAL" });
    expect(calls).toHaveLength(1);
  });
});
