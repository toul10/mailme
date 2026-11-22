import { describe, expect, it } from "vitest";
import { createGeminiExtractor, NO_CREDIT_RETRY_SEC } from "../../src/ai/gemini.js";
import { createMockExtractor } from "../../src/ai/mock.js";
import { PROBE_INPUT, probeAdvice, probeExtractor } from "../../src/ai/probe.js";
import { renderUserPrompt } from "../../src/ai/prompt.js";
import type { AiDescription } from "../../src/ai/resolve.js";
import { toWire, type ExtractionOutput } from "../../src/ai/schema.js";
import type { CliContext, CliServices } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/run.js";
import { loadConfig } from "../../src/config.js";
import type { Extractor, ExtractorResult } from "../../src/domain/types.js";
import type { Runtime } from "../../src/worker/runtime.js";

const baseEnv = { MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), APP_SECRET: "test-secret-test-secret-test-secret-1234" };
const KEY = "fake-gemini-key-0123456789abcdefghijklmnop";
const USAGE = { inputTokens: 5_000, outputTokens: 900, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** The mock's own answer to the invented email: a valid ACTIONABLE output with one CREATE. */
async function createOutput(): Promise<ExtractionOutput> {
  const res = await createMockExtractor().extract(PROBE_INPUT);
  if (!res.ok) throw new Error(res.error);
  return res.output;
}
const CREATE = await createOutput();

function fake(result: ExtractorResult, name = "gemini"): Extractor {
  return { name, pipelineVersion: `p|s|${name}:test|c|r`, extract: async () => result };
}
const okResult = (output: ExtractionOutput): ExtractorResult => ({ ok: true, output, model: "gemini-test-001", stopReason: "STOP", usage: USAGE, costUsd: 0.01425, latencyMs: 4_210, request: {} });
const failResult = (errorClass: "TRANSIENT" | "PER_MESSAGE" | "GLOBAL", error: string): ExtractorResult => ({
  ok: false,
  errorClass,
  error,
  retryAfterSec: null,
  model: null,
  stopReason: null,
  usage: null,
  costUsd: 0,
  latencyMs: 380,
  request: {},
});

describe("PROBE_INPUT", () => {
  it("is an invented email: example.* addresses only, and it renders as a prompt", () => {
    const text = JSON.stringify(PROBE_INPUT);
    expect(text.match(/[\w.+-]+@[\w.-]+/g)).toEqual(["maria@example.com", "maria@example.com", "george@example.org"]);
    expect(renderUserPrompt(PROBE_INPUT)).toContain("by Friday");
  });

  it("is read by the mock as the request it is", async () => {
    const r = await probeExtractor(createMockExtractor());
    expect(r).toMatchObject({ ok: true, extractor: "mock", messageClass: "ACTIONABLE", operations: ["CREATE"], asExpected: true, costUsd: 0 });
  });
});

describe("probeExtractor", () => {
  it("reports an answer: class, operation names, tokens, cost, time", async () => {
    expect(await probeExtractor(fake(okResult(CREATE)))).toEqual({
      ok: true,
      extractor: "gemini",
      pipelineVersion: "p|s|gemini:test|c|r",
      model: "gemini-test-001",
      messageClass: "ACTIONABLE",
      operations: ["CREATE"],
      asExpected: true,
      errorClass: null,
      error: null,
      usage: USAGE,
      costUsd: 0.01425,
      latencyMs: 4_210,
    });
  });

  it("marks an answer that is not the expected one, without failing the check", async () => {
    const r = await probeExtractor(fake(okResult({ message_class: "FYI", suspicious_instructions: false, operations: [] })));
    expect(r).toMatchObject({ ok: true, messageClass: "FYI", operations: [], asExpected: false });
  });

  it("reports a provider failure by class and tag", async () => {
    const r = await probeExtractor(fake(failResult("TRANSIENT", "http_402:RESOURCE_EXHAUSTED")));
    expect(r).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "http_402:RESOURCE_EXHAUSTED", messageClass: null, operations: [], asExpected: false, usage: null, costUsd: 0 });
  });

  it("goes through the real Gemini adapter: one generateContent call with the invented email", async () => {
    const calls: string[] = [];
    const bodies: string[] = [];
    const fetchOk = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      bodies.push(String(init?.body));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(toWire(CREATE)) }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 5_000, candidatesTokenCount: 400, thoughtsTokenCount: 500 },
          modelVersion: "gemini-3.6-flash",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const ex = createGeminiExtractor({ apiKey: KEY, model: "gemini-3.6-flash", maxTokens: 16_000, timeoutMs: 300_000, maxRetries: 0, componentVersions: { cleaner: "c1", resolver: "r2" }, fetch: fetchOk });
    const r = await probeExtractor(ex);
    expect(calls).toEqual(["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"]);
    // The prompt names people and their domains, never a full address (src/ai/prompt.ts).
    expect(bodies[0]).toContain("George Placeholder");
    expect(bodies[0]).toContain("example.org");
    expect(bodies[0]).not.toContain("george@example.org");
    expect(r).toMatchObject({ ok: true, model: "gemini-3.6-flash", messageClass: "ACTIONABLE", operations: ["CREATE"], asExpected: true, usage: USAGE });
    // 5000·1.5 + 900·7.5 = 14250 µ$
    expect(r.costUsd).toBeCloseTo(0.01425, 10);
  });
});

