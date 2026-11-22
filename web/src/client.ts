/**
 * Browser singletons: the API client and the pending MFA step, both surviving a reload via sessionStorage, and the
 * chat's conversation, which lives in memory only.
 */
import { ApiClient, type KeyValueStore } from "./api.js";
import { ChatStore } from "./chat-store.js";

function sessionStore(): KeyValueStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const store = sessionStore();

/** Fired after every successful change through the API (the shell's counts listen). */
export const CHANGED_EVENT = "mailme:changed";

export const api = new ApiClient({ storage: store, onMutated: () => window.dispatchEvent(new Event(CHANGED_EVENT)) });

/** “Ask your mail”: the conversation of this tab (cleared on sign-out; never stored). */
export const chat = new ChatStore((req, onEvent, signal) => api.chat(req, onEvent, signal));

export type MfaStep = "totp" | "totp_enroll";
const MFA_KEY = "mailme.mfaStep";

export function saveMfaStep(step: MfaStep): void {
  try {
    store?.setItem(MFA_KEY, step);
  } catch {
    // ignore: the verify screen is the fallback
  }
}

export function readMfaStep(): MfaStep | null {
  try {
    const v = store?.getItem(MFA_KEY);
    return v === "totp" || v === "totp_enroll" ? v : null;
  } catch {
    return null;
  }
}

export function clearMfaStep(): void {
  try {
    store?.removeItem(MFA_KEY);
  } catch {
    // ignore
  }
}
