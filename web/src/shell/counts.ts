/**
 * Sidebar counts and the day's picture, shared by the shell. Refreshed on mount, on window focus, every minute,
 * and whenever the API client reports a successful change ("mailme:changed"). The counts follow the per-mailbox
 * view; the answer's list of the user's mailboxes is what the view is checked against.
 */
import { useEffect, useState } from "react";
import type { TodayResponse } from "../../../src/server/api-types.js";
import { api, CHANGED_EVENT, mailboxView, viewGone } from "../client.js";

export function useTodaySnapshot(viewId: string | null): TodayResponse | null {
  const [data, setData] = useState<TodayResponse | null>(null);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const load = () => {
      const n = ++seq;
      api
        .today(viewId)
        .then((d) => {
          if (!alive || n !== seq) return;
          setData(d);
          mailboxView.reconcile(d.mailboxes);
        })
        // A view the server no longer knows: dropped, and the effect runs again for all mailboxes.
        .catch((err: unknown) => void (alive && n === seq && viewGone(err, viewId)));
    };
    load();
    const timer = window.setInterval(load, 60_000);
    const onVisible = () => document.visibilityState === "visible" && load();
    window.addEventListener(CHANGED_EVENT, load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(CHANGED_EVENT, load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [viewId]);
  return data;
}
