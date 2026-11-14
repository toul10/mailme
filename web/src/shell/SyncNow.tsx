/**
 * “Check now”: start a worker pass now (POST /api/sync-now) instead of waiting for the next 5-minute tick. Shown
 * only where that exists (health.canSyncNow: the worker runs as a scheduled job). The pass fetches new mail within
 * about half a minute, but mail first seen in it becomes tasks at the following tick, after the settle window — so
 * the button says “in a few minutes” instead of promising tasks at once.
 */
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HealthSummary } from "../../../src/server/api-types.js";
import { isApiError } from "../api.js";
import { api, CHANGED_EVENT } from "../client.js";

/** A pass takes about 30 s including the container start; refresh the screens after that. */
export const SYNC_REFRESH_AFTER_MS = 45_000;
const NOTE_MS = 8_000;

type State = { kind: "idle" } | { kind: "running" } | { kind: "note"; text: string; warn: boolean };

export function SyncNowButton({ health, onRefresh, className }: { health: HealthSummary | null; onRefresh: () => void; className?: string }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  if (!health?.canSyncNow) return null;

  const later = (ms: number, fn: () => void) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  const note = (text: string, warn: boolean) => {
    setState({ kind: "note", text, warn });
    later(NOTE_MS, () => setState({ kind: "idle" }));
  };

  const start = async () => {
    if (state.kind === "running") return;
    setState({ kind: "running" });
    try {
      await api.syncNow();
      later(SYNC_REFRESH_AFTER_MS, () => {
        onRefresh();
        window.dispatchEvent(new Event(CHANGED_EVENT));
        note("Checked — new mail turns into tasks in a few minutes", false);
      });
    } catch (err) {
      const recent = isApiError(err) && err.code === "rate_limited";
      note(recent ? "Just checked — try again in a minute" : "The check didn't start — try again shortly", !recent);
    }
  };

  const running = state.kind === "running";
  return (
    <div className={`sync-now${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className={`sync-now-btn${running ? " is-running" : ""}`}
        onClick={() => void start()}
        aria-disabled={running || undefined}
        aria-label="Check for new mail now"
        title="Check for new mail now"
      >
        <RefreshCw size={15} aria-hidden="true" />
      </button>
      <span className={`sync-now-status${state.kind === "note" && state.warn ? " is-warn" : ""}`} role="status">
        {running ? "Checking for new mail…" : state.kind === "note" ? state.text : ""}
      </span>
    </div>
  );
}
