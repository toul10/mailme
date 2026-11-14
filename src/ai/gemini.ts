/**
 * Gemini extractor over the REST API (models.generateContent), without Google's SDK: one documented endpoint does
 * not justify google-auth-library, protobufjs and ws. The key travels only in the `x-goog-api-key` header, never in
 * the URL (URLs end up in fetch errors and logs).
 *
 * Request body as the official SDK sends it to the Gemini Developer API (@google/genai, generateContentConfigToMldev):
 * top-level `systemInstruction` and `contents`, and `generationConfig` with `responseMimeType`, `responseJsonSchema`
 * (passed through unchanged) and `maxOutputTokens`. No temperature or thinking settings: models differ in what they
 * accept, and a rejected parameter would pause AI everywhere.
 */
import type { AiUsage, ExtractionInput, Extractor, ExtractorErrorClass, ExtractorResult } from "../domain/types.js";
import {
  DEADLINE_AFTER_MS,
  headerRetryMs,
  isAbortError,
  isNetworkError,
  parseExtractionText,
  PROMPT_TOO_LONG,
  providerPipelineVersion,
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
import type { GeminiExtractorConfig } from "./providers.js";
import { SCHEMA_VERSION } from "./schema.js";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** `models/<id>`, the id escaped (listed ids come with the prefix, typed ones without). */
export const geminiModelPath = (model: string): string => `models/${encodeURIComponent(model.replace(/^models\//, ""))}`;

// ── REST shapes (only the fields read) ──────────────────────────────────────

interface GeminiPart {
  text?: unknown;
  thought?: unknown;
}
export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: unknown }>;
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: {
    promptTokenCount?: unknown;
    cachedContentTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
  };
  modelVersion?: unknown;
}
/**
 * Google's error body: `{ error: { code: 400, message, status: "INVALID_ARGUMENT", details: [{ reason }, { retryDelay }] } }`
 * (the newer API surface sends `{ error: { code: "snake_case", message } }`; both are read).
 */
export interface GeminiErrorBody {
  error?: { code?: unknown; message?: unknown; status?: unknown; details?: Array<{ reason?: unknown; retryDelay?: unknown }> };
}

// ── Error classification ────────────────────────────────────────────────────

/** ErrorInfo reasons of a key Google refuses (google.rpc.ErrorInfo on 400/403). */
export const KEY_REASONS = new Set([
  "API_KEY_INVALID",
  "API_KEY_EXPIRED",
  "API_KEY_SERVICE_BLOCKED",
  "API_KEY_HTTP_REFERRER_BLOCKED",
  "API_KEY_IP_ADDRESS_BLOCKED",
  "API_KEY_ANDROID_APP_BLOCKED",
  "API_KEY_IOS_APP_BLOCKED",
]);
const DEADLINE: ClassifiedError = { errorClass: "TRANSIENT", error: STREAM_DEADLINE_ERROR, retryAfterSec: 30 };

/** The `details[].reason` values of an error body that look like identifiers. */
export function errorReasons(body: GeminiErrorBody | null): string[] {
  const details = body?.error?.details;
  return Array.isArray(details) ? details.map((d) => safeTag(d?.reason)).filter((r): r is string => r !== null) : [];
}

/** The wait the server asked for, in ms: retry-after-ms, Retry-After (seconds or a date), or RetryInfo.retryDelay ("37s"). */
export function serverRetryMs(headers: Headers | null | undefined, body: GeminiErrorBody | null): number | null {
  const fromHeaders = headerRetryMs(headers);
  if (fromHeaders !== null) return fromHeaders;
  const details = body?.error?.details;
  for (const d of Array.isArray(details) ? details : []) {
    const m = typeof d?.retryDelay === "string" ? /^(\d{1,6}(?:\.\d{1,9})?)s$/.exec(d.retryDelay) : null;
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  return null;
}

/**
 * An HTTP error → error class, from the status, Google's `status` (e.g. RESOURCE_EXHAUSTED), `details[].reason`
 * (e.g. API_KEY_INVALID) or a snake_case `code`. The message is matched for "input too long" only, never kept.
 */
export function classifyGeminiHttpError(status: number, body: GeminiErrorBody | null, headers?: Headers | null): ClassifiedError {
  const e = body?.error;
  const gStatus = safeTag(e?.status);
  const code = typeof e?.code === "string" ? safeTag(e.code) : null;
  const reasons = errorReasons(body);
  const tag = `http_${status}:${reasons[0] ?? gStatus ?? code ?? "unknown"}`;
  const message = typeof e?.message === "string" ? e.message : "";
  const waitMs = serverRetryMs(headers, body);
  const after = (fallbackSec: number) => (waitMs === null ? fallbackSec : Math.max(1, Math.ceil(waitMs / 1000)));

  if (reasons.some((r) => KEY_REASONS.has(r))) return { errorClass: "GLOBAL", error: tag, retryAfterSec: null };
  if (status === 429 || gStatus === "RESOURCE_EXHAUSTED") return { errorClass: "TRANSIENT", error: tag, retryAfterSec: after(60) };
  if (status === 408 || status >= 500) return { errorClass: "TRANSIENT", error: tag, retryAfterSec: after(status === 503 ? 60 : 30) };
  if (status === 413) return { errorClass: "PER_MESSAGE", error: tag, retryAfterSec: null };
  if (status === 400 && gStatus !== "FAILED_PRECONDITION" && PROMPT_TOO_LONG.test(message)) {
    return { errorClass: "PER_MESSAGE", error: `${tag}:prompt_too_long`, retryAfterSec: null };
  }
  // 400 (bad key, bad schema, FAILED_PRECONDITION: billing or region), 401, 402, 403, 404 (unknown model), other 4xx.
  return { errorClass: "GLOBAL", error: tag, retryAfterSec: null };
}

/**
 * A thrown fetch failure (no HTTP response) → error class. `elapsedMs` counts from the call's first attempt, so a
 * failure after {@link DEADLINE_AFTER_MS} is the deadline, as in the OpenAI adapter.
 */
export function classifyGeminiThrown(err: unknown, elapsedMs: number, timedOut: boolean): ClassifiedError {
  const long = elapsedMs >= DEADLINE_AFTER_MS;
  if (timedOut) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "timeout", retryAfterSec: 30 };
  if (isNetworkError(err)) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "connection", retryAfterSec: 30 };
  if (isAbortError(err)) return long ? DEADLINE : { errorClass: "TRANSIENT", error: "aborted", retryAfterSec: 5 };
  const name = err instanceof Error ? err.name : typeof err;
  return { errorClass: "GLOBAL", error: `unexpected:${safeTag(name) ?? "error"}`, retryAfterSec: null };
}

