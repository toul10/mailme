import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelListError, type AiModelOption, type AiProvider, type ModelLister } from "../../src/ai/providers.js";
import type { ResolvedAi } from "../../src/ai/resolve.js";
import { bumpAiSettings, sealAiKey } from "../../src/ai/settings.js";
import { loadConfig, type Config } from "../../src/config.js";
import * as s from "../../src/db/schema.js";
import { GLOBAL_PAUSE_KEY, type Clock, type Extractor, type Logger } from "../../src/domain/types.js";
import { ephemeralSealingKeys, type SealingKeys } from "../../src/lib/sealed.js";
import { AI_REPORT_HEARTBEAT_MS, createAiRuntime, MODELS_MAX_AGE_MS, MODELS_RETRY_MS } from "../../src/worker/ai-runtime.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

const ENV_ANTHROPIC = "fake-anthropic-ENV-0000-1111";
const ENV_OPENAI = "fake-openai-ENV-2222-3333";
const ENV_XAI = "xai-ENV-FAKE-7777-8888";
const STORED_OPENAI = "fake-openai-STORED-4444-5555";
const ALL_KEYS = [ENV_ANTHROPIC, ENV_OPENAI, ENV_XAI, STORED_OPENAI];
const MODELS: AiModelOption[] = [{ id: "m-1", label: "M 1" }];

