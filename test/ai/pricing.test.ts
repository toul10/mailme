import { describe, expect, it } from "vitest";
import {
  addUsage,
  CEILING_PRICING,
  ceilingCostUsd,
  estimateCostUsd,
  estimateCostUsdSplit,
  GEMINI_PRICING,
  geminiCostUsd,
  geminiPricingFor,
  PRICING,
  pricingFor,
  ZERO_USAGE,
} from "../../src/ai/pricing.js";

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

describe("ceiling pricing (a non-Claude model without a price row)", () => {
  it("is $10 input / $50 output per MTok, cached input at the input rate, cache writes at 1.25× input", () => {
    expect(CEILING_PRICING).toMatchObject({ input: 10, output: 50, cacheRead: 10 });
    expect(ceilingCostUsd(only("inputTokens"))).toBe(10);
    expect(ceilingCostUsd(only("outputTokens"))).toBe(50);
    expect(ceilingCostUsd(only("cacheReadInputTokens"))).toBe(10);
    expect(ceilingCostUsd(only("cacheCreationInputTokens"))).toBe(12.5);
    expect(ceilingCostUsd(ZERO_USAGE)).toBe(0);
  });

  it("never undercounts astra-sized usage: at least $10 input / $50 output per MTok", () => {
    const usage = { inputTokens: 183_421, outputTokens: 9_876, cacheReadInputTokens: 41_000, cacheCreationInputTokens: 0 };
    const atAstraRates = ((usage.inputTokens + usage.cacheReadInputTokens) * 10 + usage.outputTokens * 50) / M;
    expect(ceilingCostUsd(usage)).toBeGreaterThanOrEqual(atAstraRates - 1e-8);
    // pricingFor's Opus 5 fallback ($5/$25) would undercount it: non-Claude cost never goes through it.
    expect(estimateCostUsd("gpt-6-astra", usage)).toBeLessThan(atAstraRates);
  });

  it("is never below a listed Gemini price, nor below pricingFor's Opus fallback", () => {
    for (const row of [...Object.values(GEMINI_PRICING), PRICING["claude-opus-5"]!]) {
      expect(CEILING_PRICING.input).toBeGreaterThanOrEqual(row.input);
      expect(CEILING_PRICING.output).toBeGreaterThanOrEqual(row.output);
      expect(CEILING_PRICING.cacheRead).toBeGreaterThanOrEqual(row.cacheRead);
    }
  });
});

describe("Gemini pricing", () => {
  it.each([
    // model, input, output, cached input — the higher announced price where one is dated
    ["gemini-4-carbon", 4, 20, 0.2],
    ["gemini-4-argon", 4, 20, 0.2],
    ["gemini-4-neon", 3, 15, 0.15],
    ["gemini-4-hydrogen", 1.5, 7.5, 0.075],
    ["gemini-3.8-flash", 1.5, 7.5, 0.15],
    ["gemini-3.6-flash", 1.5, 7.5, 0.15],
    ["gemini-3.5-flash-lite", 0.3, 2.5, 0.03],
  ])("prices %s per MTok", (model, input, output, cached) => {
    expect(geminiCostUsd(model, only("inputTokens"))).toBe(input);
    expect(geminiCostUsd(model, only("outputTokens"))).toBe(output);
    expect(geminiCostUsd(model, only("cacheReadInputTokens"))).toBe(cached);
    // Gemini reports no cache writes; if it ever did, they would cost input.
    expect(geminiCostUsd(model, only("cacheCreationInputTokens"))).toBe(input);
  });

  it("accepts the listed form of an id and ignores case", () => {
    expect(geminiPricingFor("models/gemini-3.6-flash")).toBe(GEMINI_PRICING["gemini-3.6-flash"]);
    expect(geminiPricingFor(" Gemini-4-Hydrogen ")).toBe(GEMINI_PRICING["gemini-4-hydrogen"]);
  });

  it("uses the ceiling for any other id: no prefix guessing, no Opus fallback", () => {
    for (const id of ["gemini-3.6-flash-lite", "gemini-3.6-flash-001", "gemini-flash-latest", "gemini-9-ultra", "constructor", "", null, undefined]) {
      expect(geminiPricingFor(id)).toBe(CEILING_PRICING);
    }
    expect(geminiCostUsd("gemini-9-ultra", only("outputTokens"))).toBe(50);
  });

  it("sums a realistic call (3.6 Flash: 6k prompt, 2k answer and thinking)", () => {
    const usage = { inputTokens: 6_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    // 6000·1.5 + 2000·7.5 = 9000 + 15000 = 24000 µ$ → $0.024
    expect(geminiCostUsd("gemini-3.6-flash", usage)).toBeCloseTo(0.024, 10);
  });
});
