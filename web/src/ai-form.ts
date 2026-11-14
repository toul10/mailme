/**
 * Admin → AI form model (web/src/screens/AdminAi.tsx). It decides:
 * - when a pasted key is checked, by listing its models;
 * - which model is preselected;
 * - what can be saved;
 * - the status lines.
 * Pure, so it is tested without a browser.
 *
 * A key lives only in the form's state:
 * - it goes to the server in a JSON body, never in a URL;
 * - it is never stored, shown in a toast or logged;
 * - it is cleared after a save, on a provider switch and when the page closes.
 */
import { MAX_API_KEY_LENGTH, MODEL_ID_RE } from "../../src/ai/providers.js";
import type { AdminAi, AdminAiKey, AdminAiProvider, AdminAiSave, AdminAiWorker, AiModelOptionView, AiProviderId } from "../../src/server/api-types.js";
import { errorMessage, isApiError } from "./api.js";
import { plural } from "./format.js";

/** A provider, or "mock": off, the free built-in rules. */
export type AiChoice = AiProviderId | "mock";

/** Shortest pasted text worth checking with the provider (real keys are 40–200 characters). */
export const MIN_KEY_LENGTH = 20;
/** Pause after the last change to the key field before the key is checked. */
export const MODEL_LIST_DELAY_MS = 600;

/** The models a pasted key listed, as the form tracks them. */
export type Listing = { state: "idle" } | { state: "loading" } | { state: "ok"; models: AiModelOptionView[] } | { state: "error"; message: string };

export const IDLE: Listing = { state: "idle" };

/** Why a typed key isn't checked, shown under the field; null when it is fine or empty. */
export function keyProblem(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  if (/\s/.test(key)) return "A key has no spaces. Paste only the key.";
  if (key.length < MIN_KEY_LENGTH) return "That is too short for a key. Paste the whole key.";
  if (key.length > MAX_API_KEY_LENGTH) return "That is longer than any key.";
  return null;
}

/** True when a typed key should be checked, by listing its models. */
export function shouldLoadModels(raw: string): boolean {
  return raw.trim() !== "" && keyProblem(raw) === null;
}

/** The model to preselect: the current one when the list has it, else the first (newest) one listed. */
export function pickModel(options: readonly AiModelOptionView[], current: string | null | undefined): string {
  if (current && options.some((o) => o.id === current)) return current;
  return options[0]?.id ?? current ?? "";
}

/**
 * The worker's report. Mode "unavailable": a provider is chosen but can't run (no usable key, a key it can't decrypt,
 * no model), so AI pauses instead of falling back to the mock; `provider` is set and `reason` says why.
 */
export type WorkerView = AdminAiWorker;

export function workerOf(ai: AdminAi): WorkerView | null {
  return ai.worker;
}

/** The model saved for a provider, else the one the worker runs it with. */
export function currentModel(ai: AdminAi, provider: AiProviderId): string | null {
  if (ai.selection?.provider === provider && ai.selection.model) return ai.selection.model;
  const w = workerOf(ai);
  if (w?.mode === "provider" && w.provider === provider) return w.model;
  return null;
}

/**
 * The provider to start with. In order:
 * 1. the saved choice;
 * 2. what the worker runs;
 * 3. the first provider with a key;
 * 4. the first provider listed.
 */
export function initialChoice(ai: AdminAi): AiChoice {
  if (ai.selection) return ai.selection.provider;
  const w = workerOf(ai);
  if (w && w.mode !== "mock" && w.provider) return w.provider;
  return ai.providers.find((p) => p.key)?.id ?? ai.providers[0]?.id ?? "mock";
}

/**
 * What the model field shows:
 * - "select": the models a pasted key listed once checked, else the list saved with the key;
 * - "text": a model id to type, for an environment key whose models the worker hasn't listed yet;
 * - "wait": a line explaining what comes first;
 * - "error": the reason the listing failed.
 */
export type ModelField = { kind: "select"; options: AiModelOptionView[] } | { kind: "text" } | { kind: "wait"; text: string } | { kind: "error"; text: string };

export function modelField(p: AdminAiProvider, typedKey: string, listing: Listing): ModelField {
  if (typedKey.trim()) {
    const problem = keyProblem(typedKey);
    if (problem) return { kind: "wait", text: "Paste the whole key: its models load on their own." };
    if (listing.state === "ok") return listing.models.length ? { kind: "select", options: listing.models } : { kind: "error", text: `${p.label} lists no text models for this key.` };
    if (listing.state === "error") return { kind: "error", text: listing.message };
    return { kind: "wait", text: "Loading the models…" };
  }
  if (p.models.length) return { kind: "select", options: p.models };
  if (p.key?.source === "env") return { kind: "text" };
  return { kind: "wait", text: "Paste a key: its models load on their own." };
}

/**
 * The line under a saved model list. The worker reloads the list of the key in use once a day, and an hour after a
 * failed try. `modelsListedAt` is null while the last reload failed; the older list is still shown. Pasting a typed
 * (stored) key again reloads it at once; an environment key can't be pasted here.
 */
