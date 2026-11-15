import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_TOKENS, STREAM_DEADLINE_ERROR } from "../../src/ai/claude.js";
import {
  classifyOpenAiError,
  createOpenAiClient,
  createOpenAiCompatExtractor,
  OPENAI_BASE_URL,
  openAiUsage,
  XAI_BASE_URL,
} from "../../src/ai/openai-compat.js";
import { portableExtractionSchema } from "../../src/ai/portable-schema.js";
import { ceilingCostUsd, estimateCostUsd } from "../../src/ai/pricing.js";
import { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "../../src/ai/prompt.js";
import type { OpenAiCompatExtractorConfig } from "../../src/ai/providers.js";
import { SCHEMA_VERSION } from "../../src/ai/schema.js";
import type { ExtractorErrorClass } from "../../src/domain/types.js";
import { makeInput, VALID_OUTPUT, VALID_TEXT, VALID_WIRE } from "./helpers.js";

const KEY = "fake-openai-KEY-9f8e7d6c5b4a3210";
const input = makeInput();

function cfg(over: Partial<OpenAiCompatExtractorConfig> = {}): OpenAiCompatExtractorConfig {
  return {
    provider: "openai",
    apiKey: KEY,
    model: "gpt-test",
    maxTokens: 16_000,
    timeoutMs: 300_000,
    maxRetries: 2,
    componentVersions: { cleaner: "c1", resolver: "r2" },
    ...over,
  };
}

type Usage = Record<string, unknown>;
function completion(over: { content?: string | null; finish?: string | null; refusal?: string | null; usage?: Usage | null; model?: string; noChoices?: boolean } = {}): OpenAI.ChatCompletion {
  const usage = over.usage === null ? undefined : { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200, prompt_tokens_details: { cached_tokens: 100 }, ...over.usage };
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: over.model ?? "gpt-test-2026-11-01",
    choices: over.noChoices
      ? []
      : [
          {
            index: 0,
            finish_reason: over.finish === undefined ? "stop" : over.finish,
            logprobs: null,
            message: { role: "assistant", content: over.content === undefined ? VALID_TEXT : over.content, refusal: over.refusal ?? null },
          },
        ],
    usage,
  } as unknown as OpenAI.ChatCompletion;
}

type Body = OpenAI.ChatCompletionCreateParamsNonStreaming;
function fakeClient(queue: Array<OpenAI.ChatCompletion | Error | (() => never)>) {
  const calls: Array<{ body: Body; options: unknown }> = [];
  const client = {
    chat: {
      completions: {
        create: async (body: Body, options?: unknown) => {
          calls.push({ body: structuredClone(body), options });
          const next = queue.shift();
          if (!next) throw new Error("fake queue empty");
          if (typeof next === "function") return next();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  return { client, calls };
}

function apiErr(status: number, error?: { message?: string; type?: string | null; code?: string | null }, headers: Record<string, string> = {}) {
  return OpenAI.APIError.generate(status, error ? { error } : undefined, error?.message, new Headers(headers));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createOpenAiCompatExtractor — request", () => {
  it("sends one non-streaming chat completion with strict json_schema output and nothing model-specific", async () => {
    const { client, calls } = fakeClient([completion()]);
    const res = await createOpenAiCompatExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { body, options } = calls[0]!;
    expect(body).toEqual({
      model: "gpt-test",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: renderUserPrompt(input) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema: portableExtractionSchema() } },
      max_completion_tokens: 16_000,
    });
    // SDK retries off: the adapter retries itself (never a timed-out generation).
    expect(options).toEqual({ timeout: 300_000, maxRetries: 0 });
  });

  it("names itself after the provider and versions the model into pipelineVersion", () => {
    const openai = createOpenAiCompatExtractor(cfg({ client: fakeClient([]).client }));
    const xai = createOpenAiCompatExtractor(cfg({ provider: "xai", model: "grok-test", client: fakeClient([]).client }));
    expect(openai.name).toBe("openai");
    expect(xai.name).toBe("xai");
    expect(openai.pipelineVersion).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|openai:gpt-test|c1|r2`);
    expect(xai.pipelineVersion).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|xai:grok-test|c1|r2`);
  });
});

