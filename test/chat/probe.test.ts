import { describe, expect, it } from "vitest";
import { ZERO_USAGE } from "../../src/ai/pricing.js";
import { createMockChatModel } from "../../src/chat/mock.js";
import { createChatModel, type ChatModel, type ChatModelCall, type ChatModelResult } from "../../src/chat/model.js";
import { chatProbeAdvice, probeChat, PROBE_QUESTION, type ChatProbeReport } from "../../src/chat/probe.js";
import type { CliContext, CliServices } from "../../src/cli/context.js";
import type { CliIO } from "../../src/cli/io.js";
import { runCli } from "../../src/cli/run.js";
import { loadConfig, type Config } from "../../src/config.js";

const baseEnv = { MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), APP_SECRET: "test-secret-test-secret-test-secret-1234" };
const KEY = "fake-gemini-key-0123456789abcdefghijklmnop";
const NOW = new Date("2026-11-20T08:00:00Z");

const said = (step: unknown, over: Partial<Extract<ChatModelResult, { ok: true }>> = {}): ChatModelResult => ({
  ok: true,
  text: JSON.stringify(step),
  model: "gemini-test-001",
  usage: { ...ZERO_USAGE, inputTokens: 2_000, outputTokens: 150, cacheReadInputTokens: 500 },
  costUsd: 0.0012,
  latencyMs: 900,
  ...over,
});
const failed = (kind: Extract<ChatModelResult, { ok: false }>["kind"], error: string): ChatModelResult => ({ ok: false, kind, error, model: null, usage: null, costUsd: 0, latencyMs: 300 });

/** A model that answers from a list, and keeps what it was sent. */
function scripted(replies: Array<ChatModelResult | ((call: ChatModelCall) => ChatModelResult | Promise<ChatModelResult>)>) {
  const calls: ChatModelCall[] = [];
  const model: ChatModel = {
    name: "gemini",
    id: "gemini:gemini-test@low",
    async complete(call) {
      calls.push(call);
      const next = replies.shift();
      if (!next) throw new Error("no reply scripted");
      return typeof next === "function" ? next(call) : next;
    },
  };
  return { model, calls };
}
const LOOKUP = { all_of: [], any_of: [], person: "", after: "", before: "", sender: "anyone", handle: "", status: "open" };
const searchForGeorge = said({ lookups: [{ ...LOOKUP, tool: "search_mail", person: "Placeholder" }], answer: "", draft: "", sources: [] });
/** Answers with the handle of the customer's own message, as the lookup result shows it. */
const citeTheRequest = (call: ChatModelCall): ChatModelResult => {
  const handle = /<mail handle="(M[0-9a-f]+)"[^>]*subject="Quote for speakers"/.exec(call.user)?.[1];
  return said({ lookups: [], answer: `He asked for a quote for 4 ceiling speakers by Friday [${handle}].`, draft: "", sources: [handle] });
};

