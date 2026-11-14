/**
 * Sidebar counts and the day's picture, shared by the shell. Refreshed on mount, on window focus, every minute,
 * and whenever the API client reports a successful change ("mailme:changed").
 */
import { useEffect, useState } from "react";
import type { TodayResponse } from "../../../src/server/api-types.js";
import { api, CHANGED_EVENT } from "../client.js";

export function useTodaySnapshot(): TodayResponse | null {
  const [data, setData] = useState<TodayResponse | null>(null);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const load = () => {
      const n = ++seq;
      api
        .today()
        .then((d) => alive && n === seq && setData(d))
        .catch(() => undefined);
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
  }, []);
  return data;
}
