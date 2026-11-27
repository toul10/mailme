/** Small React hooks and the app-wide context (signed-in user, today's date in their zone). */
import { createContext, useContext, useEffect, useState } from "react";
import type { HealthSummary, Me, OwnMailbox, SupplierRef } from "../../src/server/api-types.js";
import { todayIn } from "./format.js";
import type { SyncView } from "./sync-status.js";

export interface AppContextValue {
  me: Me;
  /** The user's IANA zone (falls back to Europe/Athens). */
  zone: string;
  /** Today's local date (YYYY-MM-DD) in `zone`; refreshed every minute. */
  today: string;
  logout: () => void;
  /** The user's own mailboxes, oldest first (empty until the day's first answer arrives). */
  mailboxes: readonly OwnMailbox[];
  /**
   * The per-mailbox view (mailbox-view.ts): the id of the one mailbox the lists, “Today” and the chat are about;
   * null for all of them. Sent to the server as it is; what it is called on screen comes from `mailboxes`.
   */
  viewId: string | null;
  setView: (id: string | null) => void;
  /**
   * “Suppliers”: the suppliers in use with their open tasks counted (within the view); empty when the user has
   * none, and until the day's first answer arrives.
   */
  suppliers: ReadonlyArray<SupplierRef & { open: number }>;
  /** /api/health as the shell last read it (every 5 s while the worker is at work, every minute otherwise); null until then. */
  health: HealthSummary | null;
  /** The sync bar's words for `health` (sync-status.ts). */
  syncView: SyncView;
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