export function modelsNote(p: AdminAiProvider, when: (iso: string) => string): string | null {
  if (!p.models.length || !p.key) return null;
  const now = p.key.source === "stored" ? " Paste the key again to reload it now." : "";
  if (!p.modelsListedAt) return `The last reload of this list failed; the worker tries again within an hour.${now}`;
  return `Listed ${when(p.modelsListedAt)}. The worker reloads the list once a day.${now}`;
}

/** The hint next to a model id typed by hand (an environment key the worker hasn't listed). */
export function freeModelHint(ai: AdminAi): string {
  if (ai.worker?.mode === "mock" && ai.worker.reason === "ai_mode_mock") {
    return "With AI_MODE=mock the worker lists no models, so type the model's id. It applies once AI_MODE is auto.";
  }
  return "The worker hasn't listed this key's models yet. Type the model's id, or come back once it has.";
}

export interface AiFormValues {
  choice: AiChoice;
  model: string;
  /** The key field, as typed. */
  apiKey: string;
  listing: Listing;
}

/** Why Save is off right now; null when the form can be saved. */
export function saveBlocker(p: AdminAiProvider | null, f: AiFormValues): string | null {
  if (f.choice === "mock") return null;
  if (!p) return "Choose a provider.";
  const typed = f.apiKey.trim();
  if (typed) {
    if (p.key?.source === "env") return `${p.label}'s key comes from the server environment.`;
    const problem = keyProblem(typed);
    if (problem) return problem;
    if (f.listing.state === "error") return f.listing.message;
    if (f.listing.state !== "ok") return "Wait until the models have loaded.";
  } else if (!p.key) {
    return `Paste a key for ${p.label} first.`;
  }
  const field = modelField(p, f.apiKey, f.listing);
  switch (field.kind) {
    case "select":
      return field.options.some((o) => o.id === f.model) ? null : "Choose a model.";
    case "text":
      return MODEL_ID_RE.test(f.model.trim()) ? null : "Type the model's id.";
    default:
      return field.text;
  }
}

/** The PUT body. The key is sent only when one was typed, trimmed, and never for an environment key. */
export function saveRequest(p: AdminAiProvider | null, f: Pick<AiFormValues, "choice" | "model" | "apiKey">): AdminAiSave {
  if (f.choice === "mock") return { provider: "mock", model: null };
  const key = f.apiKey.trim();
  return { provider: f.choice, model: f.model.trim(), ...(key && p?.key?.source !== "env" ? { apiKey: key } : {}) };
}

/** A provider's label, as the server names it. */
export function providerLabel(ai: AdminAi, id: AiProviderId | null): string {
  if (!id) return "AI";
  return ai.providers.find((p) => p.id === id)?.label ?? id;
}

/** Why the worker runs the free mock (AdminAiWorker.reason). */
export function mockReasonText(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case "ai_mode_mock":
      return "AI_MODE=mock is set on the server: the worker calls no AI provider at all, not even to list models. It overrides the choice here.";
    case "off":
      return "AI is turned off here.";
    case "no_key":
      return "No AI is chosen here yet, and the worker has no ANTHROPIC_API_KEY. Pick a provider and paste its key.";
    default:
      return `Reason: ${reason}.`;
  }
}

/** Why a chosen provider can't run (mode "unavailable"): AI is paused until this is fixed. */
export function unavailableText(reason: string | null, label: string): { problem: string; fix: string } {
  switch (reason) {
    case "key_unreadable":
      return { problem: `the worker cannot decrypt the saved key for ${label} (were the credentials keys replaced?)`, fix: "Paste the key again." };
    case "no_model":
      return { problem: `no model is chosen for ${label}`, fix: "Choose a model and save." };
    default:
      return { problem: `no usable key for ${label}`, fix: "Add a key, choose another provider, or turn AI Off." };
  }
}

/**
 * The banner at the top of Admin → AI whenever AI is paused or can't run. It is the one place that says so: a pause
 * nobody notices leaves mail unread for hours.
 */
export function pauseBanner(ai: AdminAi): { text: string; fix: string; since: string | null; pending: string | null } | null {
  const w = workerOf(ai);
  const since = ai.paused?.since ?? null;
  if (w?.mode === "unavailable") {
    const u = unavailableText(w.reason, providerLabel(ai, w.provider));
    // A change saved after this report may be the fix, but only the worker's next report can tell: keep the banner.
    const pending = applyPending(ai) ? "A change was saved after this report; the worker checks it on its next run." : null;
    return { text: `AI is paused: ${u.problem}.`, fix: u.fix, since, pending };
  }
  if (!ai.paused) return null;
  return {
    text: `AI is paused for every mailbox: ${pauseReasonText(ai.paused.reason)}.`,
    // The save clears a pause the extractor set (its fix); one after an internal error needs the command.
    fix: ai.paused.reason === "extractor" ? "Saving a working key or choice here resumes it." : "Once the cause is fixed, run pnpm cli ai:resume.",
    since,
    pending: null,
  };
}

