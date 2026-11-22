/**
 * The chat on Gemini: the same REST request as the extractor (src/ai/gemini.ts) — one instruction, one user content,
 * JSON output against a schema — so the key, the endpoint, the error classes and the price table are shared. Not a
 * multi-turn conversation and no function calling: every round is a fresh call that holds the whole exchange
 * (src/chat/prompt.ts), which keeps the request inside what the extraction already proves on every release.
 */
import { MAX_INLINE_WAIT_MS, roundUsd, safeTag, withQuickRetries, type AttemptOutcome, type ClassifiedError } from "../ai/adapter-common.js";
import { MAX_OUTPUT_TOKENS } from "../ai/claude.js";
import { candidateText, geminiGenerate, geminiUsage, type GeminiCallConfig, type GeminiResponse, type GeminiThinkingLevel } from "../ai/gemini.js";
import { addUsage, geminiCostUsd, ZERO_USAGE } from "../ai/pricing.js";
import type { AiUsage } from "../domain/types.js";
import type { ChatFailure, ChatModel, ChatModelCall, ChatModelResult } from "./model.js";

export interface GeminiChatConfig {
  apiKey: string;
  model: string;
  /** Unset: the model's own default. Thinking is billed as output and counts against maxTokens. */
  thinkingLevel?: GeminiThinkingLevel | null;
  maxTokens: number;
  /** One request. */
  timeoutMs: number;
  /** Quick retries of a transient failure inside one call. */
  maxRetries: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

const ABORTED: ClassifiedError = { errorClass: "PER_MESSAGE", error: "aborted", retryAfterSec: null };
/**
 * Characters per token assumed for a request that was sent and never answered (the reader stopped it, or it timed
 * out): nobody says what it cost, and the provider may bill it. Low on purpose (Greek text is nearer three), so the
 * day's limit errs on the side of counting too much.
 */
const UNANSWERED_CHARS_PER_TOKEN = 2;
/** The longest wait a server may ask for that is still waited out: somebody is watching the screen. */
export const MAX_CHAT_WAIT_MS = 6_000;

/** An adapter error → why the chat has no text (the tag itself goes to the log, never to the user). */
export function chatFailureOf(e: ClassifiedError): ChatFailure {
  if (e.error === "aborted") return "aborted";
  if (/^http_402\b/.test(e.error)) return "no_credit";
  if (e.errorClass === "TRANSIENT") return "unavailable";
  if (/prompt_too_long$|^http_413\b/.test(e.error)) return "too_long";
  return "config";
}

export function createGeminiChatModel(cfg: GeminiChatConfig): ChatModel {
  const thinkingLevel = cfg.thinkingLevel ?? null;
  const call: GeminiCallConfig = { apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) };

  async function complete(input: ChatModelCall): Promise<ChatModelResult> {
    const started = performance.now();
    let usage: AiUsage = ZERO_USAGE;
    let billed = false;
    let costUsd = 0;
    let model: string | null = null;
    let maxTokens = cfg.maxTokens;
    let bumped = false;
    // Requests that left and brought no reply back. Their input is counted at the model's price as an estimate:
    // without it, "ask, stop, ask again" would spend outside the day's limit (src/chat/usage.ts).
    let unanswered = 0;
    const estimate = (): number => (unanswered ? roundUsd(unanswered * geminiCostUsd(cfg.model, { ...ZERO_USAGE, inputTokens: Math.ceil((input.system.length + input.user.length) / UNANSWERED_CHARS_PER_TOKEN) })) : 0);

    const fail = (kind: ChatFailure, error: string): ChatModelResult => ({ ok: false, kind, error, model, usage: billed ? usage : null, costUsd: roundUsd(costUsd + estimate()), latencyMs: Math.round(performance.now() - started) });

    // At most two requests: the first, and one with more room when the answer did not fit.
    for (;;) {
      const payload = JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents: [{ role: "user", parts: [{ text: input.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: input.schema,
          maxOutputTokens: maxTokens,
          ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
        },
      });
      const out = await withQuickRetries(cfg.maxRetries, async (callStarted): Promise<AttemptOutcome<GeminiResponse>> => {
        if (input.signal?.aborted) return { ok: false, error: ABORTED, waitMs: null };
        const r = await geminiGenerate(call, payload, callStarted, input.signal);
        if (r.ok) return r;
        // No HTTP status: the request went out and nothing came back (stopped, timed out, connection lost).
        if (!/^http_\d/.test(r.error.error)) unanswered++;
        // A reader who went away is not an outage: reported as such and never retried.
        if (input.signal?.aborted) return { ok: false, error: ABORTED, waitMs: null };
        // A longer wait than a person sits through goes back as the failure it is (withQuickRetries: not retried).
        return r.waitMs !== null && r.waitMs > MAX_CHAT_WAIT_MS ? { ...r, waitMs: MAX_INLINE_WAIT_MS + 1 } : r;
      });
      if (!out.ok) return fail(chatFailureOf(out.error), out.error.error);
      const res = out.value;
      if (res.usageMetadata) {
        billed = true;
        const u = geminiUsage(res.usageMetadata);
        usage = addUsage(usage, u);
        costUsd = roundUsd(costUsd + geminiCostUsd(cfg.model, u));
      }
      model = typeof res.modelVersion === "string" && res.modelVersion ? res.modelVersion : cfg.model;

      const blocked = res.promptFeedback?.blockReason;
      if (blocked !== undefined && blocked !== null && blocked !== "BLOCK_REASON_UNSPECIFIED") return fail("blocked", `blocked:${safeTag(blocked) ?? "OTHER"}`);
      const candidate = Array.isArray(res.candidates) ? res.candidates[0] : undefined;
      if (!candidate) return fail("bad_output", "no_candidate");
      const finish = candidate.finishReason === undefined || candidate.finishReason === null ? null : (safeTag(candidate.finishReason) ?? "OTHER");
      if (finish === "MAX_TOKENS") {
        if (!bumped && maxTokens < MAX_OUTPUT_TOKENS) {
          bumped = true;
          maxTokens = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS);
          continue;
        }
        return fail("bad_output", "max_tokens");
      }
      if (finish !== null && finish !== "STOP") return fail(finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST" ? "blocked" : "bad_output", `finish:${finish}`);
      const text = candidateText(candidate.content?.parts);
      if (!text.trim()) return fail("bad_output", "no_text");
      return { ok: true, text, model: model ?? cfg.model, usage, costUsd: roundUsd(costUsd + estimate()), latencyMs: Math.round(performance.now() - started) };
    }
  }

  return { name: "gemini", id: `gemini:${cfg.model}${thinkingLevel ? `@${thinkingLevel}` : ""}`, complete };
}
