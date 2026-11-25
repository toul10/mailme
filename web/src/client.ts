/**
 * Browser singletons: the API client, the pending MFA step and the per-mailbox view, all surviving a reload via
 * sessionStorage, and the chat's conversation, which lives in memory only.
 */
import { ApiClient, isApiError, type KeyValueStore } from "./api.js";
import { ChatStore } from "./chat-store.js";
import { MailboxViewStore } from "./mailbox-view.js";

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

/** The per-mailbox view of this tab (mailbox-view.ts): a mailbox id, kept for the tab's lifetime. */
export const mailboxView = new MailboxViewStore(store);

/**
 * A list was asked for a mailbox the server does not know as the user's (it is gone, or the tab's memory is stale):
 * the view goes back to all mailboxes, and the caller's load runs again without it. True when that was the case.
 */
export function viewGone(err: unknown, viewId: string | null): boolean {
  if (!viewId || !isApiError(err) || err.code !== "not_found") return false;
  if (mailboxView.getSnapshot() === viewId) mailboxView.set(null);
  return true;
}

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
