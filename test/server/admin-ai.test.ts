import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelListError, type AiModelOption, type ModelLister } from "../../src/ai/providers.js";
import { openAiKey } from "../../src/ai/settings.js";
import * as s from "../../src/db/schema.js";
import { GLOBAL_PAUSE_KEY } from "../../src/domain/types.js";
import type { AdminAi, AdminAiModels } from "../../src/server/api-types.js";
import { addUser, api, makeHarness, sessionFor, type Harness, type Session } from "./helpers.js";

const KEY = "fake-openai-KEY-0123456789-wxyz-abcd";
const KEY2 = "fake-openai-OTHER-9876543210-efgh";
const MODELS: AiModelOption[] = [
  { id: "gpt-6.1-terra", label: "gpt-6.1-terra" },
  { id: "gpt-6-luna", label: "gpt-6-luna" },
];

/** Admin → AI: provider, model and write-only keys (src/server/routes/admin-ai.ts). */
describe("admin AI settings", () => {
  let h: Harness;
  let root: Session;
  let rootId: string;
  let lister: ReturnType<typeof vi.fn<ModelLister>>;

  beforeEach(async () => {
    lister = vi.fn<ModelLister>(async () => MODELS);
    h = await makeHarness({ listModels: (...a) => lister(...a) });
    const [adminOrg] = await h.t.db.insert(s.organizations).values({ name: "MailMe", internalDomains: [] }).returning();
    const u = await addUser(h, { email: "admin@example.com", orgId: adminOrg!.id });
    await h.t.db.update(s.users).set({ platformAdmin: true }).where(eq(s.users.id, u.id));
    rootId = u.id;
    root = await sessionFor(h, u.id);
  });
  afterEach(async () => {
    // No key, in any test, ever reaches a log line.
    const logs = JSON.stringify(h.logs);
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(KEY2);
    await h.close();
  });

  const get = async () => (await api(h, root, "GET", "/api/admin/ai")).json() as AdminAi;
  const auditRows = () => h.t.db.select().from(s.securityAudit);
  const providerRow = async (p: "anthropic" | "openai" | "gemini" | "xai") => (await h.t.db.select().from(s.aiProviders).where(eq(s.aiProviders.provider, p)))[0];
  const settings = async () => (await h.t.db.select().from(s.aiSettings))[0];

  it("is only for platform admins (an org admin or a member gets 403, a half session 401)", async () => {
    const orgAdmin = await addUser(h, { email: "boss@contoso.example", role: "admin" });
    for (const [method, url, body] of [
      ["GET", "/api/admin/ai", undefined],
      ["POST", "/api/admin/ai/models", { provider: "openai", apiKey: KEY }],
      ["PUT", "/api/admin/ai", { provider: "mock" }],
      ["DELETE", "/api/admin/ai/keys/openai", undefined],
    ] as const) {
      expect((await api(h, await sessionFor(h, orgAdmin.id), method, url, body)).statusCode).toBe(403);
      expect((await api(h, await sessionFor(h, h.seed.user.id), method, url, body)).statusCode).toBe(403);
      expect((await api(h, await sessionFor(h, rootId, false), method, url, body)).statusCode).toBe(401);
    }
    expect(lister).not.toHaveBeenCalled();
  });

  it("starts with nothing chosen, four providers without keys, no worker report and the configured caps", async () => {
    const v = await get();
    expect(v.selection).toBeNull();
    expect(v.worker).toBeNull();
    expect(v.paused).toBeNull();
    expect(v.caps).toEqual({ dailyCalls: h.config.AI_DAILY_CALL_CAP, dailyUsd: h.config.AI_DAILY_USD_CAP });
    expect(v.providers.map((p) => [p.id, p.label, p.key, p.models])).toEqual([
      ["anthropic", "Claude (Anthropic)", null, []],
      ["openai", "OpenAI", null, []],
      ["gemini", "Gemini (Google)", null, []],
      ["xai", "Grok (xAI)", null, []],
    ]);
    expect(v.providers.every((p) => p.keyUrl.startsWith("https://"))).toBe(true);
  });

  it("lists a pasted key's models without storing anything, and audits only the last four characters", async () => {
    const res = await api(h, root, "POST", "/api/admin/ai/models", { provider: "openai", apiKey: ` ${KEY} ` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as AdminAiModels).models).toEqual(MODELS);
    expect(lister).toHaveBeenCalledWith("openai", KEY, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    expect(await h.t.db.select().from(s.aiProviders)).toEqual([]);
    expect(await h.t.db.select().from(s.aiSettings)).toEqual([]);
    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.detail])).toEqual([["admin.ai_models_list", { provider: "openai", last4: "abcd", models: 2 }]]);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("turns listing failures into its own messages; a provider error that echoes the key never leaves the server", async () => {
    lister.mockRejectedValueOnce(new ModelListError("key_rejected", 401));
    const rejected = await api(h, root, "POST", "/api/admin/ai/models", { provider: "openai", apiKey: KEY });
    expect([rejected.statusCode, rejected.json()]).toEqual([400, { code: "invalid", error: "OpenAI rejected this key." }]);

    lister.mockRejectedValueOnce(new ModelListError("unreachable"));
    const down = await api(h, root, "POST", "/api/admin/ai/models", { provider: "gemini", apiKey: KEY });
    expect([down.statusCode, (down.json() as { error: string }).error]).toEqual([502, "Could not reach Gemini (Google). Try again."]);

    lister.mockRejectedValueOnce(new ModelListError("rate_limited", 429));
    expect((await api(h, root, "POST", "/api/admin/ai/models", { provider: "xai", apiKey: KEY })).statusCode).toBe(429);

    // A lister bug whose message carries the key: a generic 502, the key in neither the response nor the logs.
    lister.mockRejectedValueOnce(new Error(`Incorrect API key provided: ${KEY}`));
    const bug = await api(h, root, "POST", "/api/admin/ai/models", { provider: "openai", apiKey: KEY });
    expect(bug.statusCode).toBe(502);
    expect(bug.body).not.toContain(KEY);
    expect(bug.body).not.toContain("Incorrect");

    // Malformed input: the field is named, the value never echoed.
    const bad = await api(h, root, "POST", "/api/admin/ai/models", { provider: "openai", apiKey: "has spaces in it" });
    expect([bad.statusCode, (bad.json() as { error: string }).error]).toEqual([400, "Invalid data (apiKey)"]);
    expect((await api(h, root, "POST", "/api/admin/ai/models", { provider: "acme", apiKey: KEY })).statusCode).toBe(400);
  });

  it("saves a key sealed for the worker and the choice, write-only: no response carries the key or its sealed form", async () => {
    const res = await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY });
    expect(res.statusCode).toBe(200);
    const v = res.json() as AdminAi;
    expect(v.selection).toMatchObject({ provider: "openai", model: "gpt-6.1-terra" });
    const openai = v.providers.find((p) => p.id === "openai")!;
    expect(openai.key).toEqual({ source: "stored", last4: "abcd", setAt: h.clock.now().toISOString(), setBy: expect.any(String) });
    expect(openai.models).toEqual(MODELS);

    const row = await providerRow("openai");
    expect(row!.keySealed).toBeTruthy();
    expect(row!.keySealed).not.toContain(KEY);
    // Only the private key opens it, and only as an OpenAI key (the aad binds the provider).
    expect(openAiKey("openai", row!.keySealed!, h.keys)).toBe(KEY);
    expect(() => openAiKey("xai", row!.keySealed!, h.keys)).toThrow();
    expect((await settings())!).toMatchObject({ provider: "openai", model: "gpt-6.1-terra", version: 1, updatedBy: rootId });

    for (const body of [res.body, (await api(h, root, "GET", "/api/admin/ai")).body]) {
      expect(body).not.toContain(KEY);
      expect(body).not.toContain(row!.keySealed!);
      expect(body).not.toContain(row!.keySealed!.slice(0, 24));
    }
    const rows = await auditRows();
    expect(rows.map((r) => [r.event, r.detail])).toEqual([
      ["admin.ai_key_set", { provider: "openai", last4: "abcd" }],
      ["admin.ai_select", { provider: "openai", model: "gpt-6.1-terra" }],
    ]);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("rejects a model the key did not list, a provider without a key, and a key the provider refuses (nothing stored)", async () => {
    const notListed = await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-unknown", apiKey: KEY });
    expect(notListed.statusCode).toBe(400);
    expect(await providerRow("openai")).toBeUndefined();

    const noKey = await api(h, root, "PUT", "/api/admin/ai", { provider: "gemini", model: "gemini-4-argon" });
    expect([noKey.statusCode, (noKey.json() as { error: string }).error]).toEqual([400, "Add a key for Gemini (Google) first."]);

    const noModel = await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", apiKey: KEY });
    expect([noModel.statusCode, (noModel.json() as { error: string }).error]).toEqual([400, "Choose a model."]);

    lister.mockRejectedValueOnce(new ModelListError("key_rejected", 401));
    const refused = await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY });
    expect(refused.statusCode).toBe(400);
    expect(await providerRow("openai")).toBeUndefined();
    expect(await settings()).toBeUndefined();
  });

  it("changes the model later from the stored list without the key; every change bumps the version", async () => {
    await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY });
    lister.mockClear();
    const res = await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6-luna" });
    expect(res.statusCode).toBe(200);
    expect(lister).not.toHaveBeenCalled();
    expect((await settings())!).toMatchObject({ model: "gpt-6-luna", version: 2 });
    await api(h, root, "PUT", "/api/admin/ai", { provider: "mock" });
    expect((await settings())!).toMatchObject({ provider: "mock", model: null, version: 3 });
    expect((await get()).selection).toMatchObject({ provider: "mock", model: null });
    // The stored key stays for a later switch back.
    expect((await providerRow("openai"))!.keySealed).toBeTruthy();
  });

  it("an environment key wins: shown with its last four, not replaceable here, and a model id is accepted before the worker lists models", async () => {
    await h.t.db.insert(s.aiProviders).values({ provider: "xai", envLast4: "9z9z" });
    const v = await get();
    expect(v.providers.find((p) => p.id === "xai")!.key).toEqual({ source: "env", last4: "9z9z" });

    const replace = await api(h, root, "PUT", "/api/admin/ai", { provider: "xai", model: "grok-4.7", apiKey: KEY });
    expect([replace.statusCode, (replace.json() as { error: string }).error]).toEqual([400, "Grok (xAI)'s key comes from the server environment (XAI_API_KEY). Change it there."]);
    expect(lister).not.toHaveBeenCalled();

    expect((await api(h, root, "PUT", "/api/admin/ai", { provider: "xai", model: "grok-4.7" })).statusCode).toBe(200);
    expect((await api(h, root, "PUT", "/api/admin/ai", { provider: "xai", model: "bad id with spaces" })).statusCode).toBe(400);
  });

  it("after the worker's listing failed, the older list is shown without a listing date", async () => {
    await h.t.db.insert(s.aiProviders).values({ provider: "gemini", envLast4: "g0g0", models: MODELS, modelsListedAt: h.clock.now(), modelsFrom: "failed:env:g0g0" });
    const gemini = (await get()).providers.find((p) => p.id === "gemini")!;
    expect([gemini.models, gemini.modelsListedAt]).toEqual([MODELS, null]);
  });

  it("a saved key or choice clears a global pause the extractor set, not one after an internal error", async () => {
    const pause = (reason: string) =>
      h.t.db.insert(s.appState).values({ key: GLOBAL_PAUSE_KEY, value: { reason, at: "2026-09-15T06:00:00.000Z", error: "http_401:authentication_error" } });
    await pause("extractor");
    expect((await get()).paused).toEqual({ reason: "extractor", since: "2026-09-15T06:00:00.000Z" });
    await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY });
    expect(await h.t.db.select().from(s.appState).where(eq(s.appState.key, GLOBAL_PAUSE_KEY))).toEqual([]);
    expect((await auditRows()).map((r) => [r.event, r.detail]).at(-1)).toEqual(["admin.ai_resume", { error: "http_401:authentication_error" }]);

    await pause("internal_error");
    await api(h, root, "PUT", "/api/admin/ai", { provider: "mock" });
    expect((await get()).paused).toMatchObject({ reason: "internal_error" });
  });

  it("removes a stored key (and the models it listed), bumping the version; a second removal is a 404", async () => {
    await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY });
    const res = await api(h, root, "DELETE", "/api/admin/ai/keys/openai");
    expect(res.statusCode).toBe(200);
    const openai = (res.json() as AdminAi).providers.find((p) => p.id === "openai")!;
    expect([openai.key, openai.models]).toEqual([null, []]);
    expect(await providerRow("openai")).toMatchObject({ keySealed: null, keyLast4: null, models: [] });
    expect((await settings())!.version).toBe(2);
    expect((await auditRows()).map((r) => [r.event, r.detail]).at(-1)).toEqual(["admin.ai_key_delete", { provider: "openai", last4: "abcd" }]);
    expect((await api(h, root, "DELETE", "/api/admin/ai/keys/openai")).statusCode).toBe(404);
    expect((await api(h, root, "DELETE", "/api/admin/ai/keys/acme")).statusCode).toBe(404);
  });

  it("replacing a key keeps one sealed key per provider and audits the new last four", async () => {
    await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY });
    await api(h, root, "PUT", "/api/admin/ai", { provider: "openai", model: "gpt-6.1-terra", apiKey: KEY2 });
    const rows = await h.t.db.select().from(s.aiProviders);
    expect(rows).toHaveLength(1);
    expect(openAiKey("openai", rows[0]!.keySealed!, h.keys)).toBe(KEY2);
    expect(rows[0]!.keyLast4).toBe("efgh");
  });

  it("rate-limits model listing per admin (each one is a provider call)", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await api(h, root, "POST", "/api/admin/ai/models", { provider: "openai", apiKey: KEY })).statusCode;
    expect(last).toBe(429);
    expect(lister).toHaveBeenCalledTimes(30);
  });
});
