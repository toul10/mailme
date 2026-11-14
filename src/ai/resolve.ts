import { AI_PROVIDERS, isAiProvider, type AiProvider } from "./providers.js";

/**
 * Which extractor runs: a pure decision from AI_MODE, the worker's environment keys, the choice saved in
 * Admin → AI and the stored keys.
 *
 * 1. AI_MODE=mock → the mock (the kill switch, whatever was chosen).
 * 2. Chosen "mock" (Off in Admin) → the mock.
 * 3. A chosen provider → its key from the environment if set (it wins), else the stored one. No usable key, or no
 *    model → unavailable: AI pauses until it is fixed. Never the mock instead: what the mock makes of real mail is
 *    kept for good (a later fix does not analyse those messages again).
 * 4. Nothing chosen yet → Claude with AI_MODEL when ANTHROPIC_API_KEY is set (an environment-only install).
 *    Without it: the free mock with AI_MODE=auto (a fresh install, the demo); unavailable with AI_MODE=claude, which
 *    asked for Claude (older versions failed there too, at the first call).
 */

export type AiMockReason = "ai_mode_mock" | "off" | "no_key";
export type AiUnavailableReason = "no_key" | "key_unreadable" | "no_model";

export type ResolvedAi =
  | { kind: "mock"; reason: AiMockReason; provider: null }
  | { kind: "unavailable"; reason: AiUnavailableReason; provider: AiProvider }
  | { kind: "provider"; provider: AiProvider; model: string; source: "env" | "stored"; apiKey: string };

/** How an unavailable extractor's GLOBAL error starts (src/ai/unavailable.ts); the worker lifts that pause itself. */
export const AI_UNAVAILABLE_ERROR_PREFIX = "ai_unavailable:";

export interface ResolveAiInput {
  aiMode: "auto" | "claude" | "mock";
  /** AI_MODEL: Claude's model when nothing is chosen yet. */
  defaultModel: string;
  /** Non-empty keys from the worker's environment. */
  envKeys: Partial<Record<AiProvider, string>>;
  /** The saved choice (ai_settings); null or provider null: never chosen. */
  selection: { provider: string | null; model: string | null } | null;
  /** Opens a stored key; null when none is stored. Throws when it cannot be opened (wrong private key). */
  storedKey: (provider: AiProvider) => string | null;
}

export function resolveAi(i: ResolveAiInput): ResolvedAi {
  if (i.aiMode === "mock") return { kind: "mock", reason: "ai_mode_mock", provider: null };
  const chosen = i.selection?.provider ?? null;
  if (chosen === "mock") return { kind: "mock", reason: "off", provider: null };

  if (isAiProvider(chosen)) {
    const model = i.selection?.model?.trim() || (chosen === "anthropic" ? i.defaultModel : "");
    if (!model) return { kind: "unavailable", reason: "no_model", provider: chosen };
    const env = i.envKeys[chosen];
    if (env) return { kind: "provider", provider: chosen, model, source: "env", apiKey: env };
    let stored: string | null;
    try {
      stored = i.storedKey(chosen);
    } catch {
      return { kind: "unavailable", reason: "key_unreadable", provider: chosen };
    }
    if (stored) return { kind: "provider", provider: chosen, model, source: "stored", apiKey: stored };
    return { kind: "unavailable", reason: "no_key", provider: chosen };
  }

  const env = i.envKeys.anthropic;
  if (env) return { kind: "provider", provider: "anthropic", model: i.defaultModel, source: "env", apiKey: env };
  if (i.aiMode === "claude") return { kind: "unavailable", reason: "no_key", provider: "anthropic" };
  return { kind: "mock", reason: "no_key", provider: null };
}

/** The worker's environment keys (trimmed, empty ones dropped). */
export function envKeysFrom(env: NodeJS.ProcessEnv, names: Record<AiProvider, string>): Partial<Record<AiProvider, string>> {
  const out: Partial<Record<AiProvider, string>> = {};
  for (const p of AI_PROVIDERS) {
    const v = env[names[p]]?.trim();
    if (v) out[p] = v;
  }
  return out;
}

export interface AiDescription {
  mode: "provider" | "mock" | "unavailable";
  provider: AiProvider | null;
  model: string | null;
  source: "env" | "stored" | null;
  /** The mock's reason (AiMockReason) or why the chosen provider cannot run (AiUnavailableReason). */
  reason: string | null;
}

/** The resolution without the key, for logs, reports and the CLI. */
export function describeAi(r: ResolvedAi): AiDescription {
  switch (r.kind) {
    case "mock":
      return { mode: "mock", provider: null, model: null, source: null, reason: r.reason };
    case "unavailable":
      return { mode: "unavailable", provider: r.provider, model: null, source: null, reason: r.reason };
    case "provider":
      return { mode: "provider", provider: r.provider, model: r.model, source: r.source, reason: null };
  }
}