// ── Response handling ───────────────────────────────────────────────────────

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Disjoint usage: promptTokenCount includes the cached tokens; thinking tokens are billed as output. */
export function geminiUsage(m: GeminiResponse["usageMetadata"] | null | undefined): AiUsage {
  const cached = count(m?.cachedContentTokenCount);
  return {
    inputTokens: Math.max(0, count(m?.promptTokenCount) - cached),
    outputTokens: count(m?.candidatesTokenCount) + count(m?.thoughtsTokenCount),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: 0,
  };
}

/** The candidate's answer: its text parts joined, thought parts skipped. */
export function candidateText(parts: GeminiPart[] | undefined): string {
  return (Array.isArray(parts) ? parts : [])
    .filter((p) => typeof p?.text === "string" && p.thought !== true)
    .map((p) => p.text as string)
    .join("");
}

// ── Extractor ───────────────────────────────────────────────────────────────

export function createGeminiExtractor(cfg: GeminiExtractorConfig): Extractor {
  const pipelineVersion = providerPipelineVersion("gemini", cfg.model, cfg.componentVersions);
  const schema = portableExtractionSchema();
  const doFetch = cfg.fetch ?? fetch;
  const url = `${GEMINI_API_BASE}/${geminiModelPath(cfg.model)}:generateContent`;

  function body(input: ExtractionInput, maxTokens: number): string {
    return JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: renderUserPrompt(input) }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, maxOutputTokens: maxTokens },
    });
  }

  /** One HTTP request with its own timeout. The response is parsed, never kept or logged. */
  async function attempt(payload: string, callStarted: number): Promise<AttemptOutcome<GeminiResponse>> {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, cfg.timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
        body: payload,
        signal: abort.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const errBody = json && typeof json === "object" ? (json as GeminiErrorBody) : null;
        return { ok: false, error: classifyGeminiHttpError(res.status, errBody, res.headers), waitMs: serverRetryMs(res.headers, errBody) };
      }
      if (!json || typeof json !== "object") return { ok: false, error: { errorClass: "TRANSIENT", error: "invalid_response", retryAfterSec: 30 }, waitMs: null };
      return { ok: true, value: json as GeminiResponse };
    } catch (err) {
      return { ok: false, error: classifyGeminiThrown(err, performance.now() - callStarted, timedOut), waitMs: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async function extract(input: ExtractionInput): Promise<ExtractorResult> {
    const started = performance.now();
    const request = { extractor: "gemini", model: cfg.model, schemaMode: "json_schema", promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, input };

    let usage: AiUsage = ZERO_USAGE;
    let billed = false;
    let costUsd = 0;
    let model: string | null = null;
    let stopReason: string | null = null;
    let maxTokens = cfg.maxTokens;
    let bumped = false;
    let schemaRetried = false;

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

    // At most three calls: the first, one max-tokens bump, one schema retry (each with its quick transport retries).
    for (;;) {
      const payload = body(input, maxTokens);
      const out = await withQuickRetries(cfg.maxRetries, (callStarted) => attempt(payload, callStarted));
      if (!out.ok) return fail(out.error.errorClass, out.error.error, out.error.retryAfterSec);
      const res = out.value;
      if (res.usageMetadata) {
        billed = true;
        const u = geminiUsage(res.usageMetadata);
        usage = addUsage(usage, u);
        costUsd = roundUsd(costUsd + ceilingCostUsd(u));
      }
      model = typeof res.modelVersion === "string" && res.modelVersion ? res.modelVersion : cfg.model;

      const blocked = res.promptFeedback?.blockReason;
      if (blocked !== undefined && blocked !== null && blocked !== "BLOCK_REASON_UNSPECIFIED") return fail("PER_MESSAGE", `blocked:${safeTag(blocked) ?? "OTHER"}`);
      const candidate = Array.isArray(res.candidates) ? res.candidates[0] : undefined;
      if (!candidate) return fail("PER_MESSAGE", "no_candidate");
      const finish = candidate.finishReason === undefined || candidate.finishReason === null ? null : (safeTag(candidate.finishReason) ?? "OTHER");
      stopReason = finish;

      if (finish === "MAX_TOKENS") {
        if (!bumped && maxTokens < MAX_OUTPUT_TOKENS) {
          bumped = true;
          maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
          continue;
        }
        return fail("PER_MESSAGE", "max_tokens");
      }
      if (finish !== null && finish !== "STOP") return fail("PER_MESSAGE", `finish:${finish}`);

      const parsed = parseExtractionText(candidateText(candidate.content?.parts));
      if (parsed.ok) {
        return {
          ok: true,
          output: parsed.output,
          model: model ?? cfg.model,
          stopReason: finish ?? "STOP",
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

  return { name: "gemini", pipelineVersion, extract };
}