class TestClock implements Clock {
  t = new Date("2026-09-15T07:00:00Z");
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

type LogCall = { level: string; obj: object; msg?: string };
function spyLogger(calls: LogCall[]): Logger {
  const mk = (level: string) => (obj: object, msg?: string) => void calls.push({ level, obj, msg });
  const logger: Logger = { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug"), child: () => logger };
  return logger;
}

function cfg(aiMode = "auto"): Config {
  return loadConfig({ MASTER_KEY: Buffer.alloc(32, 3).toString("base64"), APP_SECRET: "x".repeat(40), DATABASE_URL: "pglite://memory", AI_MODE: aiMode });
}

/** The worker's view of Admin → AI (src/worker/ai-runtime.ts), against a real database and fake providers. */
describe("worker AI runtime", () => {
  let t: TestDb;
  let clock: TestClock;
  let logs: LogCall[];
  let keys: SealingKeys;
  let lister: ReturnType<typeof vi.fn<ModelLister>>;

  beforeEach(async () => {
    t = await createTestDb();
    clock = new TestClock();
    logs = [];
    keys = ephemeralSealingKeys();
    lister = vi.fn<ModelLister>(async () => MODELS);
  });
  afterEach(async () => {
    const text = JSON.stringify(logs);
    for (const k of ALL_KEYS) expect(text).not.toContain(k);
    await t.close();
  });

  function setup(opts: { env?: Record<string, string>; aiMode?: string; fixed?: Extractor; readOnly?: boolean } = {}) {
    const built: ResolvedAi[] = [];
    const createExtractor = vi.fn((_c: Config, ai: ResolvedAi): Extractor => {
      built.push(ai);
      return { name: ai.kind === "provider" ? ai.provider : ai.kind, pipelineVersion: "test", extract: async () => Promise.reject(new Error("unused")) };
    });
    const rt = createAiRuntime({
      db: t.db,
      config: cfg(opts.aiMode),
      log: spyLogger(logs),
      clock,
      env: opts.env ?? {},
      privateKeys: () => keys,
      listModels: (...a) => lister(...a),
      createExtractor,
      fixedExtractor: opts.fixed ?? null,
      readOnly: opts.readOnly ?? false,
    });
    return { rt, createExtractor, built };
  }
  const pause = (error: string) => t.db.insert(s.appState).values({ key: GLOBAL_PAUSE_KEY, value: { reason: "extractor", at: clock.now().toISOString(), error } });
  const pauseRow = async () => (await t.db.select().from(s.appState).where(eq(s.appState.key, GLOBAL_PAUSE_KEY)))[0];

  const choose = (provider: string, model: string | null) => bumpAiSettings(t.db, clock.now(), null, { provider, model });
  const storeKey = (provider: AiProvider, key: string, k: SealingKeys = keys) =>
    t.db.insert(s.aiProviders).values({
      provider,
      keySealed: sealAiKey(provider, key, k),
      keyLast4: key.slice(-4),
      keySetAt: clock.now(),
      models: MODELS,
      modelsListedAt: clock.now(),
      modelsFrom: `stored:${key.slice(-4)}`,
    });
  const providerRow = async (p: AiProvider) => (await t.db.select().from(s.aiProviders).where(eq(s.aiProviders.provider, p)))[0];
  const settingsRow = async () => (await t.db.select().from(s.aiSettings))[0]!;

  it("nothing chosen and no key: the mock, reported with the reason", async () => {
    const { rt, built } = setup();
    await rt.refresh();
    expect(built).toEqual([{ kind: "mock", reason: "no_key", provider: null }]);
    expect(rt.current).toEqual({ mode: "mock", provider: null, model: null, source: null, reason: "no_key" });
    expect(await settingsRow()).toMatchObject({ provider: null, version: 0, workerReport: rt.current, workerReportAt: clock.now() });
    expect(lister).not.toHaveBeenCalled();
    expect(await t.db.select().from(s.aiProviders)).toEqual([]);
  });

  it("an ANTHROPIC_API_KEY alone runs Claude with AI_MODEL; its last four and models are recorded, listed at most daily", async () => {
    const env = { ANTHROPIC_API_KEY: ENV_ANTHROPIC };
    const { rt, built } = setup({ env });
    await rt.refresh();
    expect(built.at(-1)).toEqual({ kind: "provider", provider: "anthropic", model: "claude-opus-5", source: "env", apiKey: ENV_ANTHROPIC });
    expect(lister).toHaveBeenCalledTimes(1);
    expect(lister).toHaveBeenCalledWith("anthropic", ENV_ANTHROPIC, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(await providerRow("anthropic")).toMatchObject({ envLast4: "1111", keySealed: null, models: MODELS, modelsFrom: "env:1111" });

    // Heartbeats and a restarted worker reuse the list while it is fresh.
    clock.advance(AI_REPORT_HEARTBEAT_MS);
    await rt.refresh();
    await setup({ env }).rt.refresh();
    expect(lister).toHaveBeenCalledTimes(1);

    clock.advance(MODELS_MAX_AGE_MS);
    await rt.refresh();
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it("reloads a stored key's models once a day (the API cannot open it); a key just saved is not listed again", async () => {
    await storeKey("openai", STORED_OPENAI);
    const { rt } = setup();
    await rt.refresh();
    expect(lister).not.toHaveBeenCalled();

    const newer: AiModelOption[] = [...MODELS, { id: "m-2", label: "M 2" }];
    lister.mockResolvedValueOnce(newer);
    clock.advance(MODELS_MAX_AGE_MS);
    await rt.refresh();
    expect(lister).toHaveBeenCalledWith("openai", STORED_OPENAI, expect.anything());
    expect(await providerRow("openai")).toMatchObject({ models: newer, modelsFrom: "stored:5555", modelsListedAt: clock.now() });
  });

  it("when the environment key goes, the stored key's models are listed instead", async () => {
    await storeKey("openai", STORED_OPENAI);
    await setup({ env: { OPENAI_API_KEY: ENV_OPENAI } }).rt.refresh();
    expect(lister).toHaveBeenLastCalledWith("openai", ENV_OPENAI, expect.anything());
    expect(await providerRow("openai")).toMatchObject({ envLast4: "3333", modelsFrom: "env:3333" });

    await setup().rt.refresh();
    expect(lister).toHaveBeenLastCalledWith("openai", STORED_OPENAI, expect.anything());
    expect(await providerRow("openai")).toMatchObject({ envLast4: null, modelsFrom: "stored:5555" });
  });

  it("opens a stored key with the private key; an environment key for the same provider wins", async () => {
    await storeKey("openai", STORED_OPENAI);
    await choose("openai", "m-1");
    const a = setup();
    await a.rt.refresh();
    expect(a.built.at(-1)).toEqual({ kind: "provider", provider: "openai", model: "m-1", source: "stored", apiKey: STORED_OPENAI });
    expect(a.rt.current).toEqual({ mode: "provider", provider: "openai", model: "m-1", source: "stored", reason: null });
    expect(a.rt.extractor.name).toBe("openai");

    const b = setup({ env: { OPENAI_API_KEY: ENV_OPENAI } });
    await b.rt.refresh();
    expect(b.built.at(-1)).toEqual({ kind: "provider", provider: "openai", model: "m-1", source: "env", apiKey: ENV_OPENAI });
  });

  it("a stored key sealed for another key pair does not open: unavailable, key_unreadable", async () => {
    await storeKey("xai", STORED_OPENAI, ephemeralSealingKeys("other"));
    await choose("xai", "grok-x");
    const { rt, built } = setup();
    await rt.refresh();
    expect(built.at(-1)).toEqual({ kind: "unavailable", reason: "key_unreadable", provider: "xai" });
    expect((await settingsRow()).workerReport).toEqual({ mode: "unavailable", provider: "xai", model: null, source: null, reason: "key_unreadable" });
  });

  it("lifts the pause an unavailable provider caused once AI can run (a restart with the key); other pauses stay", async () => {
    await choose("openai", "m-1");
    await setup().rt.refresh();
    // The first message that needed AI paused every mailbox (src/engine/pipeline.ts).
    await pause("ai_unavailable:no_key:openai");
    // Still no key: the pause stays.
    await setup().rt.refresh();
    expect(await pauseRow()).toBeDefined();

    await setup({ env: { OPENAI_API_KEY: ENV_OPENAI } }).rt.refresh();
    expect(await pauseRow()).toBeUndefined();
    expect(logs.map((l) => l.msg)).toContain("AI can run again: the global pause it caused is lifted");

    // A rejected key is another matter: only a save in Admin → AI (or ai:resume) lifts it.
    await pause("http_401:authentication_error");
    await setup({ env: { OPENAI_API_KEY: ENV_OPENAI } }).rt.refresh();
    expect(await pauseRow()).toMatchObject({ value: { error: "http_401:authentication_error" } });
  });

  it("a CLI process (read-only) follows Admin → AI but writes nothing: no report, no keys, no pause lifted", async () => {
    await storeKey("openai", STORED_OPENAI);
    await choose("openai", "m-1");
    await pause("ai_unavailable:no_key:openai");
    const before = await providerRow("openai");
    const { rt, built } = setup({ env: { XAI_API_KEY: ENV_XAI }, readOnly: true });
    await rt.refresh();
    clock.advance(MODELS_MAX_AGE_MS);
    await rt.refresh();
    expect(built.at(-1)).toEqual({ kind: "provider", provider: "openai", model: "m-1", source: "stored", apiKey: STORED_OPENAI });
    expect(rt.current).toMatchObject({ mode: "provider", provider: "openai" });
    expect((await settingsRow()).workerReport).toBeNull();
    expect(await providerRow("openai")).toEqual(before);
    expect(await providerRow("xai")).toBeUndefined();
    expect(await pauseRow()).toBeDefined();
    expect(lister).not.toHaveBeenCalled();
  });

  it("AI_MODE=mock is the kill switch: the mock, and no provider is called, not even to list models", async () => {
    await storeKey("openai", STORED_OPENAI);
    await choose("openai", "m-1");
    const { rt, built } = setup({ aiMode: "mock", env: { ANTHROPIC_API_KEY: ENV_ANTHROPIC } });
    await rt.refresh();
    expect(built.at(-1)).toEqual({ kind: "mock", reason: "ai_mode_mock", provider: null });
    expect(lister).not.toHaveBeenCalled();
    // The last four are still shown in Admin → AI.
    expect(await providerRow("anthropic")).toMatchObject({ envLast4: "1111", models: [], modelsFrom: null });
  });

  it("Off in Admin → AI runs the mock with keys present", async () => {
    await choose("mock", null);
    const { rt, built } = setup({ env: { ANTHROPIC_API_KEY: ENV_ANTHROPIC } });
    await rt.refresh();
    expect(built.at(-1)).toEqual({ kind: "mock", reason: "off", provider: null });
  });

  it("rebuilds only when the version moves: with its key removed, the chosen provider is unavailable (not the mock)", async () => {
    await storeKey("openai", STORED_OPENAI);
    await choose("openai", "m-1");
    const { rt, createExtractor, built } = setup();
    await rt.refresh();
    await rt.refresh();
    expect(createExtractor).toHaveBeenCalledTimes(1);

    // The API removes the key and bumps the version in one transaction; here the two steps are apart.
    await t.db.update(s.aiProviders).set({ keySealed: null, keyLast4: null }).where(eq(s.aiProviders.provider, "openai"));
    await rt.refresh();
    expect(createExtractor).toHaveBeenCalledTimes(1);
    await bumpAiSettings(t.db, clock.now(), null);
    await rt.refresh();
    expect(createExtractor).toHaveBeenCalledTimes(2);
    expect(built.at(-1)).toEqual({ kind: "unavailable", reason: "no_key", provider: "openai" });
    expect(rt.extractor.name).toBe("unavailable");
  });

  it("reports at once on a change, otherwise as a heartbeat every five minutes", async () => {
    const { rt } = setup();
    await rt.refresh();
    const first = (await settingsRow()).workerReportAt;
    clock.advance(60_000);
    await rt.refresh();
    expect((await settingsRow()).workerReportAt).toEqual(first);
    clock.advance(AI_REPORT_HEARTBEAT_MS);
    await rt.refresh();
    expect((await settingsRow()).workerReportAt).toEqual(clock.now());

    clock.advance(1_000);
    await choose("mock", null);
    await rt.refresh();
    expect(await settingsRow()).toMatchObject({ workerReport: { mode: "mock", reason: "off" }, workerReportAt: clock.now() });

    // A save that changes nothing visible is reported at once too: the page compares the report's time with the save's.
    clock.advance(1_000);
    await choose("mock", null);
    await rt.refresh();
    expect((await settingsRow()).workerReportAt).toEqual(clock.now());
  });

  it("concurrent drains share one refresh", async () => {
    const { rt, createExtractor } = setup();
    await Promise.all([rt.refresh(), rt.refresh(), rt.refresh()]);
    expect(createExtractor).toHaveBeenCalledTimes(1);
  });

  it("before the first refresh the extractor follows AI_MODE and the environment only", async () => {
    await storeKey("openai", STORED_OPENAI);
    await choose("openai", "m-1");
    const { rt, built } = setup({ env: { ANTHROPIC_API_KEY: ENV_ANTHROPIC } });
    expect(rt.current).toBeNull();
    expect(rt.extractor.name).toBe("anthropic");
    expect(built).toEqual([{ kind: "provider", provider: "anthropic", model: "claude-opus-5", source: "env", apiKey: ENV_ANTHROPIC }]);
    await rt.refresh();
    expect(rt.extractor.name).toBe("openai");
  });

  it("a key whose listing fails keeps its last four and is retried an hour later, not every tick; a removed one clears its list", async () => {
    lister.mockRejectedValueOnce(new ModelListError("key_rejected", 401));
    const a = setup({ env: { XAI_API_KEY: ENV_XAI } });
    await a.rt.refresh();
    expect(await providerRow("xai")).toMatchObject({ envLast4: "8888", models: [], modelsFrom: "failed:env:8888" });
    expect(logs.filter((l) => l.level === "warn").map((l) => [l.obj, l.msg])).toEqual([[{ provider: "xai", key: "env", code: "key_rejected" }, "could not list the models of the AI key"]]);

    // Heartbeats and restarted workers (one per tick on Cloud Run) do not call the provider again within the hour.
    clock.advance(AI_REPORT_HEARTBEAT_MS);
    await a.rt.refresh();
    await setup({ env: { XAI_API_KEY: ENV_XAI } }).rt.refresh();
    expect(lister).toHaveBeenCalledTimes(1);

    clock.advance(MODELS_RETRY_MS);
    await a.rt.refresh();
    expect(lister).toHaveBeenCalledTimes(2);
    expect(await providerRow("xai")).toMatchObject({ envLast4: "8888", models: MODELS, modelsFrom: "env:8888" });

    // A later failure for the same key keeps the list it had.
    lister.mockRejectedValueOnce(new ModelListError("unreachable"));
    clock.advance(MODELS_MAX_AGE_MS);
    await a.rt.refresh();
    expect(await providerRow("xai")).toMatchObject({ models: MODELS, modelsFrom: "failed:env:8888" });

    // The worker restarts without XAI_API_KEY.
    await setup().rt.refresh();
    expect(await providerRow("xai")).toMatchObject({ envLast4: null, models: [], modelsFrom: null, modelsListedAt: null });
  });

  it("a fixed extractor (tests) is never rebuilt; reports still run", async () => {
    const fixed: Extractor = { name: "fixed", pipelineVersion: "f", extract: async () => Promise.reject(new Error("unused")) };
    const { rt, createExtractor } = setup({ fixed });
    await rt.refresh();
    expect(rt.extractor).toBe(fixed);
    expect(createExtractor).not.toHaveBeenCalled();
    expect((await settingsRow()).workerReport).toMatchObject({ mode: "mock", reason: "no_key" });
  });
});
