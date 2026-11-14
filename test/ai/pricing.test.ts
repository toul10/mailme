import { describe, expect, it } from "vitest";
import { addUsage, estimateCostUsd, estimateCostUsdSplit, PRICING, pricingFor, ZERO_USAGE } from "../../src/ai/pricing.js";

const M = 1_000_000;
const only = (k: "inputTokens" | "outputTokens" | "cacheCreationInputTokens" | "cacheReadInputTokens", n = M) => ({ ...ZERO_USAGE, [k]: n });

describe("pricing", () => {
  it("prices Opus 5 per MTok: input $5, output $25, cache read $0.50, writes $6.25 (5m) / $10 (1h)", () => {
    expect(estimateCostUsd("claude-opus-5", only("inputTokens"))).toBe(5);
    expect(estimateCostUsd("claude-opus-5", only("outputTokens"))).toBe(25);
    expect(estimateCostUsd("claude-opus-5", only("cacheReadInputTokens"))).toBe(0.5);
    expect(estimateCostUsd("claude-opus-5", only("cacheCreationInputTokens"), "5m")).toBe(6.25);
    expect(estimateCostUsd("claude-opus-5", only("cacheCreationInputTokens"), "1h")).toBe(10);
  });

  it("defaults the cache-write TTL to 1h", () => {
    expect(estimateCostUsd("claude-opus-5", only("cacheCreationInputTokens"))).toBe(10);
  });

  it.each([
    // model, input, output, cacheRead, write5m, write1h
    ["claude-opus-5-5", 4, 20, 0.2, 5, 8],
    ["claude-sonnet-5", 2, 10, 0.2, 2.5, 4],
    ["claude-haiku-4-5", 1, 5, 0.1, 1.25, 2],
    ["claude-opus-4-8", 5, 25, 0.5, 6.25, 10],
  ])("prices %s", (model, input, output, read, w5, w1) => {
    expect(estimateCostUsd(model, only("inputTokens"))).toBe(input);
    expect(estimateCostUsd(model, only("outputTokens"))).toBe(output);
    expect(estimateCostUsd(model, only("cacheReadInputTokens"))).toBe(read);
    expect(estimateCostUsd(model, only("cacheCreationInputTokens"), "5m")).toBe(w5);
    expect(estimateCostUsd(model, only("cacheCreationInputTokens"), "1h")).toBe(w1);
  });

  it("uses Opus 5 rates for an unknown model", () => {
    expect(pricingFor("claude-unknown-9")).toEqual(PRICING["claude-opus-5"]);
    expect(pricingFor(null)).toEqual(PRICING["claude-opus-5"]);
    expect(estimateCostUsd("gpt-whatever", only("outputTokens"))).toBe(25);
  });

  it("matches dated snapshot ids by prefix", () => {
    expect(pricingFor("claude-haiku-4-5-20251001")).toEqual(PRICING["claude-haiku-4-5"]);
    // "claude-opus-5-5" must not be priced as its prefix "claude-opus-5".
    expect(pricingFor("claude-opus-5-5")).toEqual(PRICING["claude-opus-5-5"]);
    expect(pricingFor("claude-opus-5-5-20261001")).toEqual(PRICING["claude-opus-5-5"]);
  });

  it("sums a realistic call (Opus 5, cached system prompt)", () => {
    const usage = { inputTokens: 3_000, outputTokens: 1_200, cacheCreationInputTokens: 0, cacheReadInputTokens: 12_000 };
    // 3000·5 + 1200·25 + 12000·0.5 = 15000 + 30000 + 6000 = 51000 µ$ → $0.051
    expect(estimateCostUsd("claude-opus-5", usage)).toBeCloseTo(0.051, 10);
  });

  it("prices an explicit 5m/1h cache-write split", () => {
    const usage = { ...ZERO_USAGE, cacheCreationInputTokens: 2 * M };
    expect(estimateCostUsdSplit("claude-opus-5", usage, { write5m: M, write1h: M })).toBe(16.25);
  });

  it("adds usages field by field", () => {
    const a = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 };
    expect(addUsage(a, a)).toEqual({ inputTokens: 2, outputTokens: 4, cacheCreationInputTokens: 6, cacheReadInputTokens: 8 });
  });
});
