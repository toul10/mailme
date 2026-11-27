import { describe, expect, it } from "vitest";
import type { AdminAi, AdminAiProvider } from "../../src/server/api-types.js";
import { ApiRequestError } from "../../web/src/api.js";
import {
  aiErrorText,
  applyPending,
  capsText,
  costNote,
  currentModel,
  freeModelHint,
  IDLE,
  initialChoice,
  keyProblem,
  keyStatusText,
  modelField,
  modelsNote,
  pauseBanner,
  pauseReasonText,
  pickModel,
  qualityNote,
  safeKeyUrl,
  saveBlocker,
  saveRequest,
  savedChoiceText,
  shouldLoadModels,
  workerStatus,
  type AiFormValues,
} from "../../web/src/ai-form.js";

const KEY = "fake-key-0123456789abcdefghij"; // 28 characters, not a real key
const M1 = { id: "model-new", label: "Model New" };
const M2 = { id: "model-old", label: "Model Old" };

function provider(over: Partial<AdminAiProvider> & Pick<AdminAiProvider, "id">): AdminAiProvider {
  return { label: over.id.toUpperCase(), keyUrl: `https://${over.id}.example/keys`, key: null, models: [], modelsListedAt: null, ...over };
}

function state(over: Partial<AdminAi> = {}): AdminAi {
  return {
    selection: null,
    providers: [provider({ id: "anthropic", label: "Claude (Anthropic)" }), provider({ id: "openai", label: "OpenAI" }), provider({ id: "gemini", label: "Gemini (Google)" }), provider({ id: "xai", label: "Grok (xAI)" })],
    worker: null,
    paused: null,
    caps: { dailyCalls: 150, dailyUsd: 10, earlyFactor: 5 },
    ...over,
  };
}

const form = (over: Partial<AiFormValues> = {}): AiFormValues => ({ choice: "openai", model: "", apiKey: "", listing: IDLE, ...over });

describe("Admin → AI: when a pasted key is checked", () => {
  it("checks only a whole key: 20+ characters, no spaces, at most 512", () => {
    expect(shouldLoadModels("")).toBe(false);
    expect(shouldLoadModels("   ")).toBe(false);
    expect(shouldLoadModels("sk-short")).toBe(false);
    expect(shouldLoadModels("x".repeat(19))).toBe(false);
    expect(shouldLoadModels("x".repeat(20))).toBe(true);
    expect(shouldLoadModels(`  ${KEY}\n`)).toBe(true); // pasted with whitespace around it
    expect(shouldLoadModels(`Bearer ${KEY}`)).toBe(false);
    expect(shouldLoadModels("x".repeat(512))).toBe(true);
    expect(shouldLoadModels("x".repeat(513))).toBe(false);
  });

  it("says why a typed key isn't checked", () => {
    expect(keyProblem("")).toBeNull();
    expect(keyProblem(KEY)).toBeNull();
    expect(keyProblem("sk-short")).toMatch(/too short/);
    expect(keyProblem(`Bearer ${KEY}`)).toMatch(/no spaces/);
    expect(keyProblem("x".repeat(600))).toMatch(/longer than any key/);
  });
});

