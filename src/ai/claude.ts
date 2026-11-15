import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { BetaMessage, BetaMessageStreamParams, BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { AiUsage, ExtractionInput, Extractor, ExtractorErrorClass, ExtractorResult } from "../domain/types.js";
import { addUsage, estimateCostUsd, estimateCostUsdSplit, ZERO_USAGE } from "./pricing.js";
import { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { type ExtractionOutput, ExtractionWire, parseWireOutput, SCHEMA_VERSION } from "./schema.js";
import { strictifyJsonSchema } from "./strict-schema.js";
import { componentValues } from "./versions.js";

export interface ClaudeExtractorConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  fallbacks: "default" | "off";
  cacheTtl: "5m" | "1h";
  maxTokens: number;
  /**
   * Per attempt, until the response headers arrive (the SDK's request timeout; connection timeouts are retried
   * `maxRetries` times). Generation itself is streamed and bounded by {@link generationDeadlineMs}.
   */
  timeoutMs: number;
  maxRetries: number;
  strictEnums: boolean;
  /** Pipeline component versions folded into pipelineVersion. */
  componentVersions: Record<string, string>;
  /** The key the worker resolved (environment or Admin → AI). Absent: ANTHROPIC_API_KEY from the environment. */
  apiKey?: string;
  /** Injected for tests; defaults to new Anthropic(). */
  client?: unknown;
}

/** Per-request options the extractor passes to the SDK. */
export interface ClaudeRequestOptions {
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

/** The slice of the SDK's BetaMessageStream the extractor uses. */
export interface BetaMessageStreamLike {
  /** "connect": the response headers arrived (no SDK retry happens after this point). */
  on(event: "connect", listener: () => void): unknown;
  finalMessage(): Promise<BetaMessage>;
  /** The message accumulated so far (usage of an interrupted stream). */
  readonly currentMessage?: BetaMessage | undefined;
}

/** The slice of the SDK client the extractor uses (lets tests inject a fake). */
export interface BetaMessagesClient {
  beta: { messages: { stream(params: BetaMessageStreamParams, options?: ClaudeRequestOptions): BetaMessageStreamLike } };
}

/** Beta header for `fallbacks: "default"` (server-side refusal fallbacks, routed by refusal category). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Output ceiling for the one max_tokens bump. */
export const MAX_OUTPUT_TOKENS = 128_000;
/** Back-off hint when a refusal came back because the fallback model had no capacity. */
const FALLBACK_BUSY_RETRY_SEC = 60;

/**
 * The response is streamed, so a long generation (up to max_tokens) never trips an HTTP timeout; instead the whole
 * generation, from the response headers on, gets this deadline: a fixed allowance plus max_tokens at a pessimistic
 * output rate (the SDK's own non-streaming estimate assumes ~35 tokens/s). 16k tokens → 11:40 min, 32k → 22:20 min.
 */
const GENERATION_GRACE_MS = 60_000;
const MIN_OUTPUT_TOKENS_PER_SEC = 25;
export function generationDeadlineMs(maxTokens: number): number {
  return GENERATION_GRACE_MS + Math.ceil((maxTokens * 1000) / MIN_OUTPUT_TOKENS_PER_SEC);
}
/**
 * ExtractorResult.error (TRANSIENT) of a generation that ran past {@link generationDeadlineMs}. Unlike connection
 * timeouts (an outage), it is specific to the message: the pipeline parks it after a few repeats.
 */
export const STREAM_DEADLINE_ERROR = "deadline";

/**
 * Models without adaptive thinking / effort (Haiku 4.5, 4.5-and-older Opus/Sonnet, Claude 3). For those the
 * request omits `thinking`, `output_config.effort` and `fallbacks`, which they would reject with a 400.
 */
const LEGACY_MODEL = /^claude-(haiku-|3|(opus|sonnet)-4-[0-5](-|$))/;
export const supportsAdaptiveThinking = (model: string): boolean => !LEGACY_MODEL.test(model);

/** prompt | schema | model | effort | component versions (values in key order). */
export function claudePipelineVersion(cfg: Pick<ClaudeExtractorConfig, "model" | "effort" | "strictEnums" | "componentVersions">): string {
  const components: Record<string, string> = { ...cfg.componentVersions, ...(cfg.strictEnums ? { schemaMode: "strict" } : {}) };
  return [PROMPT_VERSION, SCHEMA_VERSION, cfg.model, cfg.effort, ...componentValues(components)].join("|");
}

/**
 * `output_config.format` for the extraction schema: the wire format ({@link ExtractionWire}, no unions). Default:
 * the SDK helper (enum/const moved into descriptions, zod re-validates). strictEnums: z.toJSONSchema +
 * {@link strictifyJsonSchema}, which keeps enum/const.
 */
export function extractionOutputFormat(strictEnums: boolean): { type: "json_schema"; schema: Record<string, unknown> } {
  if (strictEnums) return { type: "json_schema", schema: strictifyJsonSchema(z.toJSONSchema(ExtractionWire, { reused: "ref" }) as Record<string, unknown>) };
  return { type: "json_schema", schema: zodOutputFormat(ExtractionWire).schema };
}

// ── Error classification ────────────────────────────────────────

export interface ClassifiedError {
  errorClass: ExtractorErrorClass;
  /** Code-like description: status, error type and SDK class only. Never the message (it may echo content). */
  error: string;
  retryAfterSec: number | null;
}

function retryAfterFrom(headers: Headers | undefined, fallbackSec: number): number {
  const ms = Number(headers?.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  const raw = headers?.get("retry-after");
  if (raw) {
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(1, Math.ceil((when - Date.now()) / 1000));
  }
  return fallbackSec;
}

const PROMPT_TOO_LONG = /prompt is too long|too many (input )?tokens|context (window|length)|exceeds? the (maximum|context)/i;

/** Error types that stay GLOBAL even when they arrive as an in-stream `error` event. */
const STREAM_GLOBAL_TYPES = new Set(["authentication_error", "permission_error", "billing_error", "invalid_request_error", "not_found_error"]);

/**
 * SDK error → error class. TRANSIENT: 429, 408/409, 5xx/529, connection, timeout, abort, and an in-stream `error`
 * event (overloaded/api/rate-limit errors after HTTP 200; the message stays at the head of the queue). PER_MESSAGE:
 * 413 and prompt-too-long 400s (park this message). GLOBAL: 401/403/404, billing, other 400/422, SDK misuse and
 * code bugs (pause all mailboxes without consuming messages).
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof Anthropic.APIUserAbortError) return { errorClass: "TRANSIENT", error: "aborted", retryAfterSec: 5 };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { errorClass: "TRANSIENT", error: "timeout", retryAfterSec: 30 };
  if (err instanceof Anthropic.APIConnectionError) return { errorClass: "TRANSIENT", error: "connection", retryAfterSec: 30 };
  if (err instanceof Anthropic.APIError && typeof err.status !== "number") {
    // No HTTP status: an `event: error` in an already-open stream.
    const type = err.type ?? "unknown";
    if (STREAM_GLOBAL_TYPES.has(type)) return { errorClass: "GLOBAL", error: `stream:${type}`, retryAfterSec: null };
    return { errorClass: "TRANSIENT", error: `stream:${type}`, retryAfterSec: type === "overloaded_error" || type === "rate_limit_error" ? 60 : 30 };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    const type = err.type ?? "unknown";
    const code = `http_${status}:${type}`;
    if (type === "billing_error" || status === 402) return { errorClass: "GLOBAL", error: code, retryAfterSec: null };
    if (status === 429) return { errorClass: "TRANSIENT", error: code, retryAfterSec: retryAfterFrom(err.headers, 60) };
    if (status === 408 || status === 409) return { errorClass: "TRANSIENT", error: code, retryAfterSec: retryAfterFrom(err.headers, 30) };
    if (status >= 500) return { errorClass: "TRANSIENT", error: code, retryAfterSec: retryAfterFrom(err.headers, status === 529 ? 60 : 30) };
    if (status === 413) return { errorClass: "PER_MESSAGE", error: code, retryAfterSec: null };
    if (status === 400 && PROMPT_TOO_LONG.test(err.message)) return { errorClass: "PER_MESSAGE", error: `${code}:prompt_too_long`, retryAfterSec: null };
    return { errorClass: "GLOBAL", error: code, retryAfterSec: null };
  }
  if (err instanceof Anthropic.AnthropicError) return { errorClass: "GLOBAL", error: "sdk_error", retryAfterSec: null };
  const name = err instanceof Error ? err.name : typeof err;
  return { errorClass: "GLOBAL", error: `unexpected:${name}`, retryAfterSec: null };
}

// ── Response handling ────────────────────────────────────────────────────────

function toAiUsage(u: BetaUsage | null | undefined): AiUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheCreationInputTokens: u?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u?.cache_read_input_tokens ?? 0,
  };
}

/**
 * Cost of one response, priced at the model that produced it (`response.model`; a server-side fallback may
 * differ from the requested model). Top-level usage covers only the serving attempt; declined-before-output
 * attempts are not billed.
 */
export function responseCostUsd(msg: Pick<BetaMessage, "model" | "usage">, cacheTtl: "5m" | "1h"): number {
  const usage = toAiUsage(msg.usage);
  const cc = msg.usage?.cache_creation;
  if (cc) return estimateCostUsdSplit(msg.model, usage, { write5m: cc.ephemeral_5m_input_tokens ?? 0, write1h: cc.ephemeral_1h_input_tokens ?? 0 });
  return estimateCostUsd(msg.model, usage, cacheTtl);
}

type ParseOutcome = { ok: true; output: ExtractionOutput } | { ok: false; error: string };

/** Concatenate the text blocks (thinking/fallback blocks are skipped) and validate against the wire schema. */
export function parseExtraction(msg: Pick<BetaMessage, "content">): ParseOutcome {
  const text = msg.content
    .filter((b): b is Extract<BetaMessage["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) return { ok: false, error: "no_text_block" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  return parseWireOutput(json);
}

// ── Extractor ────────────────────────────────────────────────────────────────

function defaultClient(cfg: ClaudeExtractorConfig): BetaMessagesClient {
  return new Anthropic({
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    authToken: null,
    maxRetries: cfg.maxRetries,
    timeout: cfg.timeoutMs,
  }) as unknown as BetaMessagesClient;
}

/** Claude API extractor: beta messages + structured output + fallbacks + error classification. */
export function createClaudeExtractor(cfg: ClaudeExtractorConfig): Extractor {
  const pipelineVersion = claudePipelineVersion(cfg);
  const outputFormat = extractionOutputFormat(cfg.strictEnums);
  const adaptive = supportsAdaptiveThinking(cfg.model);
  const useFallbacks = cfg.fallbacks === "default" && adaptive;
  let client: BetaMessagesClient | null = (cfg.client as BetaMessagesClient | undefined) ?? null;

  function params(input: ExtractionInput, maxTokens: number): BetaMessageStreamParams {
    return {
      model: cfg.model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral", ttl: cfg.cacheTtl } }],
      messages: [{ role: "user", content: renderUserPrompt(input) }],
      output_config: adaptive ? { format: outputFormat, effort: cfg.effort } : { format: outputFormat },
      ...(adaptive ? { thinking: { type: "adaptive" as const } } : {}),
      ...(useFallbacks ? { fallbacks: "default" as const, betas: [FALLBACK_BETA] } : {}),
    };
  }

  async function extract(input: ExtractionInput): Promise<ExtractorResult> {
    client ??= defaultClient(cfg);
    const started = performance.now();
    const request = {
      extractor: "claude",
      model: cfg.model,
      effort: adaptive ? cfg.effort : null,
      thinking: adaptive ? "adaptive" : null,
      fallbacks: useFallbacks ? "default" : "off",
      cacheTtl: cfg.cacheTtl,
      strictEnums: cfg.strictEnums,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      input,
    };

    let usage: AiUsage = ZERO_USAGE;
    let billed = false;
    let costUsd = 0;
    let model: string | null = null;
    let stopReason: string | null = null;
    let maxTokens = cfg.maxTokens;
    let bumped = false;
    let schemaRetried = false;

    const absorb = (m: Pick<BetaMessage, "model" | "usage">) => {
      billed = true;
      usage = addUsage(usage, toAiUsage(m.usage));
      costUsd = Math.round((costUsd + responseCostUsd(m, cfg.cacheTtl)) * 1e8) / 1e8;
      model = m.model;
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

    // At most three calls: the first, one max_tokens bump, one schema retry.
    for (;;) {
      const call = await streamOnce(client, params(input, maxTokens), { timeout: cfg.timeoutMs, maxRetries: cfg.maxRetries }, generationDeadlineMs(maxTokens));
      if (!call.ok) {
        // An interrupted stream was (at least partly) billed: keep what its snapshot reported.
        if (call.partial) absorb(call.partial);
        return fail(call.error.errorClass, call.error.error, call.error.retryAfterSec);
      }
      const msg = call.message;
      absorb(msg);
      stopReason = msg.stop_reason;

      if (msg.stop_reason === "refusal") {
        const details = msg.stop_details;
        const category = details?.category ?? "unknown";
        // A recommended_model means the fallback was never attempted (its capacity was exhausted): retry later.
        if (details?.recommended_model) return fail("TRANSIENT", `refusal_fallback_unavailable:${category}`, FALLBACK_BUSY_RETRY_SEC);
        return fail("PER_MESSAGE", `refusal:${category}`);
      }
      if (msg.stop_reason === "max_tokens") {
        if (!bumped && maxTokens < MAX_OUTPUT_TOKENS) {
          bumped = true;
          // The generation deadline scales with max_tokens; the per-attempt header timeout does not need to.
          maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
          continue;
        }
        return fail("PER_MESSAGE", "max_tokens");
      }
      if (msg.stop_reason === "model_context_window_exceeded") return fail("PER_MESSAGE", "context_window_exceeded");

      const parsed = parseExtraction(msg);
      if (parsed.ok) {
        return {
          ok: true,
          output: parsed.output,
          model: msg.model,
          stopReason: msg.stop_reason ?? "end_turn",
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

  return { name: "claude", pipelineVersion, extract };
}

type StreamOutcome = { ok: true; message: BetaMessage } | { ok: false; error: ClassifiedError; partial: BetaMessage | null };

/**
 * One streamed call: `stream(...).finalMessage()` (no HTTP timeout on a long generation, so the max_tokens path
 * stays reachable). Before the headers the SDK's `timeout`/`maxRetries` apply; from "connect" on, the whole generation
 * gets `deadlineMs`. Failures after "connect" that are not API errors (the connection dropped, the stream ended
 * before message_stop) are TRANSIENT, never GLOBAL.
 */
async function streamOnce(client: BetaMessagesClient, body: BetaMessageStreamParams, options: ClaudeRequestOptions, deadlineMs: number): Promise<StreamOutcome> {
  const abort = new AbortController();
  let connected = false;
  let deadlineHit = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stream: BetaMessageStreamLike | null = null;
  try {
    stream = client.beta.messages.stream(body, { ...options, signal: abort.signal });
    stream.on("connect", () => {
      connected = true;
      timer = setTimeout(() => {
        deadlineHit = true;
        abort.abort();
      }, deadlineMs);
      timer.unref?.();
    });
    return { ok: true, message: await stream.finalMessage() };
  } catch (err) {
    const partial = stream?.currentMessage?.usage ? stream.currentMessage : null;
    if (deadlineHit) return { ok: false, error: { errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR, retryAfterSec: 30 }, partial };
    if (connected && err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) {
      return { ok: false, error: { errorClass: "TRANSIENT", error: "stream_interrupted", retryAfterSec: 30 }, partial };
    }
    return { ok: false, error: classifyError(err), partial };
  } finally {
    clearTimeout(timer);
  }
}
