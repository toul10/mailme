/**
 * Parked messages (“Not analysed”): the header notice and the Settings card share one source of truth.
 * Every instance of the hook reloads when any of them acts (a window event), so the header count follows the card.
 */
import { useCallback, useEffect, useState } from "react";
import type { ParkedMessage } from "../../src/server/api-types.js";
import { errorMessage, isApiError } from "./api.js";
import { api } from "./client.js";

const CHANGED = "mailme:problems-changed";

export interface ParkedState {
  parked: ParkedMessage[] | null;
  error: string | null;
  /** messageId currently being acted on. */
  busy: string | null;
  reload: () => Promise<void>;
  act: (messageId: string, action: "retry" | "acknowledge") => Promise<boolean>;
}

export function useParkedMessages(pollMs: number | null = null): ParkedState {
  const [parked, setParked] = useState<ParkedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.listProblems();
      setParked(r.parked);
      setError(null);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = () => void reload();
    window.addEventListener(CHANGED, onChanged);
    const timer = pollMs ? window.setInterval(() => void reload(), pollMs) : null;
    return () => {
      window.removeEventListener(CHANGED, onChanged);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [reload, pollMs]);

  const act = useCallback(async (messageId: string, action: "retry" | "acknowledge") => {
    setBusy(messageId);
    try {
      await api.problemAction(messageId, action);
      setParked((list) => (list ? list.filter((p) => p.messageId !== messageId) : list));
      window.dispatchEvent(new Event(CHANGED));
      return true;
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  return { parked, error, busy, reload, act };
}

/** Label for a parked message's error code (never content). */
export function parkedErrorLabel(code: string | null): string {
  if (!code) return "unknown reason";
  if (code.startsWith("apply")) return "could not be applied safely";
  switch (code) {
    case "PER_MESSAGE":
      return "the AI could not analyse it";
    case "invalid_output":
      return "invalid answer from the AI";
    default:
      return code;
  }
}