describe("chat probe: one invented question through the real engine", () => {
  it("finds the invented request with the mock model, without any database", async () => {
    const r = await probeChat(createMockChatModel(), { now: NOW });
    expect(r).toMatchObject({ ok: true, asExpected: true, model: "mock", promptVersion: "c2", outcome: "answer", error: null, calls: 2, lookups: 2, costUsd: 0 });
    expect(r.steps).toHaveLength(2);
    expect(r.sources).toContain("Quote for speakers");
    expect(r.sources.join(" ")).toContain("#1 Quote for 4 ceiling speakers");
    expect(r.answer).toMatch(/\[M[0-9a-f]{6,}\]/);
  });

  it("shows the model an invented mailbox only, and counts what the question cost", async () => {
    const { model, calls } = scripted([searchForGeorge, citeTheRequest]);
    const r = await probeChat(model, { now: NOW, retentionDays: 45 });
    expect(r).toMatchObject({ ok: true, asExpected: true, model: "gemini:gemini-test@low", answeredBy: "gemini-test-001", calls: 2, lookups: 1, inputTokens: 5_000, outputTokens: 300, costUsd: 0.0024 });
    expect(r.steps).toEqual(["Searching your mail: with Placeholder"]);
    expect(r.sources).toEqual(["Quote for speakers"]);

    expect(calls[0]!.system).toContain("about 45 days");
    expect(calls[0]!.user).toContain(`<question>${PROBE_QUESTION}</question>`);
    expect(calls[0]!.user).toContain('user_name="Maria Sample"');
    expect(calls[0]!.user).toContain("today=\"2026-11-20 Friday 10:00\"");
    // The second call carries what the search found: the customer's message and the owner's reply, nothing else.
    expect(calls[1]!.user).toContain("george@example.org");
    expect(calls[1]!.user).not.toContain("Warehouse hours");
    const addresses = new Set([...`${calls[0]!.user}\n${calls[1]!.user}`.matchAll(/[\w.+-]+@([\w.-]+)/g)].map((m) => m[1]!.replace(/\.$/, "")));
    for (const domain of addresses) expect(domain).toMatch(/^example\.(com|org|net)$/);
  });

  it("says so when the answer does not name the request", async () => {
    const { model } = scripted([searchForGeorge, said({ lookups: [], answer: "I found nothing.", draft: "", sources: [] })]);
    const r = await probeChat(model, { now: NOW });
    expect(r).toMatchObject({ ok: true, asExpected: false, sources: [], answer: "I found nothing." });
  });

  it("reports a failure of the model with its tag, and what it cost until then", async () => {
    const { model } = scripted([searchForGeorge, failed("no_credit", "http_402:RESOURCE_EXHAUSTED")]);
    const r = await probeChat(model, { now: NOW });
    expect(r).toMatchObject({ ok: false, asExpected: false, outcome: "error:no_credit", error: "http_402:RESOURCE_EXHAUSTED", answer: null, calls: 2, lookups: 1, costUsd: 0.0012 });
    expect(chatProbeAdvice(r)).toMatch(/buy credits in AI Studio/);
  });

  it("reports a model that never produces a usable step", async () => {
    const { model } = scripted([said("not a step", { text: "I cannot do that." }), said({ lookups: [], answer: "", draft: "", sources: [] })]);
    const r = await probeChat(model, { now: NOW });
    expect(r).toMatchObject({ ok: false, outcome: "error:bad_output", error: null, calls: 2 });
    expect(chatProbeAdvice(r)).toMatch(/JSON shape/);
  });

  it("gives up when the model is too slow, and says what to try", async () => {
    const hang = (call: ChatModelCall) =>
      new Promise<ChatModelResult>((resolve) => {
        call.signal?.addEventListener("abort", () => resolve(failed("aborted", "aborted")), { once: true });
      });
    const { model } = scripted([hang]);
    const r = await probeChat(model, { now: NOW, timeoutMs: 40 });
    expect(r).toMatchObject({ ok: false, outcome: "aborted", error: "timeout", calls: 1 });
    expect(chatProbeAdvice(r)).toMatch(/CHAT_THINKING_LEVEL=low/);
  });
});

