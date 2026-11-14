/**
 * Shared pieces of the non-Claude adapters (src/ai/openai-compat.ts, src/ai/gemini.ts): output parsing, error
 * helpers and the pipeline version. Claude keeps its own (src/ai/claude.ts), unchanged.
 */
import type { ExtractorErrorClass } from "../domain/types.js";
import { STREAM_DEADLINE_ERROR } from "./claude.js";
import { PROMPT_VERSION } from "./prompt.js";
import { ExtractionOutput, SCHEMA_VERSION } from "./schema.js";
import { componentValues } from "./versions.js";

/**
 * A connection or timeout failure after this long is the request's own fault (a runaway generation), not an
 * outage: Node's fetch gives up waiting for response headers after about 5 minutes, whatever the client timeout.
 * Such a failure is reported as STREAM_DEADLINE_ERROR, which the pipeline parks after a few repeats.
 */
export const DEADLINE_AFTER_MS = 270_000;

/** Input-too-long markers in provider error messages (matched only; the message is never kept). */
export const PROMPT_TOO_LONG =
  /prompt is too long|too many (input )?tokens|context (window|length)|maximum context length|exceeds? the (maximum|context)|token count .{0,40}exceeds/i;

export interface ClassifiedError {
  errorClass: ExtractorErrorClass;
  /** Status, code and type only. Never a provider message: some echo part of the key, or the mail. */
  error: string;
  retryAfterSec: number | null;
}

/** A provider code or type, kept only when it looks like an identifier (never free text). */
export function safeTag(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(v) ? v : null;
}

/** Retry-After (seconds or an HTTP date) or retry-after-ms, else the fallback. */
export function retryAfterFrom(headers: Headers | null | undefined, fallbackSec: number): number {
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

/** The wait a response's headers ask for, in ms: retry-after-ms, or Retry-After (seconds or an HTTP date). */
export function headerRetryMs(headers: Headers | null | undefined): number | null {
  const ms = headers?.get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const raw = headers?.get("retry-after");
  if (raw) {
    if (Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw) * 1000;
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  return null;
}

/** One attempt of a provider call: the response, or a classified failure with the wait the server asked for. */
export type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; error: ClassifiedError; waitMs: number | null };

/** Longest server-requested wait honoured inside one call; a longer one goes back to the pipeline as retryAfterSec. */
export const MAX_INLINE_WAIT_MS = 60_000;
/** Backoff without a server-requested wait, as the provider SDKs do: 0.5 s doubling, at most 8 s, jittered. */
const backoffMs = (attempt: number): number => Math.min(500 * 2 ** attempt, 8_000) * (1 - Math.random() * 0.25);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` with up to `maxRetries` quick retries of TRANSIENT failures. Never retried: a deadline (the
 * message's own fault, and another long wait), a wait the server wants longer than {@link MAX_INLINE_WAIT_MS}, or a
 * GLOBAL / PER_MESSAGE failure. `attempt` gets the start of the first try, so the deadline counts the whole call.
 * The SDKs' own retries stay off: they would retry a timed-out generation too, (maxRetries + 1) × the timeout.
 */
export async function withQuickRetries<T>(maxRetries: number, attempt: (callStarted: number) => Promise<AttemptOutcome<T>>): Promise<AttemptOutcome<T>> {
  const callStarted = performance.now();
  for (let n = 0; ; n++) {
    const out = await attempt(callStarted);
    if (out.ok || out.error.errorClass !== "TRANSIENT" || out.error.error === STREAM_DEADLINE_ERROR || n >= maxRetries) return out;
    const wait = out.waitMs ?? backoffMs(n);
    if (wait > MAX_INLINE_WAIT_MS) return out;
    await sleep(wait);
  }
}

const NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);

/** fetch's network failures: TypeError("fetch failed") with the socket error as `cause`, or a socket error itself. */
export function isNetworkError(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === "object" && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"))) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return err instanceof TypeError && /fetch failed|network|terminated|socket/i.test(err.message);
}

/** True for an AbortError / TimeoutError (an AbortSignal fired). */
export function isAbortError(err: unknown): boolean {
  const name = err && typeof err === "object" ? (err as { name?: unknown }).name : undefined;
  return name === "AbortError" || name === "TimeoutError";
}

export type ParseOutcome = { ok: true; output: ExtractionOutput } | { ok: false; error: string };

/** A model's JSON text against the extraction schema (the same checks as claude.ts parseExtraction). */
export function parseExtractionText(raw: string | null | undefined): ParseOutcome {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, error: "no_text" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  const parsed = ExtractionOutput.safeParse(json);
  if (parsed.success) return { ok: true, output: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}:${i.code}`)
    .join(",");
  return { ok: false, error: `schema_invalid:${issues}` };
}

/** prompt | schema | provider:model | component versions (Claude's own format is in claude.ts). */
export function providerPipelineVersion(provider: string, model: string, componentVersions: Record<string, string>): string {
  return [PROMPT_VERSION, SCHEMA_VERSION, `${provider}:${model}`, ...componentValues(componentVersions)].join("|");
}

/** Round to 1e-8 $ (sums are stored as REAL). */
export const roundUsd = (usd: number): number => Math.round(usd * 1e8) / 1e8;