describe("createOpenAiCompatExtractor — results", () => {
  it("parses the output, reports disjoint usage and the ceiling cost", async () => {
    const { client } = fakeClient([completion({ usage: { prompt_tokens: 1_000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 100 } } })]);
    const res = await createOpenAiCompatExtractor(cfg({ client })).extract(input);
    if (!res.ok) throw new Error(res.error);
    expect(res.output).toEqual(VALID_OUTPUT);
    expect(res.model).toBe("gpt-test-2026-11-01");
    expect(res.stopReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 900, outputTokens: 200, cacheReadInputTokens: 100, cacheCreationInputTokens: 0 });
    expect(res.costUsd).toBe(ceilingCostUsd(res.usage));
    expect(res.request).toMatchObject({ extractor: "openai", model: "gpt-test", promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, maxTokens: 16_000, input });
  });

  it("prices even a Claude-named model at the ceiling, never through pricingFor", async () => {
    const { client } = fakeClient([completion()]);
    const res = await createOpenAiCompatExtractor(cfg({ model: "claude-haiku-4-5", client })).extract(input);
    expect(res.costUsd).toBe(ceilingCostUsd(res.usage!));
    expect(res.costUsd).toBeGreaterThan(estimateCostUsd("claude-haiku-4-5", res.usage!));
  });

  it("xAI: accepts finish end_turn and uses the exact cost in usd ticks (1e10 per USD)", async () => {
    const { client } = fakeClient([completion({ finish: "end_turn", model: "grok-test", usage: { cost_in_usd_ticks: 123_456_789 } })]);
    const res = await createOpenAiCompatExtractor(cfg({ provider: "xai", model: "grok-test", client })).extract(input);
    expect(res.ok).toBe(true);
    expect(res.stopReason).toBe("end_turn");
    expect(res.costUsd).toBe(0.01234568);
  });

  it("xAI without ticks, and OpenAI even with ticks, fall back to the ceiling", async () => {
    const xai = fakeClient([completion({ finish: "end_turn" })]);
    const a = await createOpenAiCompatExtractor(cfg({ provider: "xai", client: xai.client })).extract(input);
    expect(a.costUsd).toBe(ceilingCostUsd(a.usage!));
    const openai = fakeClient([completion({ usage: { cost_in_usd_ticks: 1 } })]);
    const b = await createOpenAiCompatExtractor(cfg({ client: openai.client })).extract(input);
    expect(b.costUsd).toBe(ceilingCostUsd(b.usage!));
  });

  it("splits cache writes out of the prompt tokens", () => {
    expect(openAiUsage({ prompt_tokens: 1_000, completion_tokens: 5, total_tokens: 1_005, prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 } } as never)).toEqual({
      inputTokens: 500,
      outputTokens: 5,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 200,
    });
    expect(openAiUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });

  it("finish length: doubles max_completion_tokens once, sums both calls", async () => {
    const { client, calls } = fakeClient([completion({ finish: "length", content: '{"message_cla' }), completion()]);
    const res = await createOpenAiCompatExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.body.max_completion_tokens)).toEqual([16_000, 32_000]);
    expect(res.usage?.outputTokens).toBe(400);
    expect(res).toMatchObject({ request: { maxTokens: 32_000 } });
  });

  it("finish length twice → PER_MESSAGE max_tokens; the bump stops at MAX_OUTPUT_TOKENS", async () => {
    const twice = fakeClient([completion({ finish: "length" }), completion({ finish: "length" })]);
    const res = await createOpenAiCompatExtractor(cfg({ maxTokens: 100_000, client: twice.client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "max_tokens", retryAfterSec: null });
    expect(twice.calls.map((c) => c.body.max_completion_tokens)).toEqual([100_000, MAX_OUTPUT_TOKENS]);
    expect(res.usage?.outputTokens).toBe(400);
    expect(res.costUsd).toBeGreaterThan(0);

    const atMax = fakeClient([completion({ finish: "length" })]);
    const res2 = await createOpenAiCompatExtractor(cfg({ maxTokens: MAX_OUTPUT_TOKENS, client: atMax.client })).extract(input);
    expect(res2).toMatchObject({ ok: false, error: "max_tokens" });
    expect(atMax.calls).toHaveLength(1);
  });

  it.each([
    ["a refusal", completion({ content: null, refusal: "I can't help with that." }), "refusal"],
    ["content_filter", completion({ finish: "content_filter", content: null }), "content_filter"],
    ["another finish reason", completion({ finish: "tool_calls" }), "finish:tool_calls"],
    ["no choices", completion({ noChoices: true }), "no_choice"],
  ])("%s → PER_MESSAGE, billed", async (_name, response, error) => {
    const { client, calls } = fakeClient([response]);
    const res = await createOpenAiCompatExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error });
    expect(res.usage).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("retries an off-schema answer once", async () => {
    const { client, calls } = fakeClient([completion({ content: "not json" }), completion()]);
    const res = await createOpenAiCompatExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(res.usage?.inputTokens).toBe(1_800);
  });

  it("an off-schema answer twice → PER_MESSAGE schema_invalid", async () => {
    const bad = JSON.stringify({ ...VALID_WIRE, message_class: "NOPE" });
    const { client, calls } = fakeClient([completion({ content: bad }), completion({ content: bad })]);
    const res = await createOpenAiCompatExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorClass).toBe("PER_MESSAGE");
    expect(res.error).toMatch(/^schema_invalid:message_class:/);
    expect(calls).toHaveLength(2);
  });
});