describe("probeAdvice", () => {
  it.each([
    ["http_402:RESOURCE_EXHAUSTED", "gemini", /buy credits in AI Studio/],
    ["http_402:billing_error", "anthropic", /Claude \(Anthropic\) has no credit left/],
    ["http_429:insufficient_quota", "openai", /OpenAI has no credit left/],
    ["http_400:API_KEY_INVALID", "gemini", /refuses the API key/],
    ["http_401:authentication_error", "anthropic", /refuses the API key/],
    ["http_401:invalid_api_key", "xai", /Grok \(xAI\) refuses the API key/],
    ["http_404:NOT_FOUND", "gemini", /does not know this model id/],
    ["http_404:model_not_found", "openai", /does not know this model id/],
    ["http_403:PERMISSION_DENIED", "gemini", /refuses this account or project/],
    ["http_400:INVALID_ARGUMENT", "gemini", /do not use this configuration/],
    ["http_400:invalid_request_error", "anthropic", /do not use this configuration/],
    ["http_429:RESOURCE_EXHAUSTED", "gemini", /Rate limit/],
    ["http_429:rate_limit_exceeded", "openai", /Rate limit/],
    ["schema_invalid:create:0", "openai", /shape/],
    ["max_tokens", "gemini", /AI_MAX_TOKENS/],
    ["connection", "anthropic", /could not be reached/],
  ] as const)("%s (%s)", (error, provider, advice) => {
    expect(probeAdvice(error, provider)).toMatch(advice);
  });

  it("names no provider when none is given, and has nothing to say about an unknown tag", () => {
    expect(probeAdvice("http_401:x")).toMatch(/^the provider refuses the API key/);
    expect(probeAdvice("unexpected:TypeError", "openai")).toBeNull();
    expect(probeAdvice(null)).toBeNull();
  });
});

