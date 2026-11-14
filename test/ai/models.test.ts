import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GEMINI_API_BASE } from "../../src/ai/gemini.js";
import { ANTHROPIC_BASE_URL, anthropicListClient, listModels, MAX_LISTED_MODELS, toModelListError } from "../../src/ai/models.js";
import { MAX_API_KEY_LENGTH, ModelListError, type AiProvider, type ModelListErrorCode } from "../../src/ai/providers.js";

const KEY = "sk-FAKEKEY-0123456789abcdef";

async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function anthropicClient(models: unknown[] | Error) {
  const calls: Array<{ params: unknown; options: { signal?: AbortSignal } | undefined }> = [];
  const client = {
    models: {
      list: (params?: unknown, options?: { signal?: AbortSignal }) => {
        calls.push({ params, options });
        if (models instanceof Error) {
          return (async function* () {
            throw models;
          })();
        }
        return iter(models);
      },
    },
  };
  return { client, calls };
}

function openAiClient(models: unknown[] | Error) {
  return {
    models: {
      list: () =>
        models instanceof Error
          ? (async function* () {
              throw models;
            })()
          : iter(models),
    },
  };
}

function xaiClient(body: unknown) {
  const paths: string[] = [];
  return {
    paths,
    client: {
      get: async (path: string) => {
        paths.push(path);
        if (body instanceof Error) throw body;
        return body;
      },
    },
  };
}

type Step = Response | Error;
function fakeFetch(queue: Step[] | (() => Step)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = typeof queue === "function" ? queue() : queue.shift();
    if (!next) throw new Error("fake queue empty");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const gModel = (id: string, methods = ["generateContent", "countTokens"], displayName = `Label ${id}`) => ({ name: `models/${id}`, displayName, supportedGenerationMethods: methods });

/** Everything a caller could print or store from a ModelListError. */
function exposed(err: unknown): string {
  const e = err as ModelListError;
  return JSON.stringify({ message: e.message, code: e.code, status: e.status, name: e.name, stack: String(e.stack), json: JSON.stringify(e) });
}

async function failure(p: Promise<unknown>): Promise<ModelListError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ModelListError);
    expect(exposed(err)).not.toContain("FAKEKEY");
    return err as ModelListError;
  }
  throw new Error("expected a ModelListError");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("listModels — anthropic", () => {
  it("keeps the API order and display names, drops models without structured outputs", async () => {
    const { client, calls } = anthropicClient([
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", capabilities: { structured_outputs: { supported: true } } },
      { id: "claude-old-3", display_name: "Claude Old", capabilities: { structured_outputs: { supported: false } } },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", capabilities: null },
      { id: "claude-haiku-4-5", display_name: "" },
    ]);
    const models = await listModels("anthropic", KEY, { client });
    expect(models).toEqual([
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ]);
    expect(calls[0]!.params).toEqual({ limit: 1000 });
    expect(calls[0]!.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("builds its client with every option explicit (no ANTHROPIC_* environment variable applies)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token-env");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example");
    const c = anthropicListClient(KEY, 5_000);
    expect(c.apiKey).toBe(KEY);
    expect(c.authToken).toBeNull();
    expect(c.baseURL).toBe(ANTHROPIC_BASE_URL);
    expect(c.maxRetries).toBe(1);
    expect(c.timeout).toBe(5_000);
  });
});

describe("listModels — openai", () => {
  it("keeps chat models only, newest first", async () => {
    const ids: Array<[string, number]> = [
      ["gpt-4o", 200],
      ["gpt-5", 300],
      ["o3", 250],
      ["chatgpt-4o-latest", 100],
      ["gpt-image-1", 400],
      ["gpt-4o-realtime-preview", 400],
      ["gpt-4o-audio-preview", 400],
      ["gpt-4o-mini-transcribe", 400],
      ["gpt-4o-mini-tts", 400],
      ["gpt-4o-search-preview", 400],
      ["gpt-5-codex", 400],
      ["gpt-3.5-turbo-instruct", 400],
      ["o4-mini-deep-research", 400],
      ["computer-use-preview", 400],
      ["dall-e-3", 400],
      ["whisper-1", 400],
      ["text-embedding-3-large", 400],
      ["omni-moderation-latest", 400],
      ["davinci-002", 400],
      ["babbage-002", 400],
    ];
    const client = openAiClient(ids.map(([id, created]) => ({ id, created, object: "model", owned_by: "system" })));
    expect(await listModels("openai", KEY, { client })).toEqual([
      { id: "gpt-5", label: "gpt-5" },
      { id: "o3", label: "o3" },
      { id: "gpt-4o", label: "gpt-4o" },
      { id: "chatgpt-4o-latest", label: "chatgpt-4o-latest" },
    ]);
  });

  it(`returns at most ${MAX_LISTED_MODELS}, the newest, without duplicates or unusable ids`, async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `gpt-x-${i}`, created: i }));
    const client = openAiClient([...many, { id: "gpt-x-299", created: 1 }, { id: "gpt bad id", created: 999 }, { id: 42, created: 999 }]);
    const models = await listModels("openai", KEY, { client });
    expect(models).toHaveLength(MAX_LISTED_MODELS);
    expect(models[0]).toEqual({ id: "gpt-x-299", label: "gpt-x-299" });
    expect(new Set(models.map((m) => m.id)).size).toBe(MAX_LISTED_MODELS);
  });
});

