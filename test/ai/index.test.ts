import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { COMPONENT_VERSIONS, createExtractor, PRICING, PROMPT_VERSION, SYSTEM_PROMPT } from "../../src/ai/index.js";
import { SCHEMA_VERSION } from "../../src/ai/schema.js";

const baseEnv = { MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), APP_SECRET: "test-secret-test-secret-test-secret-1234" };

describe("createExtractor", () => {
  it("returns the mock extractor in AI_MODE=mock", () => {
    const ex = createExtractor(loadConfig({ ...baseEnv, AI_MODE: "mock" }));
    expect(ex.name).toBe("mock");
    expect(ex.pipelineVersion.startsWith(`${PROMPT_VERSION}|${SCHEMA_VERSION}|mock|`)).toBe(true);
  });

  it("returns the Claude extractor with the AI_* settings folded into pipelineVersion, without any network call", () => {
    const ex = createExtractor(loadConfig({ ...baseEnv, AI_MODE: "claude", AI_MODEL: "claude-opus-5-5", AI_EFFORT: "medium" }));
    expect(ex.name).toBe("claude");
    expect(ex.pipelineVersion).toBe(`${PROMPT_VERSION}|${SCHEMA_VERSION}|claude-opus-5-5|medium|${COMPONENT_VERSIONS.cleaner}|${COMPONENT_VERSIONS.resolver}`);
    const strict = createExtractor(loadConfig({ ...baseEnv, AI_MODE: "claude", AI_STRICT_ENUMS: "true" }));
    expect(strict.pipelineVersion).not.toBe(createExtractor(loadConfig({ ...baseEnv, AI_MODE: "claude" })).pipelineVersion);
  });

  it("re-exports the package surface", () => {
    expect(COMPONENT_VERSIONS).toEqual({ cleaner: "c1", resolver: "r2" });
    expect(PRICING["claude-opus-5"]?.input).toBe(5);
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
