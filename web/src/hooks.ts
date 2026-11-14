/** Small React hooks and the app-wide context (signed-in user, today's date in their zone). */
import { createContext, useContext, useEffect, useState } from "react";
import type { Me } from "../../src/server/api-types.js";
import { todayIn } from "./format.js";

export interface AppContextValue {
  me: Me;
  /** The user's IANA zone (falls back to Europe/Athens). */
  zone: string;
  /** Today's local date (YYYY-MM-DD) in `zone`; refreshed every minute. */
  today: string;
  logout: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppContext");
  return ctx;
}

/** Today's date in `zone`, re-evaluated every minute so "Today" flips at local midnight. */
export function useToday(zone: string): string {
  const [today, setToday] = useState(() => todayIn(zone));
  useEffect(() => {
    setToday(todayIn(zone));
    const t = window.setInterval(() => setToday(todayIn(zone)), 60_000);
    return () => window.clearInterval(t);
  }, [zone]);
  return today;
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · MailMe` : "MailMe";
  }, [title]);
}
