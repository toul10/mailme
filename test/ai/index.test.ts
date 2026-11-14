import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { COMPONENT_VERSIONS, createExtractor, PRICING, PROMPT_VERSION, resolveFromEnv, SYSTEM_PROMPT } from "../../src/ai/index.js";
import { SCHEMA_VERSION } from "../../src/ai/schema.js";
import type { ExtractionInput } from "../../src/domain/types.js";

const baseEnv = { MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), APP_SECRET: "test-secret-test-secret-test-secret-1234" };
/** The extractor for these settings with a (fake) ANTHROPIC_API_KEY in the worker's environment. */
const withClaudeKey = (env: Record<string, string>) => {
  const config = loadConfig({ ...baseEnv, ...env });
  return createExtractor(config, resolveFromEnv(config, { ANTHROPIC_API_KEY: "fake-anthropic-key-not-real" }));
};
const withoutKeys = (env: Record<string, string>) => {
  const config = loadConfig({ ...baseEnv, ...env });
  return createExtractor(config, resolveFromEnv(config, {}));
};

describe("createExtractor", () => {
  it("returns the mock extractor in AI_MODE=mock", () => {
    const ex = createExtractor(loadConfig({ ...baseEnv, AI_MODE: "mock" }));
    expect(ex.name).toBe("mock");
    expect(ex.pipelineVersion.startsWith(`${PROMPT_VERSION}|${SCHEMA_VERSION}|mock|`)).toBe(true);
  });

  it("returns the Claude extractor with the AI_* settings folded into pipelineVersion, without any network call", () => {
    const ex = withClaudeKey({ AI_MODEL: "claude-opus-5-5", AI_EFFORT: "medium" });
    expect(ex.name).toBe("claude");
    expect(ex.pipelineVersion).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|claude-opus-5-5|medium|${COMPONENT_VERSIONS.cleaner}|${COMPONENT_VERSIONS.resolver}`);
    const strict = withClaudeKey({ AI_STRICT_ENUMS: "true" });
    expect(strict.pipelineVersion).not.toBe(withClaudeKey({}).pipelineVersion);
  });

  it("without any key: the free mock by default (auto); AI_MODE=claude asked for Claude, so AI is unavailable and pauses", async () => {
    expect(withoutKeys({}).name).toBe("mock");
    expect(withClaudeKey({ AI_MODE: "claude" }).name).toBe("claude");
    const unavailable = withoutKeys({ AI_MODE: "claude" });
    expect(unavailable.name).toBe("unavailable");
    // No provider call: a GLOBAL error the pipeline turns into a pause, without consuming the message.
    const r = await unavailable.extract({ message: { direction: "OUTBOUND" }, rules: null } as unknown as ExtractionInput);
    expect(r).toMatchObject({ ok: false, errorClass: "GLOBAL", error: "ai_unavailable:no_key:anthropic", costUsd: 0 });
  });

  it("re-exports the package surface", () => {
    expect(COMPONENT_VERSIONS).toEqual({ cleaner: "c1", resolver: "r2" });
    expect(PRICING["claude-opus-5"]?.input).toBe(5);
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
