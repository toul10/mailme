import type { Config } from "../config.js";
import type { Extractor } from "../domain/types.js";
import { createClaudeExtractor } from "./claude.js";
import { createGeminiExtractor } from "./gemini.js";
import { createMockExtractor } from "./mock.js";
import { createOpenAiCompatExtractor } from "./openai-compat.js";
import { AI_KEY_ENV } from "./providers.js";
import { envKeysFrom, resolveAi, type ResolvedAi } from "./resolve.js";
import { withMailRules } from "./rules-extractor.js";
import { createUnavailableExtractor } from "./unavailable.js";
import { COMPONENT_VERSIONS } from "./versions.js";

/**
 * The OpenAI, Grok and Gemini calls are not streamed: one deadline for the whole call. Node's fetch stops waiting for
 * response headers after about 300 s anyway; a call that fails after 270 s counts as a runaway generation
 * (src/ai/adapter-common.ts), which the pipeline parks after a few repeats instead of retrying it for ever.
 */
const UNSTREAMED_TIMEOUT_MS = 300_000;

/** Component versions that together form pipelineVersion. */
export { COMPONENT_VERSIONS };

export { createClaudeExtractor, type ClaudeExtractorConfig } from "./claude.js";
export { createMockExtractor } from "./mock.js";
export { forwardDecision, withMailRules } from "./rules-extractor.js";
export { estimateCostUsd, PRICING } from "./pricing.js";
export { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "./prompt.js";

/**
 * Before the worker has read Admin → AI (CLI commands that never call refreshAi): AI_MODE and the environment
 * alone, i.e. Claude with ANTHROPIC_API_KEY, else the mock.
 */
export function resolveFromEnv(config: Config, env: NodeJS.ProcessEnv = process.env): ResolvedAi {
  return resolveAi({ aiMode: config.AI_MODE, defaultModel: config.AI_MODEL, envKeys: envKeysFrom(env, AI_KEY_ENV), selection: null, storedKey: () => null });
}

/**
 * The extractor for a resolution (src/ai/resolve.ts): the mock, the paused "unavailable" one, or the provider's
 * adapter with the AI_* settings, behind the owners' forward rules (src/ai/rules-extractor.ts; a no-op for owners
 * without rules).
 */
export function createExtractor(config: Config, ai: ResolvedAi = resolveFromEnv(config)): Extractor {
  if (ai.kind === "mock") return withMailRules(createMockExtractor());
  if (ai.kind === "unavailable") return withMailRules(createUnavailableExtractor(ai.provider, ai.reason));
  switch (ai.provider) {
    case "anthropic":
      return withMailRules(
        createClaudeExtractor({
          model: ai.model,
          effort: config.AI_EFFORT,
          fallbacks: config.AI_FALLBACKS,
          cacheTtl: config.AI_CACHE_TTL,
          maxTokens: config.AI_MAX_TOKENS,
          timeoutMs: config.AI_TIMEOUT_MS,
          maxRetries: config.AI_MAX_RETRIES,
          strictEnums: config.AI_STRICT_ENUMS,
          componentVersions: COMPONENT_VERSIONS,
          apiKey: ai.apiKey,
        }),
      );
    case "openai":
    case "xai":
      return withMailRules(
        createOpenAiCompatExtractor({
          provider: ai.provider,
          apiKey: ai.apiKey,
          model: ai.model,
          maxTokens: config.AI_MAX_TOKENS,
          timeoutMs: UNSTREAMED_TIMEOUT_MS,
          maxRetries: config.AI_MAX_RETRIES,
          componentVersions: COMPONENT_VERSIONS,
        }),
      );
    case "gemini":
      return withMailRules(
        createGeminiExtractor({
          apiKey: ai.apiKey,
          model: ai.model,
          maxTokens: config.AI_MAX_TOKENS,
          timeoutMs: UNSTREAMED_TIMEOUT_MS,
          maxRetries: config.AI_MAX_RETRIES,
          componentVersions: COMPONENT_VERSIONS,
        }),
      );
  }
}