describe("Admin → AI: the model", () => {
  it("preselects the current model when listed, else the first (newest) one", () => {
    expect(pickModel([M1, M2], "model-old")).toBe("model-old");
    expect(pickModel([M1, M2], "gone")).toBe("model-new");
    expect(pickModel([M1, M2], null)).toBe("model-new");
    expect(pickModel([], "typed-id")).toBe("typed-id");
    expect(pickModel([], null)).toBe("");
  });

  it("the current model is the saved one, else what the worker runs", () => {
    const worker = { mode: "provider" as const, provider: "anthropic" as const, model: "claude-x", source: "env" as const, reason: null, at: "2026-11-14T10:00:00Z" };
    expect(currentModel(state({ worker }), "anthropic")).toBe("claude-x");
    expect(currentModel(state({ worker }), "openai")).toBeNull();
    const selection = { provider: "openai" as const, model: "gpt-x", updatedAt: "2026-11-14T10:00:00Z" };
    expect(currentModel(state({ worker, selection }), "openai")).toBe("gpt-x");
  });

  it("shows a pasted key's own list once checked, else the saved list; a free id only for an unlisted environment key", () => {
    const saved = provider({ id: "openai", key: { source: "stored", last4: "abcd", setAt: "2026-11-14T10:00:00Z", setBy: null }, models: [M2] });
    expect(modelField(saved, "", IDLE)).toEqual({ kind: "select", options: [M2] });
    expect(modelField(saved, KEY, { state: "loading" })).toMatchObject({ kind: "wait" });
    expect(modelField(saved, KEY, { state: "ok", models: [M1] })).toEqual({ kind: "select", options: [M1] });
    expect(modelField(saved, KEY, { state: "ok", models: [] })).toMatchObject({ kind: "error" });
    expect(modelField(saved, KEY, { state: "error", message: "OpenAI rejected this key." })).toEqual({ kind: "error", text: "OpenAI rejected this key." });
    expect(modelField(saved, "sk-short", IDLE)).toMatchObject({ kind: "wait" });
    expect(modelField(provider({ id: "gemini" }), "", IDLE)).toMatchObject({ kind: "wait", text: expect.stringMatching(/Paste a key/) });
    expect(modelField(provider({ id: "anthropic", key: { source: "env", last4: null } }), "", IDLE)).toEqual({ kind: "text" });
  });
});

describe("Admin → AI: the saved model list", () => {
  const when = (iso: string) => `on ${iso.slice(0, 10)}`;
  const stored = { source: "stored" as const, last4: "abcd", setAt: "2026-11-14T10:00:00Z", setBy: null };
  const env = { source: "env" as const, last4: "wxyz" };

  it("says when it was listed, that the worker reloads it daily, and that pasting a typed key reloads it now", () => {
    expect(modelsNote(provider({ id: "openai", key: stored, models: [M1], modelsListedAt: "2026-11-14T09:00:00Z" }), when)).toBe(
      "Listed on 2026-11-14. The worker reloads the list once a day. Paste the key again to reload it now.",
    );
    // An environment key can't be pasted here.
    expect(modelsNote(provider({ id: "anthropic", key: env, models: [M1], modelsListedAt: "2026-11-14T09:00:00Z" }), when)).toBe(
      "Listed on 2026-11-14. The worker reloads the list once a day.",
    );
  });

  it("a failed reload keeps the older list and says the worker retries within the hour", () => {
    expect(modelsNote(provider({ id: "openai", key: stored, models: [M1], modelsListedAt: null }), when)).toMatch(/last reload of this list failed; the worker tries again within an hour\. Paste the key again/);
    expect(modelsNote(provider({ id: "anthropic", key: env, models: [M1], modelsListedAt: null }), when)).not.toMatch(/Paste/);
    expect(modelsNote(provider({ id: "openai", key: stored, models: [] }), when)).toBeNull();
    expect(modelsNote(provider({ id: "openai", models: [M1] }), when)).toBeNull();
  });

  it("explains a model id typed by hand, also under the AI_MODE=mock kill switch (no listing at all)", () => {
    const at = "2026-11-14T10:00:00Z";
    expect(freeModelHint(state())).toMatch(/hasn't listed this key's models yet/);
    expect(freeModelHint(state({ worker: { mode: "mock", provider: null, model: null, source: null, reason: "ai_mode_mock", at } }))).toMatch(/AI_MODE=mock the worker lists no models/);
  });
});

