import type { Extractor } from "../domain/types.js";
import type { AiProvider } from "./providers.js";
import { AI_UNAVAILABLE_ERROR_PREFIX, type AiUnavailableReason } from "./resolve.js";

/**
 * The extractor while the provider chosen in Admin → AI cannot run (no usable key, no model: src/ai/resolve.ts).
 * Every call is a GLOBAL error, so the pipeline pauses AI for every mailbox without consuming the message: it waits
 * for the real provider instead of getting the mock's rough result for good. No provider is called. The error is an
 * internal code ("ai_unavailable:<reason>:<provider>"); the worker lifts this pause itself once AI can run again.
 */
export function createUnavailableExtractor(provider: AiProvider, reason: AiUnavailableReason): Extractor {
  const error = `${AI_UNAVAILABLE_ERROR_PREFIX}${reason}:${provider}`;
  return {
    name: "unavailable",
    pipelineVersion: `unavailable|${provider}|${reason}`,
    async extract() {
      return { ok: false, errorClass: "GLOBAL", error, retryAfterSec: null, model: null, stopReason: null, usage: null, costUsd: 0, latencyMs: 0, request: null };
    },
  };
}
