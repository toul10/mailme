/**
 * The chat's model: one call in, one JSON text out (src/chat/engine.ts runs the rounds). Gemini in production
 * (src/chat/gemini.ts), a keyword mock for development and tests (src/chat/mock.ts).
 */
import type { Config } from "../config.js";
import type { AiUsage } from "../domain/types.js";
import { createGeminiChatModel } from "./gemini.js";
import { createMockChatModel } from "./mock.js";

export interface ChatModelCall {
  system: string;
  user: string;
  /** JSON schema of the reply (src/chat/prompt.ts chatStepSchema). */
  schema: Record<string, unknown>;
  /** Fires when the reader went away or the question's time is up: the call is dropped, not retried. */
  signal?: AbortSignal;
}

/**
 * Why a call gave no text. aborted: the signal fired; no_credit: the provider's prepaid balance is empty;
 * unavailable: rate limit, outage or timeout; config: the key, the model id or the request itself is refused;
 * blocked: the provider's own content filter; too_long: the input did not fit; bad_output: no usable text.
 */
export type ChatFailure = "aborted" | "no_credit" | "unavailable" | "config" | "blocked" | "too_long" | "bad_output";

export type ChatModelResult =
  | { ok: true; text: string; model: string; usage: AiUsage; costUsd: number; latencyMs: number }
  | {
      ok: false;
      kind: ChatFailure;
      /** Status, code and type only. Never a provider message (some echo part of the key, or the input). */
      error: string;
      model: string | null;
      usage: AiUsage | null;
      costUsd: number;
      latencyMs: number;
    };

export interface ChatModel {
  /** "gemini" | "mock" */
  name: string;
  /** Provider and model for the usage log, e.g. "gemini:gemini-3.8-flash@low". */
  id: string;
  complete(call: ChatModelCall): Promise<ChatModelResult>;
}

/** CHAT_MODE=gemini without its key or model: a configuration mistake, reported when the API starts. */
export class ChatConfigError extends Error {}

/**
 * The environment variable that holds the chat's Gemini API key. The API process reads it, and it is the only AI
 * key that process ever holds: the keys of Admin → AI are sealed for the worker, and the worker's own environment
 * keys (GEMINI_API_KEY and the others) are not given to the API. Like those, it never passes through the config.
 */
export const CHAT_KEY_ENV = "CHAT_API_KEY";

/** One call may take this long; the whole question has its own deadline (src/server/routes/chat.ts). */
const CALL_TIMEOUT_MS = 60_000;

/** The chat model of this process, or null when the chat is off (CHAT_MODE=off, the default). */
export function createChatModel(config: Config, env: NodeJS.ProcessEnv = process.env): ChatModel | null {
  if (config.CHAT_MODE === "off") return null;
  if (config.CHAT_MODE === "mock") return createMockChatModel();
  const apiKey = env[CHAT_KEY_ENV]?.trim();
  if (!apiKey) throw new ChatConfigError(`CHAT_MODE=gemini needs ${CHAT_KEY_ENV} (a Gemini API key, in the API's environment)`);
  if (!config.CHAT_MODEL) throw new ChatConfigError("CHAT_MODE=gemini needs CHAT_MODEL (a model id such as gemini-3.8-flash)");
  return createGeminiChatModel({
    apiKey,
    model: config.CHAT_MODEL,
    thinkingLevel: config.CHAT_THINKING_LEVEL ?? null,
    maxTokens: config.CHAT_MAX_TOKENS,
    timeoutMs: CALL_TIMEOUT_MS,
    maxRetries: 1,
  });
}
