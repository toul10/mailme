import { describe, expect, it } from "vitest";
import { AI_KEY_ENV } from "../../src/ai/providers.js";
import { describeAi, envKeysFrom, resolveAi, type ResolveAiInput } from "../../src/ai/resolve.js";

const base = (over: Partial<ResolveAiInput> = {}): ResolveAiInput => ({
  aiMode: "auto",
  defaultModel: "claude-opus-5",
  envKeys: {},
  selection: null,
  storedKey: () => null,
  ...over,
});

describe("resolveAi: which extractor runs", () => {
  it("AI_MODE=mock is the kill switch, whatever was chosen and whatever keys exist", () => {
    const r = resolveAi(base({ aiMode: "mock", envKeys: { anthropic: "env-key" }, selection: { provider: "openai", model: "gpt-x" }, storedKey: () => "stored" }));
    expect(r).toEqual({ kind: "mock", reason: "ai_mode_mock", provider: null });
  });

  it("nothing chosen: Claude with AI_MODEL when the environment has ANTHROPIC_API_KEY, else the free mock (a fresh install)", () => {
    expect(resolveAi(base({ envKeys: { anthropic: "env-key" } }))).toEqual({ kind: "provider", provider: "anthropic", model: "claude-opus-5", source: "env", apiKey: "env-key" });
    expect(resolveAi(base())).toEqual({ kind: "mock", reason: "no_key", provider: null });
    // Another provider's environment key alone does not pick a model by itself.
    expect(resolveAi(base({ envKeys: { openai: "sk-env" } }))).toEqual({ kind: "mock", reason: "no_key", provider: null });
  });

  it("AI_MODE=claude from an older .env asks for Claude: with its key as auto; without one unavailable, not the mock", () => {
    expect(resolveAi(base({ aiMode: "claude", envKeys: { anthropic: "k" } }))).toMatchObject({ kind: "provider", provider: "anthropic" });
    expect(resolveAi(base({ aiMode: "claude" }))).toEqual({ kind: "unavailable", reason: "no_key", provider: "anthropic" });
    expect(resolveAi(base({ aiMode: "claude", selection: { provider: "mock", model: null } }))).toMatchObject({ kind: "mock", reason: "off" });
  });

  it("Off in Admin → AI runs the mock even with keys", () => {
    expect(resolveAi(base({ envKeys: { anthropic: "k" }, selection: { provider: "mock", model: null } }))).toEqual({ kind: "mock", reason: "off", provider: null });
  });

  it("a chosen provider uses its environment key first, then the stored one", () => {
    const sel = { provider: "openai", model: "gpt-6.1-terra" };
    expect(resolveAi(base({ selection: sel, envKeys: { openai: "sk-env" }, storedKey: () => "sk-stored" }))).toEqual({
      kind: "provider",
      provider: "openai",
      model: "gpt-6.1-terra",
      source: "env",
      apiKey: "sk-env",
    });
    expect(resolveAi(base({ selection: sel, storedKey: (p) => (p === "openai" ? "sk-stored" : null) }))).toEqual({
      kind: "provider",
      provider: "openai",
      model: "gpt-6.1-terra",
      source: "stored",
      apiKey: "sk-stored",
    });
  });

  it("a chosen provider without a key, or whose stored key cannot be opened, is unavailable (AI pauses), never the mock", () => {
    expect(resolveAi(base({ selection: { provider: "gemini", model: "gemini-4-argon" } }))).toEqual({ kind: "unavailable", reason: "no_key", provider: "gemini" });
    // Not even with another provider's key at hand: the admin chose Gemini.
    expect(resolveAi(base({ selection: { provider: "gemini", model: "gemini-4-argon" }, envKeys: { anthropic: "k" } }))).toMatchObject({ kind: "unavailable", provider: "gemini" });
    const unreadable = resolveAi(
      base({
        selection: { provider: "xai", model: "grok-4.7" },
        storedKey: () => {
          throw new Error("decrypt failed");
        },
      }),
    );
    expect(unreadable).toEqual({ kind: "unavailable", reason: "key_unreadable", provider: "xai" });
  });

  it("a chosen provider without a model: Claude falls back to AI_MODEL, the others are unavailable", () => {
    expect(resolveAi(base({ selection: { provider: "anthropic", model: null }, envKeys: { anthropic: "k" } }))).toMatchObject({ kind: "provider", model: "claude-opus-5" });
    expect(resolveAi(base({ selection: { provider: "openai", model: "  " }, envKeys: { openai: "k" } }))).toEqual({ kind: "unavailable", reason: "no_model", provider: "openai" });
  });

  it("an unknown saved provider counts as never chosen", () => {
    expect(resolveAi(base({ selection: { provider: "acme", model: "x" }, envKeys: { anthropic: "k" } }))).toMatchObject({ kind: "provider", provider: "anthropic", source: "env" });
  });

  it("envKeysFrom reads the four variables, trimmed, and drops empty ones (compose blanks them for the API)", () => {
    const env = { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "  sk-1 ", GEMINI_API_KEY: "g", XAI_API_KEY: undefined };
    expect(envKeysFrom(env, AI_KEY_ENV)).toEqual({ openai: "sk-1", gemini: "g" });
  });

  it("describeAi never carries the key, and names an unavailable provider", () => {
    const d = describeAi(resolveAi(base({ envKeys: { anthropic: "secret-key-1234" } })));
    expect(d).toEqual({ mode: "provider", provider: "anthropic", model: "claude-opus-5", source: "env", reason: null });
    expect(JSON.stringify(d)).not.toContain("secret-key");
    expect(describeAi({ kind: "unavailable", reason: "key_unreadable", provider: "xai" })).toEqual({ mode: "unavailable", provider: "xai", model: null, source: null, reason: "key_unreadable" });
    expect(describeAi({ kind: "mock", reason: "off", provider: null })).toEqual({ mode: "mock", provider: null, model: null, source: null, reason: "off" });
  });
});
