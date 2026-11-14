/**
 * The models a key can use, per provider: free listing calls that also validate the key. Only text models the
 * extractor can drive are kept (structured JSON output; no image, audio, realtime or embedding models), newest
 * first where the provider gives a date, at most {@link MAX_LISTED_MODELS}.
 *
 * Every failure becomes a {@link ModelListError} (a code and the HTTP status): the provider's message is never kept,
 * because some echo part of the key.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { isAbortError, isNetworkError } from "./adapter-common.js";
import { errorReasons, GEMINI_API_BASE, KEY_REASONS, type GeminiErrorBody } from "./gemini.js";
import { createOpenAiClient } from "./openai-compat.js";
import { MAX_API_KEY_LENGTH, MODEL_ID_RE, ModelListError, type AiModelOption, type AiProvider, type ModelLister, type ModelListOptions } from "./providers.js";

export const MAX_LISTED_MODELS = 200;
export const DEFAULT_LIST_TIMEOUT_MS = 20_000;
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Gemini pages (1000 models each) read at most. */
const GEMINI_MAX_PAGES = 5;
/** Entries read from one provider before filtering (a runaway list stops here). */
const MAX_SCANNED = 5_000;

export const OPENAI_INCLUDE = /^(gpt-|o\d|chatgpt-)/;
export const OPENAI_EXCLUDE = /image|realtime|audio|transcribe|tts|whisper|embedding|moderation|search|dall-e|davinci|babbage|live|computer-use|codex|instruct/;
export const GEMINI_EXCLUDE = /embedding|image|tts|live|native-audio|aqa|imagen|veo|robotics/;

// ── Client seams (the parts of each SDK used; tests pass fakes) ─────────────

type ListOptions = { signal?: AbortSignal };
interface AnthropicModel {
  id?: unknown;
  display_name?: unknown;
  capabilities?: { structured_outputs?: { supported?: unknown } | null } | null;
}
export interface AnthropicModelsClient {
  models: { list(params?: { limit?: number }, options?: ListOptions): AsyncIterable<AnthropicModel> };
}
export interface OpenAiModelsClient {
  models: { list(options?: ListOptions): AsyncIterable<{ id?: unknown; created?: unknown }> };
}
export interface XaiModelsClient {
  get(path: string, options?: ListOptions): PromiseLike<unknown>;
}

// ── Listers ─────────────────────────────────────────────────────────────────

interface Dated {
  id: string;
  label: string;
  created: number;
}

/** Valid, distinct ids, at most {@link MAX_LISTED_MODELS}; the label falls back to the id. */
function toOptions(models: Array<{ id: unknown; label?: unknown }>): AiModelOption[] {
  const out: AiModelOption[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    if (typeof m.id !== "string" || !MODEL_ID_RE.test(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    const label = typeof m.label === "string" && m.label.trim() ? m.label.trim().slice(0, 120) : m.id;
    out.push({ id: m.id, label });
    if (out.length >= MAX_LISTED_MODELS) break;
  }
  return out;
}

const newestFirst = (models: Dated[]): Dated[] => [...models].sort((a, b) => b.created - a.created);
const created = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The listing client: every option explicit, so ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL in the environment never applies. */
export function anthropicListClient(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_BASE_URL, timeout: timeoutMs, maxRetries: 1 });
}

/** Claude: GET /v1/models (newest first already); models without structured outputs are dropped. */
async function listAnthropic(apiKey: string, o: ModelListOptions, signal: AbortSignal): Promise<AiModelOption[]> {
  const client = (o.client as AnthropicModelsClient | undefined) ?? (anthropicListClient(apiKey, o.timeoutMs) as unknown as AnthropicModelsClient);
  const kept: Array<{ id: unknown; label: unknown }> = [];
  let scanned = 0;
  for await (const m of client.models.list({ limit: 1000 }, { signal })) {
    if (++scanned > MAX_SCANNED) break;
    if (m?.capabilities?.structured_outputs?.supported === false) continue;
    kept.push({ id: m?.id, label: m?.display_name });
    if (kept.length >= MAX_LISTED_MODELS) break;
  }
  return toOptions(kept);
}

/** OpenAI: GET /v1/models, chat models only (gpt-*, o*, chatgpt-*), newest first. */
async function listOpenAi(apiKey: string, o: ModelListOptions, signal: AbortSignal): Promise<AiModelOption[]> {
  const client = (o.client as OpenAiModelsClient | undefined) ?? (createOpenAiClient("openai", apiKey, { timeoutMs: o.timeoutMs, maxRetries: 1 }) as unknown as OpenAiModelsClient);
  const kept: Dated[] = [];
  let scanned = 0;
  for await (const m of client.models.list({ signal })) {
    if (++scanned > MAX_SCANNED) break;
    if (typeof m?.id !== "string" || !OPENAI_INCLUDE.test(m.id) || OPENAI_EXCLUDE.test(m.id)) continue;
    kept.push({ id: m.id, label: m.id, created: created(m.created) });
  }
  return toOptions(newestFirst(kept));
}