describe("Admin → AI: saving", () => {
  const none = provider({ id: "openai", label: "OpenAI" });
  const stored = provider({ id: "openai", label: "OpenAI", key: { source: "stored", last4: "abcd", setAt: "2026-11-14T10:00:00Z", setBy: null }, models: [M1, M2] });
  const env = provider({ id: "anthropic", label: "Claude (Anthropic)", key: { source: "env", last4: "wxyz" } });

  it("turning AI off always works, and sends no model or key", () => {
    expect(saveBlocker(null, form({ choice: "mock" }))).toBeNull();
    expect(saveRequest(null, { choice: "mock", model: "x", apiKey: KEY })).toEqual({ provider: "mock", model: null });
  });

  it("needs a key: typed and checked, saved, or in the environment", () => {
    expect(saveBlocker(none, form())).toBe("Paste a key for OpenAI first.");
    expect(saveBlocker(none, form({ apiKey: KEY }))).toMatch(/Wait until the models have loaded/);
    expect(saveBlocker(none, form({ apiKey: KEY, listing: { state: "loading" } }))).toMatch(/Wait until/);
    expect(saveBlocker(none, form({ apiKey: KEY, listing: { state: "error", message: "OpenAI rejected this key." } }))).toBe("OpenAI rejected this key.");
    expect(saveBlocker(none, form({ apiKey: "sk-short" }))).toMatch(/too short/);
    expect(saveBlocker(none, form({ apiKey: KEY, model: "model-new", listing: { state: "ok", models: [M1] } }))).toBeNull();
    expect(saveBlocker(stored, form({ model: "model-old" }))).toBeNull();
  });

  it("needs a model from the list in use, or a valid id for an unlisted environment key", () => {
    expect(saveBlocker(stored, form({ model: "" }))).toBe("Choose a model.");
    expect(saveBlocker(stored, form({ model: "not-listed" }))).toBe("Choose a model.");
    // The pasted key's list replaces the saved one.
    expect(saveBlocker(stored, form({ apiKey: KEY, model: "model-old", listing: { state: "ok", models: [M1] } }))).toBe("Choose a model.");
    expect(saveBlocker(env, form({ choice: "anthropic", model: "" }))).toMatch(/model's id/);
    expect(saveBlocker(env, form({ choice: "anthropic", model: "bad id!" }))).toMatch(/model's id/);
    expect(saveBlocker(env, form({ choice: "anthropic", model: "claude-opus-5" }))).toBeNull();
  });

  it("sends the key only when typed, trimmed, and never for an environment key", () => {
    expect(saveRequest(stored, { choice: "openai", model: " model-new ", apiKey: "" })).toEqual({ provider: "openai", model: "model-new" });
    expect(saveRequest(stored, { choice: "openai", model: "model-new", apiKey: `  ${KEY}\n` })).toEqual({ provider: "openai", model: "model-new", apiKey: KEY });
    expect(saveRequest(env, { choice: "anthropic", model: "claude-opus-5", apiKey: KEY })).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect(saveBlocker(env, form({ choice: "anthropic", model: "claude-opus-5", apiKey: KEY }))).toMatch(/server environment/);
  });
});

describe("Admin → AI: what starts selected", () => {
  it("the saved choice, then the worker's provider, then the first with a key, then the first listed", () => {
    const at = "2026-11-14T10:00:00Z";
    expect(initialChoice(state({ selection: { provider: "mock", model: null, updatedAt: at } }))).toBe("mock");
    expect(initialChoice(state({ selection: { provider: "xai", model: "grok-x", updatedAt: at } }))).toBe("xai");
    expect(initialChoice(state({ worker: { mode: "provider", provider: "gemini", model: "g", source: "env", reason: null, at } }))).toBe("gemini");
    const withKey = state();
    withKey.providers[1] = provider({ id: "openai", key: { source: "env", last4: "1234" } });
    expect(initialChoice(withKey)).toBe("openai");
    expect(initialChoice(state())).toBe("anthropic");
  });
});

describe("Admin → AI: status lines", () => {
  const at = "2026-11-14T10:00:00Z";

  it("names the running provider, model and key source", () => {
    const s = workerStatus(state({ worker: { mode: "provider", provider: "anthropic", model: "claude-x", source: "env", reason: null, at } }));
    expect(s).toEqual({ tone: "ai", text: "Running: Claude (Anthropic) · claude-x · key from the environment", detail: null });
    expect(workerStatus(state({ worker: { mode: "provider", provider: "openai", model: "gpt-x", source: "stored", reason: null, at } })).text).toBe("Running: OpenAI · gpt-x · key from Admin");
  });

  it("explains why the free mock runs", () => {
    const mock = (reason: string | null) => workerStatus(state({ worker: { mode: "mock", provider: null, model: null, source: null, reason, at } }));
    expect(mock("ai_mode_mock")).toMatchObject({ tone: "mock", text: "Free mock (no AI)", detail: expect.stringMatching(/AI_MODE=mock .*calls no AI provider at all/) });
    expect(mock("off").detail).toMatch(/turned off here/);
    // A mock "no_key": nothing is chosen and there is no key (a chosen provider without one pauses instead).
    expect(mock("no_key").detail).toMatch(/No AI is chosen here yet/);
    expect(mock("something_new").detail).toBe("Reason: something_new.");
    expect(mock(null).detail).toBeNull();
  });

  it("before the worker reports, shows the saved choice", () => {
    expect(workerStatus(state())).toMatchObject({ tone: "unknown", text: "The worker has not reported yet.", detail: expect.stringMatching(/No choice saved yet/) });
    expect(savedChoiceText(state({ selection: { provider: "openai", model: "gpt-x", updatedAt: at } }))).toBe("Saved choice: OpenAI · gpt-x.");
    expect(savedChoiceText(state({ selection: { provider: "mock", model: null, updatedAt: at } }))).toBe("Saved choice: off (free mock).");
  });

  it("a choice saved after the worker's last report is pending", () => {
    const worker = { mode: "mock" as const, provider: null, model: null, source: null, reason: "no_key", at };
    expect(applyPending(state({ worker, selection: { provider: "openai", model: "m", updatedAt: "2026-11-14T10:05:00Z" } }))).toBe(true);
    expect(applyPending(state({ worker, selection: { provider: "openai", model: "m", updatedAt: "2026-11-14T09:55:00Z" } }))).toBe(false);
    expect(applyPending(state({ selection: { provider: "openai", model: "m", updatedAt: at } }))).toBe(false);
    expect(applyPending(state({ worker }))).toBe(false);
  });

  it("describes a key by its last four characters only", () => {
    const when = (iso: string) => `on ${iso.slice(0, 10)}`;
    expect(keyStatusText(null, when)).toBe("No key");
    expect(keyStatusText({ source: "env", last4: "wxyz" }, when)).toBe("From the server environment (…wxyz)");
    expect(keyStatusText({ source: "env", last4: null }, when)).toBe("From the server environment");
    expect(keyStatusText({ source: "stored", last4: "abcd", setAt: at, setBy: null }, when)).toBe("Saved key …abcd · on 2026-11-14");
    expect(keyStatusText({ source: "stored", last4: "abcd", setAt: at, setBy: "Admin" }, when)).toBe("Saved key …abcd · on 2026-11-14 · by Admin");
  });

  it("puts the pause reason, caps, cost and quality into words", () => {
    expect(pauseReasonText("extractor")).toMatch(/provider couldn't be used/);
    expect(pauseReasonText("internal_error")).toMatch(/internal error/);
    expect(pauseReasonText("Billing problem")).toBe("Billing problem");
    expect(capsText({ dailyCalls: 150, dailyUsd: 10, earlyFactor: 5 })).toMatch(/150 AI calls and about \$10 a day/);
    expect(capsText({ dailyCalls: 150, dailyUsd: 10, earlyFactor: 5 })).toMatch(/already in a mailbox when it was added has limits of its own, 5 times these/);
    expect(capsText({ dailyCalls: 1, dailyUsd: 2.5, earlyFactor: 5 })).toMatch(/1 AI call and about \$2\.50 a day/);
    expect(costNote("openai", "OpenAI")).toMatch(/\$10 per million input tokens and \$50 per million output tokens/);
    expect(costNote("gemini", "Gemini (Google)")).toMatch(/Google's published prices.*call limit works the same for every provider/);
    expect(costNote("xai", "Grok (xAI)")).toMatch(/exact cost/);
    expect(costNote("mock", "")).toMatch(/costs nothing/);
    expect(qualityNote("anthropic", "Claude (Anthropic)")).toBeNull();
    expect(qualityNote("mock", "")).toBeNull();
    expect(qualityNote("xai", "Grok (xAI)")).toMatch(/measured with Claude\. Grok \(xAI\) runs the same prompt/);
  });
});

describe("Admin → AI: a chosen provider that can't run pauses AI", () => {
  const at = "2026-11-14T10:00:00Z";
  // The core's "unavailable" mode, ahead of the contract type.
  const unavailable = (reason: string, provider = "openai") =>
    ({ mode: "unavailable", provider, model: null, source: null, reason, at }) as unknown as AdminAi["worker"];
  const chosen = { provider: "openai" as const, model: "gpt-x", updatedAt: "2026-11-14T09:00:00Z" };

  it("the status line says it is paused, and why", () => {
    expect(workerStatus(state({ selection: chosen, worker: unavailable("no_key") }))).toEqual({ tone: "paused", text: "Paused: OpenAI can't run", detail: "No usable key for OpenAI." });
    expect(workerStatus(state({ selection: chosen, worker: unavailable("key_unreadable") })).detail).toMatch(/cannot decrypt the saved key for OpenAI \(were the credentials keys replaced\?\)/);
    expect(workerStatus(state({ selection: chosen, worker: unavailable("no_model") })).detail).toBe("No model is chosen for OpenAI.");
  });

  it("the banner names the problem and the fix, with the pause's start", () => {
    const paused = { reason: "extractor", since: "2026-11-14T09:30:00Z" };
    expect(pauseBanner(state({ selection: chosen, worker: unavailable("no_key"), paused }))).toEqual({
      text: "AI is paused: no usable key for OpenAI.",
      fix: "Add a key, choose another provider, or turn AI Off.",
      since: "2026-11-14T09:30:00Z",
      pending: null,
    });
    expect(pauseBanner(state({ selection: chosen, worker: unavailable("key_unreadable") }))).toMatchObject({ fix: "Paste the key again.", since: null });
    expect(pauseBanner(state({ selection: chosen, worker: unavailable("no_model") }))).toMatchObject({ text: "AI is paused: no model is chosen for OpenAI." });
    // AI_MODE=claude with nothing chosen and no ANTHROPIC_API_KEY.
    expect(pauseBanner(state({ worker: unavailable("no_key", "anthropic") }))?.text).toBe("AI is paused: no usable key for Claude (Anthropic).");
  });

  it("a global pause alone gets the banner too; only the extractor's is lifted by saving", () => {
    const running = { mode: "provider" as const, provider: "openai" as const, model: "gpt-x", source: "stored" as const, reason: null, at };
    expect(pauseBanner(state({ selection: chosen, worker: running, paused: { reason: "extractor", since: at } }))).toMatchObject({
      text: expect.stringMatching(/^AI is paused for every mailbox: the AI provider couldn't be used/),
      fix: "Saving a working key or choice here resumes it.",
    });
    expect(pauseBanner(state({ worker: running, paused: { reason: "internal_error", since: at } }))?.fix).toMatch(/pnpm cli ai:resume/);
    expect(pauseBanner(state({ selection: chosen, worker: running }))).toBeNull();
    expect(pauseBanner(state())).toBeNull();
  });

  it("right after a save the banner stays, until the worker's next report says otherwise", () => {
    const saved = { ...chosen, updatedAt: "2026-11-14T10:05:00Z" }; // after the report at 10:00
    expect(pauseBanner(state({ selection: saved, worker: unavailable("key_unreadable") }))).toMatchObject({
      text: expect.stringMatching(/cannot decrypt/),
      pending: "A change was saved after this report; the worker checks it on its next run.",
    });
  });

  it("starts with the provider the worker tried", () => {
    expect(initialChoice(state({ worker: unavailable("no_key", "anthropic") }))).toBe("anthropic");
  });
});

describe("Admin → AI: errors and links", () => {
  it("shows the server's own AI message instead of a generic one", () => {
    expect(aiErrorText(new ApiRequestError(400, "invalid", "OpenAI rejected this key."))).toBe("OpenAI rejected this key.");
    expect(aiErrorText(new ApiRequestError(502, "internal", "Could not reach OpenAI"))).toBe("Could not reach OpenAI");
    expect(aiErrorText(new ApiRequestError(502, "internal", null))).toBe("Server error (502).");
    expect(aiErrorText(new ApiRequestError(403, "forbidden", "nope"))).toBe("You don't have access to this.");
    expect(aiErrorText(new Error("x"))).toBe("Something went wrong. Try again.");
  });

  it("links only to https key pages", () => {
    expect(safeKeyUrl("https://platform.openai.com/api-keys")).toBe("https://platform.openai.com/api-keys");
    expect(safeKeyUrl("http://example.com")).toBeNull();
    expect(safeKeyUrl("javascript:alert(1)")).toBeNull();
    expect(safeKeyUrl("not a url")).toBeNull();
    expect(safeKeyUrl(null)).toBeNull();
  });
});
