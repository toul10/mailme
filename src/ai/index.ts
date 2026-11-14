import type { Config } from "../config.js";
import type { Extractor } from "../domain/types.js";
import { createClaudeExtractor } from "./claude.js";
import { createMockExtractor } from "./mock.js";
import { withMailRules } from "./rules-extractor.js";
import { COMPONENT_VERSIONS } from "./versions.js";

/** Component versions that together form pipelineVersion. */
export { COMPONENT_VERSIONS };

export { createClaudeExtractor, type ClaudeExtractorConfig } from "./claude.js";
export { createMockExtractor } from "./mock.js";
export { forwardDecision, withMailRules } from "./rules-extractor.js";
export { estimateCostUsd, PRICING } from "./pricing.js";
export { PROMPT_VERSION, renderUserPrompt, SYSTEM_PROMPT } from "./prompt.js";

/**
 * The extractor for this process: the mock in AI_MODE=mock, else Claude with the AI_* settings, behind the owners'
 * forward rules (src/ai/rules-extractor.ts; a no-op for owners without rules).
 */
export function createExtractor(config: Config): Extractor {
  if (config.AI_MODE === "mock") return withMailRules(createMockExtractor());
  return withMailRules(createClaudeExtractor({
    model: config.AI_MODEL,
    effort: config.AI_EFFORT,
    fallbacks: config.AI_FALLBACKS,
    cacheTtl: config.AI_CACHE_TTL,
    maxTokens: config.AI_MAX_TOKENS,
    timeoutMs: config.AI_TIMEOUT_MS,
    maxRetries: config.AI_MAX_RETRIES,
    strictEnums: config.AI_STRICT_ENUMS,
    componentVersions: COMPONENT_VERSIONS,
  }));
}