describe("chat probe: advice", () => {
  const advice = (error: string | null, outcome: ChatProbeReport["outcome"] = "error:config") => chatProbeAdvice({ outcome, error });

  it.each([
    ["http_404:NOT_FOUND", /CHAT_MODEL/],
    ["max_tokens", /CHAT_MAX_TOKENS/],
    ["http_403:PERMISSION_DENIED", /refuses this account or project/],
    ["http_400:API_KEY_INVALID", /check CHAT_API_KEY in the API's environment/],
    ["http_401:UNAUTHENTICATED", /check CHAT_API_KEY in the API's environment/],
    ["http_400:INVALID_ARGUMENT", /refused the request itself/],
    ["connection", /could not be reached/],
    ["http_429:RESOURCE_EXHAUSTED", /Rate limit/],
  ])("%s", (error, expected) => {
    expect(advice(error)).toMatch(expected);
  });

  it("never points at the extraction's settings: the chat's key, model and limits are its own", () => {
    for (const e of ["http_402:RESOURCE_EXHAUSTED", "http_404:NOT_FOUND", "max_tokens", "http_400:API_KEY_INVALID", "http_401:UNAUTHENTICATED", "http_403:PERMISSION_DENIED", "http_429:RESOURCE_EXHAUSTED"]) {
      expect(advice(e), e).not.toMatch(/Admin → AI|ai:resume|AI_MAX_TOKENS|GEMINI_API_KEY|queue/);
    }
  });

  it("has nothing to say about an unknown tag", () => {
    expect(advice("something_new")).toBeNull();
    expect(advice(null)).toBeNull();
  });
});

describe("pnpm cli chat:check", () => {
  const REPORT: ChatProbeReport = {
    ok: true,
    model: "gemini:gemini-3.8-flash@low",
    answeredBy: "gemini-3.8-flash-001",
    promptVersion: "c2",
    steps: ["Searching your mail: with Placeholder", "Reading the conversation “Quote for speakers”"],
    answer: "He asked for a quote for 4 ceiling speakers:\n- by Friday [M73afa1]",
    sources: ["Quote for speakers"],
    asExpected: true,
    outcome: "answer",
    error: null,
    calls: 3,
    lookups: 2,
    inputTokens: 9_400,
    outputTokens: 620,
    costUsd: 0.00713,
    latencyMs: 8_240,
  };

  /** `processEnv` stands for the environment of the process: the chat's key is read there, never from the config. */
  function cli(env: Record<string, string>, report: ChatProbeReport | null = null, answers: string[] = [], processEnv: NodeJS.ProcessEnv = { CHAT_API_KEY: KEY }) {
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
    const config = loadConfig({ ...baseEnv, ...env });
    const never = () => {
      throw new Error("chat:check must not open the database");
    };
    const probed: string[] = [];
    const services = {
      createChatModel: (cfg: Config) => createChatModel(cfg, processEnv),
      ...(report
        ? {
            probeChat: async (model: ChatModel) => {
              probed.push(model.id);
              return report;
            },
          }
        : {}),
    } as unknown as CliServices;
    const ctx: CliContext = { io, config: () => config, tryConfig: () => config, ops: never, runtime: never, services, now: () => NOW };
    return { out, err, probed, run: (...argv: string[]) => runCli(["chat:check", ...argv], ctx) };
  }
  const geminiEnv = { CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash", CHAT_THINKING_LEVEL: "low" };

  it("has nothing to check when the chat is off", async () => {
    const c = cli({}, REPORT);
    expect(await c.run()).toBe(1);
    expect(c.err.join("\n")).toMatch(/CHAT_MODE=off/);
    expect(c.probed).toEqual([]);
  });

  it("runs the mock without asking and without the database", async () => {
    const c = cli({ CHAT_MODE: "mock" });
    expect(await c.run()).toBe(0);
    expect(c.out[0]).toBe("Chat check: mock · prompt c2");
    expect(c.out[1]).toBe(`Question: ${PROBE_QUESTION}`);
    expect(c.out.join("\n")).toMatch(/\nOK in .* · model mock · 2 calls, 2 lookups · tokens in 0, out 0 · about \$0\.0000\nAnswer: .*\nSources: .*Quote for speakers/);
    expect(c.out.join("\n")).not.toMatch(/NOTE/);
  });

  it("asks before paid calls, and --yes skips the question", async () => {
    const refused = cli(geminiEnv, REPORT);
    expect(await refused.run()).toBe(1);
    expect(refused.probed).toEqual([]);

    const c = cli(geminiEnv, REPORT);
    expect(await c.run("--yes")).toBe(0);
    expect(c.probed).toEqual(["gemini:gemini-3.8-flash@low"]);
    expect(c.out).toEqual([
      "Chat check: gemini:gemini-3.8-flash@low · prompt c2",
      `Question: ${PROBE_QUESTION}`,
      "  Searching your mail: with Placeholder",
      "  Reading the conversation “Quote for speakers”",
      "OK in 8.2 s · model gemini-3.8-flash-001 · 3 calls, 2 lookups · tokens in 9400, out 620 · about $0.0071",
      "Answer: He asked for a quote for 4 ceiling speakers: / - by Friday [M73afa1]",
      "Sources: Quote for speakers",
    ]);
  });

  it("notes an answer that does not name the request, exit 0 (the chain works)", async () => {
    const c = cli(geminiEnv, { ...REPORT, asExpected: false, sources: [] });
    expect(await c.run("--yes")).toBe(0);
    expect(c.out.at(-2)).toBe("Sources: none");
    expect(c.out.at(-1)).toMatch(/NOTE: .*should name that message or its task/);
  });

  it("exits 1 with the tag and what to do when the model fails", async () => {
    const c = cli(geminiEnv, { ...REPORT, ok: false, asExpected: false, answer: null, sources: [], steps: [], outcome: "error:config", error: "http_404:NOT_FOUND", calls: 1, lookups: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 410 });
    expect(await c.run("--yes")).toBe(1);
    expect(c.out[2]).toBe("FAILED in 0.4 s: error:config: http_404:NOT_FOUND · 1 call, 0 lookups · tokens in 0, out 0 · about $0.0000");
    expect(c.out[3]).toMatch(/CHAT_MODEL/);
    expect(c.out).toHaveLength(4);
  });

  it("names a missing key or model and never prints a value", async () => {
    const noModel = cli({ CHAT_MODE: "gemini" }, REPORT);
    expect(await noModel.run("--yes")).toBe(1);
    expect(noModel.err.join("\n")).toMatch(/chat:check failed: CHAT_MODE=gemini needs CHAT_MODEL/);
    // The worker's own key in the environment is not the chat's.
    const noKey = cli({ CHAT_MODE: "gemini", CHAT_MODEL: "gemini-3.8-flash" }, REPORT, [], { GEMINI_API_KEY: KEY });
    expect(await noKey.run("--yes")).toBe(1);
    expect(noKey.err.join("\n")).toMatch(/chat:check failed: CHAT_MODE=gemini needs CHAT_API_KEY/);
    expect([...noModel.out, ...noModel.err, ...noKey.out, ...noKey.err].join("\n")).not.toContain(KEY);
    expect([...noModel.probed, ...noKey.probed]).toEqual([]);
  });

  it("prints the report as JSON with --json", async () => {
    const c = cli(geminiEnv, { ...REPORT, ok: false, outcome: "error:no_credit", error: "http_402:RESOURCE_EXHAUSTED" });
    expect(await c.run("--yes", "--json")).toBe(1);
    expect(JSON.parse(c.out.join("\n"))).toMatchObject({ ok: false, outcome: "error:no_credit", error: "http_402:RESOURCE_EXHAUSTED", model: "gemini:gemini-3.8-flash@low" });
  });
});