describe("createOpenAiCompatExtractor — errors", () => {
  const billing = (code: string) => apiErr(429, { message: `quota for ${KEY}`, type: "insufficient_quota", code });
  const table: Array<[string, () => unknown, ExtractorErrorClass, string, number | null]> = [
    ["user abort", () => new OpenAI.APIUserAbortError(), "TRANSIENT", "aborted", 5],
    ["connection timeout", () => new OpenAI.APIConnectionTimeoutError(), "TRANSIENT", "timeout", 30],
    ["connection", () => new OpenAI.APIConnectionError({ message: `connect failed ${KEY}`, cause: new Error("ECONNREFUSED") }), "TRANSIENT", "connection", 30],
    ["408", () => apiErr(408, { message: "timeout", type: "timeout" }), "TRANSIENT", "http_408:timeout", 30],
    ["409", () => apiErr(409, { message: "conflict", type: "conflict" }), "TRANSIENT", "http_409:conflict", 30],
    ["500", () => apiErr(500, { message: "oops", type: "server_error" }), "TRANSIENT", "http_500:server_error", 30],
    ["503", () => apiErr(503, { message: "overloaded", type: "server_error" }), "TRANSIENT", "http_503:server_error", 60],
    ["500 with retry-after", () => apiErr(500, { type: "server_error" }, { "retry-after": "12" }), "TRANSIENT", "http_500:server_error", 12],
    ["429 rate limit, retry-after", () => apiErr(429, { message: "Rate limit reached", type: "requests", code: "rate_limit_exceeded" }, { "retry-after": "7" }), "TRANSIENT", "http_429:rate_limit_exceeded", 7],
    ["429 rate limit, retry-after-ms", () => apiErr(429, { type: "tokens", code: "rate_limit_exceeded" }, { "retry-after-ms": "1500" }), "TRANSIENT", "http_429:rate_limit_exceeded", 2],
    ["429 rate limit, no header", () => apiErr(429, { type: "requests" }), "TRANSIENT", "http_429:requests", 60],
    ["429 insufficient_quota", () => billing("insufficient_quota"), "GLOBAL", "http_429:insufficient_quota", null],
    ["429 type insufficient_quota, no code", () => apiErr(429, { message: "quota", type: "insufficient_quota", code: null }), "GLOBAL", "http_429:insufficient_quota", null],
    ["429 credit_balance_exhausted", () => billing("credit_balance_exhausted"), "GLOBAL", "http_429:credit_balance_exhausted", null],
    ["429 organization_spend_limit_exceeded", () => billing("organization_spend_limit_exceeded"), "GLOBAL", "http_429:organization_spend_limit_exceeded", null],
    ["429 project_spend_limit_exceeded", () => billing("project_spend_limit_exceeded"), "GLOBAL", "http_429:project_spend_limit_exceeded", null],
    ["429 organization_usage_limit_exceeded", () => billing("organization_usage_limit_exceeded"), "GLOBAL", "http_429:organization_usage_limit_exceeded", null],
    ["401 wrong key (message echoes it)", () => apiErr(401, { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" }), "GLOBAL", "http_401:invalid_api_key", null],
    ["402", () => apiErr(402, { message: "payment required", type: "billing_error" }), "GLOBAL", "http_402:billing_error", null],
    ["403", () => apiErr(403, { message: "not allowed", type: "permission_error" }), "GLOBAL", "http_403:permission_error", null],
    ["404 unknown model", () => apiErr(404, { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" }), "GLOBAL", "http_404:model_not_found", null],
    ["422", () => apiErr(422, { message: "unprocessable", type: "invalid_request_error" }), "GLOBAL", "http_422:invalid_request_error", null],
    ["400 bad request", () => apiErr(400, { message: "Invalid schema for response_format", type: "invalid_request_error", code: null }), "GLOBAL", "http_400:invalid_request_error", null],
    ["400 free-text code", () => apiErr(400, { message: "x", type: "invalid_request_error", code: `bad key ${KEY}` }), "GLOBAL", "http_400:invalid_request_error", null],
    ["400 context_length_exceeded", () => apiErr(400, { message: "too long", type: "invalid_request_error", code: "context_length_exceeded" }), "PER_MESSAGE", "http_400:context_length_exceeded:prompt_too_long", null],
    ["400 too long, by message", () => apiErr(400, { message: "This model's maximum context length is 131072 tokens.", type: "invalid_request_error", code: null }), "PER_MESSAGE", "http_400:invalid_request_error:prompt_too_long", null],
    ["413", () => apiErr(413, { message: "too large", type: "request_too_large" }), "PER_MESSAGE", "http_413:request_too_large", null],
    ["xAI wrong key (400, string error body)", () => OpenAI.APIError.generate(400, { code: "Client specified an invalid argument", error: `Incorrect API key provided: ${KEY}` }, undefined, new Headers()), "GLOBAL", "http_400:unknown", null],
    ["non-API SDK error", () => new OpenAI.OpenAIError(`missing credentials ${KEY}`), "GLOBAL", "sdk_error", null],
    ["fetch failed", () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }), "TRANSIENT", "connection", 30],
    ["anything else", () => new RangeError(`boom ${KEY}`), "GLOBAL", "unexpected:RangeError", null],
  ];

  it.each(table)("%s", async (_name, make, errorClass, error, retryAfterSec) => {
    const { client } = fakeClient([make() as Error]);
    const res = await createOpenAiCompatExtractor(cfg({ client, maxRetries: 0 })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass, error, retryAfterSec, usage: null, costUsd: 0 });
    expect(res.request).toMatchObject({ extractor: "openai", model: "gpt-test", maxTokens: 16_000 });
    expect(JSON.stringify(res)).not.toContain("FAKEKEY");
  });

  it.each([
    ["connection timeout", new OpenAI.APIConnectionTimeoutError(), 270_000],
    ["connection", new OpenAI.APIConnectionError({ message: "x" }), 300_000],
    ["user abort", new OpenAI.APIUserAbortError(), 280_000],
    ["fetch failed", new TypeError("fetch failed"), 290_000],
  ])("%s after ≥ 270 s → TRANSIENT deadline (the pipeline parks after repeats)", (_name, err, elapsed) => {
    expect(classifyOpenAiError(err, elapsed)).toEqual({ errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR, retryAfterSec: 30 });
  });

  it("a timeout just under 270 s stays a timeout", () => {
    expect(classifyOpenAiError(new OpenAI.APIConnectionTimeoutError(), 269_999).error).toBe("timeout");
  });

  it("a timeout after ≥ 270 s is the deadline, never retried", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { client, calls } = fakeClient([
      () => {
        now = 301_000;
        throw new OpenAI.APIConnectionTimeoutError();
      },
    ]);
    const res = await createOpenAiCompatExtractor(cfg({ client, maxRetries: 2 })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR });
    expect(calls).toHaveLength(1);
  });
});

describe("createOpenAiCompatExtractor — quick retries (maxRetries)", () => {
  const e500 = (headers: Record<string, string> = { "retry-after-ms": "1" }) => apiErr(500, { message: "oops", type: "server_error" }, headers);

  it("retries a TRANSIENT failure after the server's short wait", async () => {
    const { client, calls } = fakeClient([e500(), completion()]);
    const res = await createOpenAiCompatExtractor(cfg({ client, maxRetries: 2 })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries", async () => {
    const { client, calls } = fakeClient([e500(), e500(), e500()]);
    const res = await createOpenAiCompatExtractor(cfg({ client, maxRetries: 2 })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "http_500:server_error" });
    expect(calls).toHaveLength(3);
  });

  it("backs off without a server wait (a connection blip)", async () => {
    const { client, calls } = fakeClient([new OpenAI.APIConnectionError({ message: "reset" }), completion()]);
    const res = await createOpenAiCompatExtractor(cfg({ client, maxRetries: 1 })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["a long Retry-After", () => apiErr(429, { type: "requests", code: "rate_limit_exceeded" }, { "retry-after": "120" }), "TRANSIENT"],
    ["x-should-retry: false", () => e500({ "x-should-retry": "false" }), "TRANSIENT"],
    ["a GLOBAL failure", () => apiErr(401, { type: "invalid_request_error", code: "invalid_api_key" }), "GLOBAL"],
    ["a PER_MESSAGE failure", () => apiErr(413, { type: "request_too_large" }), "PER_MESSAGE"],
  ])("hands %s straight back", async (_name, make, errorClass) => {
    const { client, calls } = fakeClient([make()]);
    const res = await createOpenAiCompatExtractor(cfg({ client, maxRetries: 2 })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass });
    expect(calls).toHaveLength(1);
  });
});

describe("createOpenAiClient", () => {
  it("passes every option explicitly: no OPENAI_* environment variable applies", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-env-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example/v1");
    vi.stubEnv("OPENAI_ORG_ID", "org-env");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-env");
    vi.stubEnv("OPENAI_ADMIN_KEY", "admin-env");
    vi.stubEnv("OPENAI_WEBHOOK_SECRET", "whsec-env");
    const openai = createOpenAiClient("openai", KEY, { timeoutMs: 1_234, maxRetries: 1 });
    expect(openai.apiKey).toBe(KEY);
    expect(openai.baseURL).toBe(OPENAI_BASE_URL);
    expect(openai.organization).toBeNull();
    expect(openai.project).toBeNull();
    expect(openai.adminAPIKey).toBeNull();
    expect(openai.webhookSecret).toBeNull();
    expect(openai.timeout).toBe(1_234);
    expect(openai.maxRetries).toBe(1);
    expect(createOpenAiClient("xai", KEY, { timeoutMs: 1, maxRetries: 0 }).baseURL).toBe(XAI_BASE_URL);
  });
});
