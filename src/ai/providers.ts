/**
 * The AI providers MailMe can extract with, and the contracts their adapters implement.
 *
 * One provider and model is active per installation, chosen by a platform admin in Admin → AI (or, before any
 * choice, Claude when the worker's environment has ANTHROPIC_API_KEY). Keys typed in the UI are sealed with the
 * credentials public key: the API can store them but never open them; only the worker can.
 */

export const AI_PROVIDERS = ["anthropic", "openai", "gemini", "xai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const isAiProvider = (v: unknown): v is AiProvider => typeof v === "string" && (AI_PROVIDERS as readonly string[]).includes(v);

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "OpenAI",
  gemini: "Gemini (Google)",
  xai: "Grok (xAI)",
};

/** Environment variable with each provider's key. Read by the worker only (compose blanks them for the API). */
export const AI_KEY_ENV: Record<AiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
};

/** Where an admin creates a key (shown next to the key field). */
export const AI_KEY_URLS: Record<AiProvider, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai",
};

/** One model a key can use, for the model picker. */
export interface AiModelOption {
  id: string;
  label: string;
}

/**
 * A model id typed for a provider whose list is not loaded yet (an environment key the worker has not listed).
 * Listed ids are accepted as they come.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** Longest key accepted from the UI (real keys are 40–200 characters). */
export const MAX_API_KEY_LENGTH = 512;

/** Last four characters of a key, the only part ever shown or logged. */
export function keyLast4(key: string): string {
  return key.trim().slice(-4);
}

// ── Model listing (free provider calls; they also validate the key) ─────────

export type ModelListErrorCode = "key_rejected" | "forbidden" | "rate_limited" | "unreachable" | "provider_error";

/**
 * A failed listing. Carries only a code and the HTTP status: the provider's own message is never kept, because
 * some providers echo part of the key in it.
 */
export class ModelListError extends Error {
  constructor(
    readonly code: ModelListErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "ModelListError";
  }
}

export interface ModelListOptions {
  /** Whole listing, all pages. */
  timeoutMs: number;
  /** Injected for tests (Gemini's REST calls; the SDK-based listers take `client`). */
  fetch?: typeof fetch;
  /** Injected for tests: a fake SDK client for the provider. */
  client?: unknown;
}

/** Text-generation models the key can use, newest first. Throws {@link ModelListError}. */
export type ModelLister = (provider: AiProvider, apiKey: string, opts?: Partial<ModelListOptions>) => Promise<AiModelOption[]>;

// ── Extractor configs for the non-Claude adapters ──────────────────────────────

/** OpenAI and xAI (Grok) share one adapter: the official OpenAI SDK, with xAI's base URL for Grok. */
export interface OpenAiCompatExtractorConfig {
  provider: "openai" | "xai";
  apiKey: string;
  model: string;
  maxTokens: number;
  /** Whole request (non-streaming). */
  timeoutMs: number;
  maxRetries: number;
  /** Pipeline component versions folded into pipelineVersion. */
  componentVersions: Record<string, string>;
  /** Injected for tests; defaults to new OpenAI({ apiKey, baseURL, ... }). */
  client?: unknown;
}

/** How hard a Gemini model thinks (`generationConfig.thinkingConfig.thinkingLevel`). The allowed levels differ per model. */
export const GEMINI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

/** Gemini through its REST API (generateContent), with the key in the x-goog-api-key header. */
export interface GeminiExtractorConfig {
  apiKey: string;
  model: string;
  /**
   * Unset: nothing is sent and the model thinks at its own default. Thinking tokens are billed as output and count
   * against maxTokens.
   */
  thinkingLevel?: GeminiThinkingLevel | null;
  maxTokens: number;
  /** Whole request: the call is not streamed. */
  timeoutMs: number;
  maxRetries: number;
  /** Pipeline component versions folded into pipelineVersion. */
  componentVersions: Record<string, string>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}