describe("listModels — xai", () => {
  it("reads /language-models and keeps text-output models, newest first", async () => {
    const { client, paths } = xaiClient({
      models: [
        { id: "grok-3", created: 1, input_modalities: ["text"], output_modalities: ["text"] },
        { id: "grok-4", created: 2, input_modalities: ["text", "image"], output_modalities: ["text"] },
        { id: "grok-imagine", created: 3, input_modalities: ["text"], output_modalities: ["image"] },
        { id: "grok-mystery", created: 4 },
      ],
    });
    expect(await listModels("xai", KEY, { client })).toEqual([
      { id: "grok-4", label: "grok-4" },
      { id: "grok-3", label: "grok-3" },
    ]);
    expect(paths).toEqual(["/language-models"]);
  });

  it("an unexpected body is an empty list", async () => {
    expect(await listModels("xai", KEY, { client: xaiClient({ data: [] }).client })).toEqual([]);
  });
});

describe("listModels — gemini", () => {
  it("follows pages, keeps gemini-* generateContent text models, key only in the header", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        models: [
          gModel("gemini-3-pro", undefined, "Gemini 3 Pro"),
          gModel("gemini-embedding-001", ["embedContent"]),
          gModel("gemini-2.5-flash-image"),
          gModel("gemini-2.5-flash-preview-tts"),
          gModel("gemini-live-2.5-flash"),
          gModel("gemini-2.5-flash-native-audio-preview"),
          gModel("gemini-robotics-er-1.5-preview"),
          gModel("gemma-3-27b-it"),
          gModel("imagen-4.0-generate-001", ["predict"]),
          gModel("veo-3.0-generate-001", ["predictLongRunning"]),
          gModel("aqa", ["generateAnswer"]),
          gModel("gemini-count-only", ["countTokens"]),
        ],
        nextPageToken: "page 2/token",
      }),
      json({ models: [gModel("gemini-2.5-flash", undefined, "Gemini 2.5 Flash")] }),
    ]);
    expect(await listModels("gemini", KEY, { fetch })).toEqual([
      { id: "gemini-3-pro", label: "Gemini 3 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ]);
    expect(calls.map((c) => c.url)).toEqual([`${GEMINI_API_BASE}/models?pageSize=1000`, `${GEMINI_API_BASE}/models?pageSize=1000&pageToken=page%202%2Ftoken`]);
    for (const c of calls) {
      expect(c.url).not.toContain("FAKEKEY");
      expect(c.init.headers).toEqual({ "x-goog-api-key": KEY });
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("reads at most 5 pages", async () => {
    const { fetch, calls } = fakeFetch(() => json({ models: [], nextPageToken: "again" }));
    expect(await listModels("gemini", KEY, { fetch })).toEqual([]);
    expect(calls).toHaveLength(5);
  });
});

describe("listModels — errors carry a code and the status only", () => {
  const anthropicErr = (status: number, type: string) => Anthropic.APIError.generate(status, { type: "error", error: { type, message: `rejected ${KEY}` } }, `rejected ${KEY}`, new Headers());
  const openAiErr = (status: number, error: unknown) => OpenAI.APIError.generate(status, { error }, undefined, new Headers());
  const googleErr = (status: number, error: Record<string, unknown>) => json({ error: { ...error, message: `API key not valid ${KEY}` } }, status);

  const cases: Array<[string, AiProvider, () => { client?: unknown; fetch?: typeof fetch }, ModelListErrorCode, number | null]> = [
    ["anthropic 401", "anthropic", () => ({ client: anthropicClient(anthropicErr(401, "authentication_error")).client }), "key_rejected", 401],
    ["anthropic 403", "anthropic", () => ({ client: anthropicClient(anthropicErr(403, "permission_error")).client }), "forbidden", 403],
    ["anthropic 429", "anthropic", () => ({ client: anthropicClient(anthropicErr(429, "rate_limit_error")).client }), "rate_limited", 429],
    ["anthropic 529", "anthropic", () => ({ client: anthropicClient(anthropicErr(529, "overloaded_error")).client }), "provider_error", 529],
    ["anthropic connection", "anthropic", () => ({ client: anthropicClient(new Anthropic.APIConnectionError({ message: `x ${KEY}` })).client }), "unreachable", null],
    ["anthropic timeout", "anthropic", () => ({ client: anthropicClient(new Anthropic.APIConnectionTimeoutError()).client }), "unreachable", null],
    ["openai 401", "openai", () => ({ client: openAiClient(openAiErr(401, { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" })) }), "key_rejected", 401],
    ["openai 404", "openai", () => ({ client: openAiClient(openAiErr(404, { message: "nope", type: "invalid_request_error" })) }), "provider_error", 404],
    ["openai 500", "openai", () => ({ client: openAiClient(openAiErr(500, { message: "oops", type: "server_error" })) }), "provider_error", 500],
    ["openai connection", "openai", () => ({ client: openAiClient(new OpenAI.APIConnectionError({ message: `x ${KEY}` })) }), "unreachable", null],
    ["xai 400 wrong key", "xai", () => ({ client: xaiClient(OpenAI.APIError.generate(400, { code: "Client specified an invalid argument", error: `Incorrect API key provided: ${KEY}` }, undefined, new Headers())).client }), "key_rejected", 400],
    ["xai 400 other", "xai", () => ({ client: xaiClient(OpenAI.APIError.generate(400, { code: "x", error: "Bad request" }, undefined, new Headers())).client }), "provider_error", 400],
    ["xai 403 (no credits)", "xai", () => ({ client: xaiClient(OpenAI.APIError.generate(403, { code: "x", error: "no credits" }, undefined, new Headers())).client }), "forbidden", 403],
    ["xai plain error", "xai", () => ({ client: xaiClient(new Error(`weird ${KEY}`)).client }), "provider_error", null],
    ["gemini 400 API_KEY_INVALID", "gemini", () => fakeFetch([googleErr(400, { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] })]), "key_rejected", 400],
    ["gemini 400 key message only", "gemini", () => fakeFetch([googleErr(400, { code: 400, status: "INVALID_ARGUMENT" })]), "key_rejected", 400],
    ["gemini 400 other", "gemini", () => fakeFetch([json({ error: { code: 400, message: "bad page token", status: "INVALID_ARGUMENT" } }, 400)]), "provider_error", 400],
    ["gemini 401", "gemini", () => fakeFetch([googleErr(401, { code: 401, status: "UNAUTHENTICATED" })]), "key_rejected", 401],
    ["gemini 403", "gemini", () => fakeFetch([googleErr(403, { code: 403, status: "PERMISSION_DENIED" })]), "forbidden", 403],
    ["gemini 429", "gemini", () => fakeFetch([googleErr(429, { code: 429, status: "RESOURCE_EXHAUSTED" })]), "rate_limited", 429],
    ["gemini 503", "gemini", () => fakeFetch([googleErr(503, { code: 503, status: "UNAVAILABLE" })]), "provider_error", 503],
    ["gemini 200 not JSON", "gemini", () => fakeFetch([new Response("<html>", { status: 200 })]), "provider_error", 200],
    ["gemini fetch failed", "gemini", () => fakeFetch([new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })]), "unreachable", null],
  ];

  it.each(cases)("%s", async (_name, provider, opts, code, status) => {
    const err = await failure(listModels(provider, KEY, opts()));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe(code);
  });

  it("a listing past its timeout is unreachable", async () => {
    const hang = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
      })) as typeof fetch;
    const err = await failure(listModels("gemini", KEY, { fetch: hang, timeoutMs: 20 }));
    expect(err.code).toBe("unreachable");
  });

  it.each([
    ["empty", ""],
    ["a space", "sk-ab cd"],
    ["a newline", "sk-abcd\nX-Evil: 1"],
    ["too long", "k".repeat(MAX_API_KEY_LENGTH + 1)],
  ])("refuses a key with %s before any call", async (_name, key) => {
    const { client, calls } = anthropicClient([]);
    const err = await failure(listModels("anthropic", key, { client }));
    expect(err.code).toBe("key_rejected");
    expect(calls).toHaveLength(0);
  });

  it("an unknown provider is a provider_error", async () => {
    const err = await failure(listModels("mistral" as AiProvider, KEY, {}));
    expect(err.code).toBe("provider_error");
  });

  it("toModelListError passes a ModelListError through and never copies a message", () => {
    const own = new ModelListError("rate_limited", 429);
    expect(toModelListError(own)).toBe(own);
    expect(exposed(toModelListError(new Error(`leak ${KEY}`)))).not.toContain("FAKEKEY");
  });
});