describe("pnpm cli ai:check", () => {
  const GEMINI: AiDescription = { mode: "provider", provider: "gemini", model: "gemini-3.6-flash", source: "stored", reason: null };
  const MOCK: AiDescription = { mode: "mock", provider: null, model: null, source: null, reason: "no_key" };

  function cli(ai: AiDescription, extractor: Extractor, answers: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = {
      out: (x) => void out.push(x),
      err: (x) => void err.push(x),
      prompt: async () => {
        throw new Error("unexpected prompt");
      },
      confirm: async () => /^y/i.test(answers.shift() ?? "n"),
      close() {},
    };
    const config = loadConfig(baseEnv);
    let refreshed = 0;
    let extracted = 0;
    // The parts of the runtime ai:check uses: Admin → AI is followed first, then the extractor it gave is asked once.
    const runtime = {
      refreshAi: async () => void refreshed++,
      get ai() {
        return refreshed ? ai : null;
      },
      get extractor(): Extractor {
        return { ...extractor, extract: (input) => (extracted++, extractor.extract(input)) };
      },
    } as unknown as Runtime;
    const never = () => {
      throw new Error("not used by ai:check");
    };
    const ctx: CliContext = { io, config: () => config, tryConfig: () => config, ops: never, runtime: async () => runtime, services: {} as CliServices, now: () => new Date("2026-11-20T08:00:00Z") };
    return { out, err, calls: () => extracted, run: (...argv: string[]) => runCli(["ai:check", ...argv], ctx) };
  }

  it("runs the built-in rules without asking, and says that no provider was checked", async () => {
    const c = cli(MOCK, createMockExtractor());
    expect(await c.run()).toBe(0);
    expect(c.out.join("\n")).toMatch(/^AI check: mock · .*\nOK in .* · about \$0\.0000\nAnswer: ACTIONABLE · CREATE\n {2}NOTE: no AI provider is in use/);
  });

  it("asks before a paid call, and --yes skips the question", async () => {
    const refused = cli(GEMINI, fake(okResult(CREATE)));
    expect(await refused.run()).toBe(1);
    expect(refused.calls()).toBe(0);

    const c = cli(GEMINI, fake(okResult(CREATE)));
    expect(await c.run("--yes")).toBe(0);
    expect(c.calls()).toBe(1);
    expect(c.out).toEqual(["AI check: gemini · p|s|gemini:test|c|r", "OK in 4.2 s · model gemini-test-001 · tokens in 5000, out 900 · about $0.0143", "Answer: ACTIONABLE · CREATE"]);
  });

  it("refuses, without a call, when the chosen provider cannot run", async () => {
    const c = cli({ mode: "unavailable", provider: "openai", model: null, source: null, reason: "no_key" }, fake(okResult(CREATE)));
    expect(await c.run("--yes")).toBe(1);
    expect(c.calls()).toBe(0);
    expect(c.err).toEqual(["AI cannot run: there is no OpenAI key (add one in Admin → AI, or set OPENAI_API_KEY in the worker's environment)."]);
  });

  it("exits 1 with the tag and what to do when the credits are used up", async () => {
    const c = cli(GEMINI, fake(failResult("TRANSIENT", "http_402:RESOURCE_EXHAUSTED")));
    expect(await c.run("--yes")).toBe(1);
    expect(c.out[1]).toBe("FAILED in 0.4 s: TRANSIENT: http_402:RESOURCE_EXHAUSTED");
    expect(c.out[2]).toMatch(/buy credits in AI Studio/);
    expect(c.out).toHaveLength(3);
  });

  it("warns that a GLOBAL failure would pause AI for every mailbox", async () => {
    const c = cli(GEMINI, fake(failResult("GLOBAL", "http_400:INVALID_ARGUMENT")));
    expect(await c.run("--yes")).toBe(1);
    expect(c.out.join("\n")).toMatch(/do not use this configuration[\s\S]*pauses AI for every mailbox/);
  });

  it("notes an answer that is not the expected one, exit 0 (the chain works)", async () => {
    const c = cli(GEMINI, fake(okResult({ message_class: "FYI", suspicious_instructions: false, operations: [] })));
    expect(await c.run("--yes")).toBe(0);
    expect(c.out[2]).toBe("Answer: FYI · no operations");
    expect(c.out[3]).toMatch(/NOTE: .*ACTIONABLE with one CREATE/);
  });

  it("prints the report as JSON with --json, and never a key", async () => {
    const c = cli(GEMINI, fake(failResult("TRANSIENT", "http_402:RESOURCE_EXHAUSTED")));
    expect(await c.run("--yes", "--json")).toBe(1);
    expect(JSON.parse(c.out.join("\n"))).toMatchObject({ ok: false, errorClass: "TRANSIENT", error: "http_402:RESOURCE_EXHAUSTED" });
    expect([...c.out, ...c.err].join("\n")).not.toContain(KEY);
  });

  it("keeps the no-credit wait in step with the adapter", () => {
    expect(NO_CREDIT_RETRY_SEC).toBe(300);
  });
});
