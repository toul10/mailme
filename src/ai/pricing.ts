import type { AiUsage } from "../domain/types.js";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * USD per million tokens. Keep in sync with Anthropic pricing.
 * Cache writes follow the published multipliers (5m = 1.25× input, 1h = 2× input); cache reads are 0.1× input,
 * except Opus 5.5 whose cache reads are 0.05× ($0.20).
 */
export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

/** Rates used for any model not in the table (conservative: the default production model). */
export const DEFAULT_PRICING_MODEL = "claude-opus-5";

/**
 * Pricing row for a model id. Exact match first, then the longest table key the id starts with
 * (dated snapshots such as `claude-haiku-4-5-20251001`), else Opus 5 rates.
 */
export function pricingFor(model: string | null | undefined): ModelPricing {
  const id = (model ?? "").trim().toLowerCase();
  const exact = PRICING[id];
  if (exact) return exact;
  let best: string | null = null;
  for (const key of Object.keys(PRICING)) {
    if (id.startsWith(key + "-") && (best === null || key.length > best.length)) best = key;
  }
  return PRICING[best ?? DEFAULT_PRICING_MODEL]!;
}

const PER_TOKEN = 1 / 1_000_000;

/**
 * Cost of one call. `cacheCreationInputTokens` are billed at the TTL's write rate; when the API reports the
 * 5m/1h split (`usage.cache_creation`), use {@link estimateCostUsdSplit} instead.
 */
export function estimateCostUsd(model: string, usage: AiUsage, cacheTtl: "5m" | "1h" = "1h"): number {
  const split = cacheTtl === "1h" ? { write5m: 0, write1h: usage.cacheCreationInputTokens } : { write5m: usage.cacheCreationInputTokens, write1h: 0 };
  return estimateCostUsdSplit(model, usage, split);
}

/** Cost with an explicit split of cache-creation tokens by TTL. */
export function estimateCostUsdSplit(model: string, usage: AiUsage, cacheWrites: { write5m: number; write1h: number }): number {
  const p = pricingFor(model);
  const usd =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadInputTokens * p.cacheRead +
      cacheWrites.write5m * p.cacheWrite5m +
      cacheWrites.write1h * p.cacheWrite1h) *
    PER_TOKEN;
  // Round to 1e-8 $ so sums stored as REAL stay stable across runs.
  return Math.round(usd * 1e8) / 1e8;
}

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/**
 * Rates for a non-Claude model without a price row of its own (OpenAI; xAI when a response lacks its exact cost; a
 * Gemini model that is not in {@link GEMINI_PRICING}): a deliberate ceiling at or above the dearest published text
 * model (gpt-6-astra: $10 input / $50 output per million tokens on 2026-11-14), so the daily USD cap never
 * undercounts. Cached input is billed at the input rate and cache writes at 1.25× input. Not a price list:
 * providers change prices, the ceiling stays safe. Never use {@link pricingFor} for these models: its Opus fallback
 * is below some of their prices.
 */
export const CEILING_PRICING: ModelPricing = { input: 10, output: 50, cacheRead: 10, cacheWrite5m: 12.5, cacheWrite1h: 12.5 };

/** Cost of one non-Claude call at {@link CEILING_PRICING} (an estimate, deliberately high). */
export function ceilingCostUsd(usage: AiUsage): number {
  return costAt(CEILING_PRICING, usage);
}

/**
 * Gemini Developer API list prices, USD per million tokens (paid tier, standard), read from Google's pricing page
 * (https://ai.google.dev/gemini-api/docs/pricing) on 2026-11-20. Output includes thinking tokens. Where a higher
 * price is already announced the table holds the HIGHER one, so the daily USD cap never undercounts:
 * Gemini 4 Argon and Carbon cost half of this until 2026-11-30, Gemini 3.6 and 3.8 Flash half until 2026-12-31.
 * Gemini has no cache-write charge here (implicit caching only): the write columns repeat the input price.
 */
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  "gemini-4-carbon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 4, cacheWrite1h: 4 },
  "gemini-4-argon": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 4, cacheWrite1h: 4 },
  "gemini-4-neon": { input: 3, output: 15, cacheRead: 0.15, cacheWrite5m: 3, cacheWrite1h: 3 },
  "gemini-4-hydrogen": { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  "gemini-3.8-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  "gemini-3.6-flash": { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite5m: 0.3, cacheWrite1h: 0.3 },
};

/** The price row of a Gemini model id (with or without "models/"), exact match only; else the ceiling. */
export function geminiPricingFor(model: string | null | undefined): ModelPricing {
  const id = (model ?? "").trim().toLowerCase().replace(/^models\//, "");
  return (Object.hasOwn(GEMINI_PRICING, id) ? GEMINI_PRICING[id] : undefined) ?? CEILING_PRICING;
}

/** Cost of one Gemini call: the model's row of {@link GEMINI_PRICING}, or the ceiling for a model that is not there. */
export function geminiCostUsd(model: string, usage: AiUsage): number {
  return costAt(geminiPricingFor(model), usage);
}

function costAt(p: ModelPricing, usage: AiUsage): number {
  const usd =
    (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadInputTokens * p.cacheRead + usage.cacheCreationInputTokens * p.cacheWrite1h) *
    PER_TOKEN;
  return Math.round(usd * 1e8) / 1e8;
}