/** xAI: GET /v1/language-models ({ models }), those with text output, newest first. */
async function listXai(apiKey: string, o: ModelListOptions, signal: AbortSignal): Promise<AiModelOption[]> {
  const client = (o.client as XaiModelsClient | undefined) ?? (createOpenAiClient("xai", apiKey, { timeoutMs: o.timeoutMs, maxRetries: 1 }) as unknown as XaiModelsClient);
  const res = (await client.get("/language-models", { signal })) as { models?: unknown } | null;
  const models = Array.isArray(res?.models) ? (res.models as Array<{ id?: unknown; created?: unknown; output_modalities?: unknown }>) : [];
  const kept: Dated[] = [];
  for (const m of models.slice(0, MAX_SCANNED)) {
    if (typeof m?.id !== "string" || !Array.isArray(m.output_modalities) || !m.output_modalities.includes("text")) continue;
    kept.push({ id: m.id, label: m.id, created: created(m.created) });
  }
  return toOptions(newestFirst(kept));
}

interface GeminiModel {
  name?: unknown;
  displayName?: unknown;
  supportedGenerationMethods?: unknown;
}

/** Gemini: GET /v1beta/models (paged), gemini-* models with generateContent, in the API's order. */
async function listGemini(apiKey: string, o: ModelListOptions, signal: AbortSignal): Promise<AiModelOption[]> {
  const doFetch = o.fetch ?? fetch;
  const kept: Array<{ id: unknown; label: unknown }> = [];
  let pageToken: string | null = null;
  for (let page = 0; page < GEMINI_MAX_PAGES; page++) {
    const url = `${GEMINI_API_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await doFetch(url, { method: "GET", headers: { "x-goog-api-key": apiKey }, signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const body = json && typeof json === "object" ? (json as { models?: unknown; nextPageToken?: unknown } & GeminiErrorBody) : null;
    if (!res.ok) throw fromStatus(res.status, errorReasons(body).some((r) => KEY_REASONS.has(r)) || mentionsKey(body?.error?.message));
    if (!body) throw new ModelListError("provider_error", res.status);
    const models = Array.isArray(body.models) ? (body.models as GeminiModel[]) : [];
    for (const m of models.slice(0, MAX_SCANNED)) {
      const name = typeof m?.name === "string" ? m.name : "";
      const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (!name.startsWith("models/gemini") || !methods.includes("generateContent")) continue;
      const id = name.slice("models/".length);
      if (GEMINI_EXCLUDE.test(id)) continue;
      kept.push({ id, label: m.displayName });
    }
    pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
    if (!pageToken || kept.length >= MAX_LISTED_MODELS) break;
  }
  return toOptions(kept);
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** A 400 about the key (xAI answers a wrong key with 400 "Incorrect API key provided"). Matched only, never kept. */
const mentionsKey = (message: unknown): boolean => typeof message === "string" && /api[ _-]?key/i.test(message);

function fromStatus(status: number | null, keyProblem: boolean): ModelListError {
  if (status === 401 || (status === 400 && keyProblem)) return new ModelListError("key_rejected", status);
  if (status === 403) return new ModelListError("forbidden", status);
  if (status === 429) return new ModelListError("rate_limited", status);
  return new ModelListError("provider_error", status);
}

/** Any failure → a ModelListError carrying no provider text. */
export function toModelListError(err: unknown): ModelListError {
  if (err instanceof ModelListError) return err;
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) return new ModelListError("unreachable");
  if (err instanceof Anthropic.APIUserAbortError || err instanceof OpenAI.APIUserAbortError) return new ModelListError("unreachable");
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    return fromStatus(status, mentionsKey(err.message));
  }
  if (isNetworkError(err) || isAbortError(err)) return new ModelListError("unreachable");
  return new ModelListError("provider_error");
}

// ── Entry point ─────────────────────────────────────────────────────────────

const LISTERS: Record<AiProvider, (apiKey: string, o: ModelListOptions, signal: AbortSignal) => Promise<AiModelOption[]>> = {
  anthropic: listAnthropic,
  openai: listOpenAi,
  gemini: listGemini,
  xai: listXai,
};

/** Text models the key can use, newest first. Throws {@link ModelListError}; never reads a key from the environment. */
export const listModels: ModelLister = async (provider, apiKey, opts = {}) => {
  const lister = Object.hasOwn(LISTERS, provider) ? LISTERS[provider] : undefined;
  if (!lister) throw new ModelListError("provider_error");
  // Printable ASCII only: an empty key would make an SDK fall back to the environment, a newline would split a header.
  if (typeof apiKey !== "string" || apiKey.length > MAX_API_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(apiKey)) throw new ModelListError("key_rejected");

  const o: ModelListOptions = { ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), o.timeoutMs);
  try {
    return await lister(apiKey, o, abort.signal);
  } catch (err) {
    throw abort.signal.aborted ? new ModelListError("unreachable") : toModelListError(err);
  } finally {
    clearTimeout(timer);
  }
};
