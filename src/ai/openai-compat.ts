/**
 * OpenAI and xAI (Grok) extractor: the official OpenAI SDK, Chat Completions with strict structured output
 * (one schema for both, src/ai/portable-schema.ts), non-streaming. xAI is OpenAI-compatible at its own base URL;
 * its differences are a success finish reason "end_turn" and the exact cost in usage.cost_in_usd_ticks.
 *
 * The request carries no reasoning effort, temperature, stop sequences or penalties: models differ in what they
 * accept (xAI reasoning models reject stop and penalties), and a rejected parameter would pause AI everywhere.
 */
import OpenAI from "openai";
import type { AiUsage, ExtractionInput, Extractor, ExtractorErrorClass, ExtractorResult } from "../domain/types.js";
import {
  DEADLINE_AFTER_MS,
  headerRetryMs,
  isAbortError,
  isNetworkError,
  parseExtractionText,
  PROMPT_TOO_LONG,
  providerPipelineVersion,
  retryAfterFrom,
  roundUsd,
  safeTag,
  withQuickRetries,
  type AttemptOutcome,
  type ClassifiedError,
} from "./adapter-common.js";
import { MAX_OUTPUT_TOKENS, STREAM_DEADLINE_ERROR } from "./claude.js";
import { portableExtractionSchema } from "./portable-schema.js";
import { addUsage, ceilingCostUsd, ZERO_USAGE } from "./pricing.js";
import { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import type { OpenAiCompatExtractorConfig } from "./providers.js";
import { SCHEMA_VERSION } from "./schema.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const XAI_BASE_URL = "https://api.x.ai/v1";

/**
 * Every option explicit, so no OPENAI_* variable (base URL, organization, project, admin key) of the process
 * environment reaches a request.
 */
export function createOpenAiClient(provider: "openai" | "xai", apiKey: string, opts: { timeoutMs: number; maxRetries: number }): OpenAI {
  return new OpenAI({
    apiKey,
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: provider === "xai" ? XAI_BASE_URL : OPENAI_BASE_URL,
    timeout: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  });
}

/** The slice of the OpenAI client the extractor uses (lets tests inject a fake). */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(body: OpenAI.ChatCompletionCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): PromiseLike<OpenAI.ChatCompletion>;
    };
  };
}

// ── Error classification ────────────────────────────────────────────────────

/** 429s that are about money, not rate: retrying does not help (pause AI until someone fixes billing). */
const BILLING_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
  "billing_hard_limit_reached",
]);
const TOO_LONG_CODES = new Set(["context_length_exceeded", "string_above_max_length"]);

const DEADLINE: ClassifiedError = { errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR, retryAfterSec: 30 };

/**
 * SDK error → error class, from the error's class, HTTP status, `code` and `type` (the message is matched for
 * "prompt too long" only, never kept). A connection or timeout failure after {@link DEADLINE_AFTER_MS} counts as
 * the message's own runaway generation (STREAM_DEADLINE_ERROR, parked after repeats), not an outage.
 */
export function classifyOpenAiError(err: unknown, elapsedMs = 0): ClassifiedError {
  const long = elapsedMs >= DEADLINE_AFTER_MS;
  // Subclasses of APIError with no status: check them first.
  if (err instanceof OpenAI.APIUserAbortError) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "aborted", retryAfterSec: 5 };
  if (err instanceof OpenAI.APIConnectionTimeoutError) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "timeout", retryAfterSec: 30 };
  if (err instanceof OpenAI.APIConnectionError) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "connection", retryAfterSec: 30 };
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    const code = safeTag(err.code);
    const type = safeTag(err.type);
    const tag = `http_${status}:${code ?? type ?? "unknown"}`;
    // No status and not a connection error: an error event of an open response, treated like claude.ts does.
    if (status === 0) return { errorClass: "TRANSIENT", error: tag, retryAfterSec: 30 };
    if (status === 429) {
      if ((code && BILLING_CODES.has(code)) || (type && BILLING_CODES.has(type))) return { errorClass: "GLOBAL", error: tag, retryAfterSec: null };
      return { errorClass: "TRANSIENT", error: tag, retryAfterSec: retryAfterFrom(err.headers, 60) };
    }
    if (status === 408 || status === 409) return { errorClass: "TRANSIENT", error: tag, retryAfterSec: retryAfterFrom(err.headers, 30) };
    if (status >= 500) return { errorClass: "TRANSIENT", error: tag, retryAfterSec: retryAfterFrom(err.headers, status === 503 ? 60 : 30) };
    if (status === 413) return { errorClass: "PER_MESSAGE", error: tag, retryAfterSec: null };
    if (status === 400 && ((code && TOO_LONG_CODES.has(code)) || PROMPT_TOO_LONG.test(err.message))) {
      return { errorClass: "PER_MESSAGE", error: `${tag}:prompt_too_long`, retryAfterSec: null };
    }
    // 401, 402, 403, 404 (unknown model), 422, other 4xx: the same for every message.
    return { errorClass: "GLOBAL", error: tag, retryAfterSec: null };
  }
  if (err instanceof OpenAI.OpenAIError) return { errorClass: "GLOBAL", error: "sdk_error", retryAfterSec: null };
  if (isNetworkError(err)) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "connection", retryAfterSec: 30 };
  if (isAbortError(err)) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "aborted", retryAfterSec: 5 };
  const name = err instanceof Error ? err.name : typeof err;
  return { errorClass: "GLOBAL", error: `unexpected:${safeTag(name) ?? "error"}`, retryAfterSec: null };
}

