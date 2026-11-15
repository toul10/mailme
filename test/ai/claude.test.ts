import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import {
  classifyError,
  claudePipelineVersion,
  createClaudeExtractor,
  extractionOutputFormat,
  FALLBACK_BETA,
  MAX_OUTPUT_TOKENS,
  parseExtraction,
  responseCostUsd,
  supportsAdaptiveThinking,
  type ClaudeExtractorConfig,
} from "../../src/ai/claude.js";
import { estimateCostUsd } from "../../src/ai/pricing.js";
import { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "../../src/ai/prompt.js";
import { ExtractionOutput, ExtractionWire, SCHEMA_VERSION } from "../../src/ai/schema.js";
import { betaMessage, fakeClient, makeInput, VALID_OUTPUT, VALID_TEXT, VALID_WIRE } from "./helpers.js";

function cfg(over: Partial<ClaudeExtractorConfig> = {}): ClaudeExtractorConfig {
  return {
    model: "claude-opus-5",
    effort: "high",
    fallbacks: "default",
    cacheTtl: "1h",
    maxTokens: 16_000,
    timeoutMs: 180_000,
    maxRetries: 2,
    strictEnums: false,
    componentVersions: { cleaner: "c1", resolver: "r1" },
    ...over,
  };
}

function apiError(status: number, type: string | null, message = "error", headers: Record<string, string> = {}) {
  return Anthropic.APIError.generate(status, type ? { type: "error", error: { type, message } } : undefined, message, new Headers(headers));
}

const input = makeInput();

describe("createClaudeExtractor — request shape", () => {
  it("sends beta messages with structured output, effort, adaptive thinking, fallbacks and a cached system prompt", async () => {
    const { client, calls } = fakeClient([betaMessage()]);
    const ex = createClaudeExtractor(cfg({ client }));
    const res = await ex.extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const { params, options } = calls[0]!;
    expect(params.model).toBe("claude-opus-5");
    expect(params.max_tokens).toBe(16_000);
    expect(params.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(params.messages).toEqual([{ role: "user", content: renderUserPrompt(input) }]);
    expect(params.output_config?.effort).toBe("high");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(Object.keys((params.output_config?.format?.schema as { properties: object }).properties)).toEqual(["message_class", "suspicious_instructions", "create", "update", "complete", "reopen", "suggest_dismiss"]);
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual([FALLBACK_BETA]);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");
    // Sampling parameters are rejected by current models.
    for (const k of ["temperature", "top_p", "top_k", "stream"]) expect(params).not.toHaveProperty(k);
    // Streamed: `timeout` bounds each attempt until the headers; the generation deadline aborts through `signal`.
    expect(options).toMatchObject({ timeout: 180_000, maxRetries: 2 });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("puts the only cache breakpoint on the system prompt (the user turn stays uncached)", async () => {
    const { client, calls } = fakeClient([betaMessage()]);
    await createClaudeExtractor(cfg({ client, cacheTtl: "5m" })).extract(input);
    const { params } = calls[0]!;
    expect(JSON.stringify(params.messages)).not.toContain("cache_control");
    expect(params).not.toHaveProperty("cache_control");
    expect(params.system).toHaveLength(1);
    expect((params.system as Array<{ cache_control: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });
  });

  it("omits fallbacks and the beta header when fallbacks are off", async () => {
    const { client, calls } = fakeClient([betaMessage()]);
    await createClaudeExtractor(cfg({ client, fallbacks: "off" })).extract(input);
    expect(calls[0]!.params).not.toHaveProperty("fallbacks");
    expect(calls[0]!.params).not.toHaveProperty("betas");
  });

  it("omits thinking, effort and fallbacks for models that reject them (Haiku 4.5)", async () => {
    const { client, calls } = fakeClient([betaMessage({ model: "claude-haiku-4-5" })]);
    const res = await createClaudeExtractor(cfg({ client, model: "claude-haiku-4-5" })).extract(input);
    expect(res.ok).toBe(true);
    const { params } = calls[0]!;
    expect(params).not.toHaveProperty("thinking");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params.output_config).not.toHaveProperty("effort");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-sonnet-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-opus-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-opus-5-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-5")).toBe(true);
  });

  it("records the request without the system prompt", async () => {
    const { client } = fakeClient([betaMessage()]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    const json = JSON.stringify(res.request);
    expect(json).not.toContain(SYSTEM_PROMPT.slice(0, 200));
    expect(res.request).toMatchObject({ extractor: "claude", model: "claude-opus-5", effort: "high", fallbacks: "default", cacheTtl: "1h", input });
  });
});

describe("createClaudeExtractor — results", () => {
  it("returns the parsed output, the answering model, usage and cost", async () => {
    const { client } = fakeClient([betaMessage()]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (!res.ok) throw new Error("expected ok");
    expect(res.output).toEqual(VALID_OUTPUT);
    expect(res.model).toBe("claude-opus-5");
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 8000 });
    // 1000·5 + 500·25 + 8000·0.5 = 21500 µ$
    expect(res.costUsd).toBeCloseTo(0.0215, 10);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("finds the text block after fallback/thinking blocks and prices at the model that served", async () => {
    const content = [
      { type: "fallback", from: { model: "claude-opus-5" }, to: { model: "claude-sonnet-5" }, trigger: { type: "refusal", category: "cyber" } },
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: VALID_TEXT, citations: null },
    ] as unknown as BetaMessage["content"];
    const { client } = fakeClient([betaMessage({ content, model: "claude-sonnet-5" })]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (!res.ok) throw new Error("expected ok");
    expect(res.model).toBe("claude-sonnet-5");
    expect(res.output).toEqual(VALID_OUTPUT);
    expect(res.costUsd).toBeCloseTo(estimateCostUsd("claude-sonnet-5", res.usage), 10);
    expect(res.costUsd).not.toBeCloseTo(estimateCostUsd("claude-opus-5", res.usage), 6);
  });

  it("uses the 5m/1h cache-creation split when the API reports it", () => {
    const msg = betaMessage({
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } },
    });
    expect(responseCostUsd(msg, "1h")).toBe(16.25);
  });

  it("refusal → PER_MESSAGE (fallback already ran server-side), usage still recorded", async () => {
    const { client, calls } = fakeClient([betaMessage({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x", fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null } })]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorClass).toBe("PER_MESSAGE");
    expect(res.error).toBe("refusal:cyber");
    expect(res.stopReason).toBe("refusal");
    expect(res.usage).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("refusal with a recommended_model (fallback had no capacity) → TRANSIENT", async () => {
    const { client } = fakeClient([
      betaMessage({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: "claude-opus-4-8" } }),
    ]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (res.ok) throw new Error("expected failure");
    expect(res.errorClass).toBe("TRANSIENT");
    expect(res.retryAfterSec).toBe(60);
    expect(res.error).toBe("refusal_fallback_unavailable:unknown");
  });

  it("max_tokens → retries once with 2× max_tokens (streamed: the header timeout stays), then succeeds; usage and cost are summed", async () => {
    const { client, calls } = fakeClient([betaMessage({ stop_reason: "max_tokens", text: '{"message_cla' }), betaMessage()]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (!res.ok) throw new Error("expected ok");
    expect(calls.map((c) => c.params.max_tokens)).toEqual([16_000, 32_000]);
    expect(calls.map((c) => c.options?.timeout)).toEqual([180_000, 180_000]);
    expect(res.usage.inputTokens).toBe(2000);
    expect(res.costUsd).toBeCloseTo(0.043, 10);
  });

  it("max_tokens twice → PER_MESSAGE", async () => {
    const { client, calls } = fakeClient([betaMessage({ stop_reason: "max_tokens" }), betaMessage({ stop_reason: "max_tokens" })]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (res.ok) throw new Error("expected failure");
    expect(res.errorClass).toBe("PER_MESSAGE");
    expect(res.error).toBe("max_tokens");
    expect(calls).toHaveLength(2);
    expect(res.usage?.outputTokens).toBe(1000);
  });

  it("max_tokens already at the ceiling → PER_MESSAGE without a retry", async () => {
    const { client, calls } = fakeClient([betaMessage({ stop_reason: "max_tokens" })]);
    const res = await createClaudeExtractor(cfg({ client, maxTokens: MAX_OUTPUT_TOKENS })).extract(input);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("caps the bumped max_tokens at 128k", async () => {
    const { client, calls } = fakeClient([betaMessage({ stop_reason: "max_tokens" }), betaMessage()]);
    await createClaudeExtractor(cfg({ client, maxTokens: 100_000 })).extract(input);
    expect(calls[1]!.params.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("schema failure → one retry, then success", async () => {
    const bad = JSON.stringify({ ...VALID_WIRE, complete: [{ task: "CLOSE_EVERYTHING" }] });
    const { client, calls } = fakeClient([betaMessage({ text: bad }), betaMessage()]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params.max_tokens).toBe(16_000);
  });

  it("schema failure twice → PER_MESSAGE with issue paths only (no content)", async () => {
    const bad = JSON.stringify({ ...VALID_WIRE, message_class: "SECRET-CONTENT", complete: [] });
    const { client, calls } = fakeClient([betaMessage({ text: bad }), betaMessage({ text: bad })]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (res.ok) throw new Error("expected failure");
    expect(res.errorClass).toBe("PER_MESSAGE");
    expect(res.error).toMatch(/^schema_invalid:message_class:/);
    expect(res.error).not.toContain("SECRET-CONTENT");
    expect(calls).toHaveLength(2);
  });

  it("invalid JSON and a missing text block count as schema failures (never GLOBAL)", async () => {
    const a = fakeClient([betaMessage({ text: "Καλημέρα! {not json" }), betaMessage({ text: "still not json" })]);
    const r1 = await createClaudeExtractor(cfg({ client: a.client })).extract(input);
    expect(r1).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "invalid_json" });

    const b = fakeClient([betaMessage({ content: [] }), betaMessage({ content: [] })]);
    const r2 = await createClaudeExtractor(cfg({ client: b.client })).extract(input);
    expect(r2).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "no_text_block" });
  });

  it("a max_tokens bump and a schema retry can both happen (at most three calls)", async () => {
    const { client, calls } = fakeClient([betaMessage({ stop_reason: "max_tokens" }), betaMessage({ text: "{}" }), betaMessage({ text: "{}" }), betaMessage()]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it.each(["stop_sequence", "tool_use", "pause_turn", "compaction", null] as const)("stop_reason %s goes through parsing (never GLOBAL)", async (stop) => {
    const good = fakeClient([betaMessage({ stop_reason: stop })]);
    const ok = await createClaudeExtractor(cfg({ client: good.client })).extract(input);
    expect(ok.ok).toBe(true);

    const empty = fakeClient([betaMessage({ stop_reason: stop, content: [] }), betaMessage({ stop_reason: stop, content: [] })]);
    const bad = await createClaudeExtractor(cfg({ client: empty.client })).extract(input);
    expect(bad).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "no_text_block" });
    expect(empty.calls).toHaveLength(2);
  });

  it("model_context_window_exceeded → PER_MESSAGE", async () => {
    const { client } = fakeClient([betaMessage({ stop_reason: "model_context_window_exceeded" })]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "PER_MESSAGE", error: "context_window_exceeded" });
  });

  it("an SDK error after a paid attempt keeps that attempt's usage and cost", async () => {
    const { client } = fakeClient([betaMessage({ stop_reason: "max_tokens" }), apiError(529, "overloaded_error", "overloaded")]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    if (res.ok) throw new Error("expected failure");
    expect(res.errorClass).toBe("TRANSIENT");
    expect(res.usage?.inputTokens).toBe(1000);
    expect(res.costUsd).toBeGreaterThan(0);
    expect(res.model).toBe("claude-opus-5");
  });

  it("an SDK error on the first call has null usage and zero cost", async () => {
    const { client } = fakeClient([apiError(401, "authentication_error")]);
    const res = await createClaudeExtractor(cfg({ client })).extract(input);
    expect(res).toMatchObject({ ok: false, errorClass: "GLOBAL", usage: null, costUsd: 0, model: null, stopReason: null });
  });
});

describe("classifyError", () => {
  it.each([
    ["429 with retry-after", apiError(429, "rate_limit_error", "slow down", { "retry-after": "12" }), "TRANSIENT", 12],
    ["429 with retry-after-ms", apiError(429, "rate_limit_error", "slow down", { "retry-after-ms": "2500" }), "TRANSIENT", 3],
    ["429 without header", apiError(429, "rate_limit_error"), "TRANSIENT", 60],
    ["500", apiError(500, "api_error"), "TRANSIENT", 30],
    ["529 overloaded", apiError(529, "overloaded_error"), "TRANSIENT", 60],
    ["408", apiError(408, "timeout_error"), "TRANSIENT", 30],
    ["connection", new Anthropic.APIConnectionError({ message: "socket hang up" }), "TRANSIENT", 30],
    ["timeout", new Anthropic.APIConnectionTimeoutError(), "TRANSIENT", 30],
    ["abort", new Anthropic.APIUserAbortError(), "TRANSIENT", 5],
    ["401", apiError(401, "authentication_error"), "GLOBAL", null],
    ["403", apiError(403, "permission_error"), "GLOBAL", null],
    ["404 unknown model", apiError(404, "not_found_error"), "GLOBAL", null],
    ["400 invalid request", apiError(400, "invalid_request_error", "temperature is not supported"), "GLOBAL", null],
    ["400 billing", apiError(400, "billing_error", "credit balance is too low"), "GLOBAL", null],
    ["402", apiError(402, null, "payment required"), "GLOBAL", null],
    ["413", apiError(413, "request_too_large"), "PER_MESSAGE", null],
    ["400 prompt too long", apiError(400, "invalid_request_error", "prompt is too long: 1200000 tokens > 1000000 maximum"), "PER_MESSAGE", null],
    ["in-stream overloaded_error (no HTTP status)", new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers(), "overloaded_error"), "TRANSIENT", 60],
    ["in-stream api_error (no HTTP status)", new Anthropic.APIError(undefined, { type: "error", error: { type: "api_error", message: "x" } }, undefined, new Headers(), "api_error"), "TRANSIENT", 30],
    ["in-stream authentication_error (no HTTP status)", new Anthropic.APIError(undefined, { type: "error", error: { type: "authentication_error", message: "x" } }, undefined, new Headers(), "authentication_error"), "GLOBAL", null],
    ["SDK misuse", new Anthropic.AnthropicError("Streaming is required"), "GLOBAL", null],
    ["code bug", new TypeError("x is undefined"), "GLOBAL", null],
  ] as const)("%s", (_name, err, cls, retry) => {
    const c = classifyError(err);
    expect(c.errorClass).toBe(cls);
    expect(c.retryAfterSec).toBe(retry);
  });

  it("never copies the error message (it can echo content)", () => {
    const c = classifyError(apiError(400, "invalid_request_error", "bad field near «Γιώργος Παπαδόπουλος»"));
    expect(c.error).toBe("http_400:invalid_request_error");
    expect(classifyError(new TypeError("secret body text")).error).toBe("unexpected:TypeError");
  });

  it("parses an HTTP-date retry-after", () => {
    const when = new Date(Date.now() + 90_000).toUTCString();
    const c = classifyError(apiError(503, "api_error", "x", { "retry-after": when }));
    expect(c.retryAfterSec).toBeGreaterThanOrEqual(85);
    expect(c.retryAfterSec).toBeLessThanOrEqual(91);
  });
});

describe("parseExtraction", () => {
  it("joins several text blocks", () => {
    const text = VALID_TEXT;
    const content = [
      { type: "text", text: text.slice(0, 20), citations: null },
      { type: "text", text: text.slice(20), citations: null },
    ] as BetaMessage["content"];
    expect(parseExtraction(betaMessage({ content }))).toEqual({ ok: true, output: VALID_OUTPUT });
  });
});

describe("pipelineVersion and output format", () => {
  it("is prompt|schema|model|effort|components (values in key order)", () => {
    const ex = createClaudeExtractor(cfg({ client: fakeClient([]).client }));
    expect(ex.name).toBe("claude");
    expect(SCHEMA_VERSION).toBe("s2");
    expect(ex.pipelineVersion).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|claude-opus-5|high|c1|r1`);
    expect(claudePipelineVersion({ ...cfg(), componentVersions: { resolver: "r1", cleaner: "c1" } })).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|claude-opus-5|high|c1|r1`);
    expect(claudePipelineVersion({ ...cfg(), effort: "medium", model: "claude-opus-5-5" })).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|claude-opus-5-5|medium|c1|r1`);
  });

  it("changes when strictEnums changes the schema sent", () => {
    expect(claudePipelineVersion({ ...cfg(), strictEnums: true })).not.toBe(claudePipelineVersion(cfg()));
  });

  it("default format comes from the SDK helper (enum/const moved into descriptions)", () => {
    const { schema } = extractionOutputFormat(false);
    const json = JSON.stringify(schema);
    expect(json).not.toContain('"enum"');
    expect(json).not.toContain('"const"');
    expect(json).toContain("{enum:");
  });

  it("strict format keeps enum/const, closes every object and drops numeric/length constraints", () => {
    const { schema } = extractionOutputFormat(true);
    const json = JSON.stringify(schema);
    expect(json).toContain('"enum":["ACTIONABLE","FYI","AUTOMATED","MARKETING","PERSONAL","SPAM"]');
    expect(json).toContain('"enum":["P1","P2","P3","P4","P5","P6","P7","P8","NONE"]');
    for (const k of ["minimum", "maximum", "$schema", "oneOf", "anyOf", "minLength", "maxLength", "pattern"]) expect(json).not.toContain(`"${k}"`);
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.properties) {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
      Object.values(o).forEach(visit);
    };
    visit(schema);
  });

  it("both formats accept every valid output and the zod schemas still enforce the contract", () => {
    expect(ExtractionOutput.safeParse(VALID_OUTPUT).success).toBe(true);
    expect(ExtractionOutput.safeParse({ ...VALID_OUTPUT, operations: [{ op: "NUKE" }] }).success).toBe(false);
    expect(ExtractionWire.safeParse(VALID_WIRE).success).toBe(true);
    expect(ExtractionWire.safeParse({ ...VALID_WIRE, complete: [{ task: "K1" }] }).success).toBe(false);
    // The contract's own shape is not accepted on the wire.
    expect(ExtractionWire.safeParse(VALID_OUTPUT).success).toBe(false);
  });
});