export interface StatusLine {
  /** "ai" = a provider runs, "paused" = a chosen provider can't run, "mock" = the free mock, "unknown" = no report yet. */
  tone: "ai" | "paused" | "mock" | "unknown";
  text: string;
  detail: string | null;
}

/** What the worker reported running with. */
export function workerStatus(ai: AdminAi): StatusLine {
  const w = workerOf(ai);
  if (!w) return { tone: "unknown", text: "The worker has not reported yet.", detail: savedChoiceText(ai) };
  if (w.mode === "unavailable") {
    const label = providerLabel(ai, w.provider);
    return { tone: "paused", text: `Paused: ${label} can't run`, detail: `${capitalize(unavailableText(w.reason, label).problem)}.` };
  }
  if (w.mode === "provider") {
    const source = w.source === "env" ? "key from the environment" : w.source === "stored" ? "key from Admin" : null;
    const parts = [providerLabel(ai, w.provider), w.model, source].filter((s): s is string => Boolean(s));
    return { tone: "ai", text: `Running: ${parts.join(" · ")}`, detail: null };
  }
  return { tone: "mock", text: "Free mock (no AI)", detail: mockReasonText(w.reason) };
}

/** The saved choice, in words. */
export function savedChoiceText(ai: AdminAi): string {
  const s = ai.selection;
  if (!s) return "No choice saved yet: the worker uses Claude when it has ANTHROPIC_API_KEY, otherwise the free mock.";
  if (s.provider === "mock") return "Saved choice: off (free mock).";
  return `Saved choice: ${providerLabel(ai, s.provider)}${s.model ? ` · ${s.model}` : ""}.`;
}

/**
 * True when the choice was saved after the worker's last report, so the status line doesn't show it yet. The
 * worker picks it up on its next run.
 */
export function applyPending(ai: AdminAi): boolean {
  if (!ai.selection || !ai.worker) return false;
  const saved = Date.parse(ai.selection.updatedAt);
  const reported = Date.parse(ai.worker.at);
  return Number.isFinite(saved) && Number.isFinite(reported) && saved > reported;
}

/** A provider's key, in words. `when` formats the date it was saved. */
export function keyStatusText(key: AdminAiKey | null, when: (iso: string) => string): string {
  if (!key) return "No key";
  if (key.source === "env") return key.last4 ? `From the server environment (…${key.last4})` : "From the server environment";
  return `Saved key …${key.last4} · ${when(key.setAt)}${key.setBy ? ` · by ${key.setBy}` : ""}`;
}

/** The global AI pause reason (app_state ai_global_pause), in words. */
export function pauseReasonText(reason: string): string {
  switch (reason) {
    case "extractor":
      return "the AI provider couldn't be used (often the key, billing or a spending limit)";
    case "internal_error":
      return "an internal error in MailMe";
    default:
      return reason;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const usd = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** The per-mailbox daily limits. */
export function capsText(caps: AdminAi["caps"]): string {
  return (
    `Each mailbox may use up to ${plural(caps.dailyCalls, "AI call", "AI calls")} and about ${usd(caps.dailyUsd)} a day ` +
    "(AI_DAILY_CALL_CAP and AI_DAILY_USD_CAP). At a limit, AI pauses for that mailbox until local midnight."
  );
}

/** How a provider's cost counts toward the daily dollar limit. */
export function costNote(choice: AiChoice, label: string): string | null {
  switch (choice) {
    case "openai":
    case "gemini":
      return (
        `${label} doesn't report a price per call. For the daily dollar limit, MailMe counts a deliberately high $10 per ` +
        "million input tokens and $50 per million output tokens. The call limit works the same for every provider."
      );
    case "xai":
      return "Grok reports the exact cost of each call, and that is what counts toward the daily dollar limit.";
    case "anthropic":
      return "Claude's cost is counted from Anthropic's published prices.";
    case "mock":
      return "The free mock costs nothing and makes no network calls. Its results are rough.";
  }
}

/** The note on extraction quality, for the providers it wasn't measured with. */
export function qualityNote(choice: AiChoice, label: string): string | null {
  if (choice === "mock" || choice === "anthropic") return null;
  return `Extraction quality was measured with Claude. ${label} runs the same prompt, so check its first tasks.`;
}

/**
 * Message for a failed AI call. It prefers the server's own text when it sent one, e.g. "OpenAI rejected this key."
 * or "Could not reach OpenAI". That text never carries the key.
 */
export function aiErrorText(err: unknown): string {
  if (isApiError(err) && err.serverMessage && (err.code === "invalid" || err.code === "internal" || err.code === "rate_limited")) return err.serverMessage;
  return errorMessage(err);
}

/** The "Create a key" link, only if it is a valid https URL. */
export function safeKeyUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