// ── Response handling ───────────────────────────────────────────────────────

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Disjoint fields like Anthropic's: cached and cache-written tokens are part of prompt_tokens. */
export function openAiUsage(u: OpenAI.ChatCompletion["usage"] | null | undefined): AiUsage {
  const cached = count(u?.prompt_tokens_details?.cached_tokens);
  const written = count(u?.prompt_tokens_details?.cache_write_tokens);
  return {
    inputTokens: Math.max(0, count(u?.prompt_tokens) - cached - written),
    outputTokens: count(u?.completion_tokens),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: written,
  };
}

/** xAI reports the exact cost (10^10 ticks per USD); everything else is priced at the ceiling. */
export function openAiCostUsd(provider: "openai" | "xai", u: OpenAI.ChatCompletion["usage"] | null | undefined): number {
  const ticks = (u as { cost_in_usd_ticks?: unknown } | null | undefined)?.cost_in_usd_ticks;
  if (provider === "xai" && typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0) return roundUsd(ticks / 1e10);
  return ceilingCostUsd(openAiUsage(u));
}

// ── Extractor ───────────────────────────────────────────────────────────────

export function createOpenAiCompatExtractor(cfg: OpenAiCompatExtractorConfig): Extractor {
  const pipelineVersion = providerPipelineVersion(cfg.provider, cfg.model, cfg.componentVersions);
  const schema = portableExtractionSchema();
  let client: ChatCompletionsClient | null = (cfg.client as ChatCompletionsClient | undefined) ?? null;

  function body(input: ExtractionInput, maxTokens: number): OpenAI.ChatCompletionCreateParamsNonStreaming {
    return {
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: renderUserPrompt(input) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema } },
      max_completion_tokens: maxTokens,
    };
  }

  async function extract(input: ExtractionInput): Promise<ExtractorResult> {
    client ??= createOpenAiClient(cfg.provider, cfg.apiKey, { timeoutMs: cfg.timeoutMs, maxRetries: 0 });
    const api = client;
    const started = performance.now();
    const request = { extractor: cfg.provider, model: cfg.model, schemaMode: "strict", promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, input };

    let usage: AiUsage = ZERO_USAGE;
    let billed = false;
    let costUsd = 0;
    let model: string | null = null;
    let stopReason: string | null = null;
    let maxTokens = cfg.maxTokens;
    let bumped = false;
    let schemaRetried = false;

    const absorb = (res: OpenAI.ChatCompletion) => {
      billed = true;
      usage = addUsage(usage, openAiUsage(res.usage));
      costUsd = roundUsd(costUsd + openAiCostUsd(cfg.provider, res.usage));
      model = typeof res.model === "string" && res.model ? res.model : cfg.model;
    };
    const fail = (errorClass: ExtractorErrorClass, error: string, retryAfterSec: number | null = null): ExtractorResult => ({
      ok: false,
      errorClass,
      error,
      retryAfterSec,
      model,
      stopReason,
      usage: billed ? usage : null,
      costUsd,
      latencyMs: Math.round(performance.now() - started),
      request: { ...request, maxTokens },
    });

    /** One request, SDK retries off (see withQuickRetries). */
    const attempt = async (payload: OpenAI.ChatCompletionCreateParamsNonStreaming, callStarted: number): Promise<AttemptOutcome<OpenAI.ChatCompletion>> => {
      try {
        return { ok: true, value: await api.chat.completions.create(payload, { timeout: cfg.timeoutMs, maxRetries: 0 }) };
      } catch (err) {
        const headers = err instanceof OpenAI.APIError ? err.headers : undefined;
        // x-should-retry: false (OpenAI's "do not retry this") hands the failure straight back.
        const waitMs = headers?.get("x-should-retry") === "false" ? Number.POSITIVE_INFINITY : headerRetryMs(headers);
        return { ok: false, error: classifyOpenAiError(err, performance.now() - callStarted), waitMs };
      }
    };

    // At most three calls: the first, one max-tokens bump, one schema retry (each with its quick retries).
    for (;;) {
      const payload = body(input, maxTokens);
      const out = await withQuickRetries(cfg.maxRetries, (callStarted) => attempt(payload, callStarted));
      if (!out.ok) return fail(out.error.errorClass, out.error.error, out.error.retryAfterSec);
      const res = out.value;
      absorb(res);
      const choice = Array.isArray(res.choices) ? res.choices[0] : undefined;
      if (!choice) return fail("PER_MESSAGE", "no_choice");
      const finish = typeof choice.finish_reason === "string" ? (choice.finish_reason as string) : null;
      stopReason = finish;

      const refusal = choice.message?.refusal;
      if (typeof refusal === "string" && refusal.trim()) return fail("PER_MESSAGE", "refusal");
      if (finish === "length") {
        if (!bumped && maxTokens < MAX_OUTPUT_TOKENS) {
          bumped = true;
          maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
          continue;
        }
        return fail("PER_MESSAGE", "max_tokens");
      }
      if (finish === "content_filter") return fail("PER_MESSAGE", "content_filter");
      if (finish !== null && finish !== "stop" && finish !== "end_turn") return fail("PER_MESSAGE", `finish:${safeTag(finish) ?? "other"}`);

      const parsed = parseExtractionText(choice.message?.content);
      if (parsed.ok) {
        return {
          ok: true,
          output: parsed.output,
          model: model ?? cfg.model,
          stopReason: finish ?? "stop",
          usage,
          costUsd,
          latencyMs: Math.round(performance.now() - started),
          request: { ...request, maxTokens },
        };
      }
      if (!schemaRetried) {
        schemaRetried = true;
        continue;
      }
      return fail("PER_MESSAGE", parsed.error);
    }
  }

  return { name: cfg.provider, pipelineVersion, extract };
}
