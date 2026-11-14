/** Bottom tab bar under 900px (the sidebar's job on phones). The lit key in the middle starts a new task. */
import { Inbox, Plus, Settings, Sparkles, Sun } from "lucide-react";
import { routeHref, type Route } from "../router.js";
import { activeKey } from "./Sidebar.js";

export function MobileNav({ route, todayCount, reviewCount }: { route: Route; todayCount?: number; reviewCount?: number }) {
  const key = activeKey(route);
  const current = (k: string) => (key === k ? ("page" as const) : undefined);
  return (
    <nav className="mnav" aria-label="Main navigation">
      <a href="#/" aria-current={current("today")}>
        <Sun size={21} aria-hidden="true" />
        <span>Today{todayCount ? ` ${todayCount}` : ""}</span>
      </a>
      <a href={routeHref({ name: "list", tab: "all", q: "", company: null, review: false })} aria-current={key === "all" || key === "todo" ? "page" : undefined}>
        <Inbox size={21} aria-hidden="true" />
        <span>All</span>
      </a>
      <a href={routeHref({ name: "new", fromMessageId: null })} className="mnav-new" aria-label="New task">
        <Plus size={22} aria-hidden="true" />
      </a>
      <a href={routeHref({ name: "list", tab: "review", q: "", company: null, review: false })} aria-current={current("review")} className="mnav-ai">
        <Sparkles size={21} aria-hidden="true" />
        <span>Review{reviewCount ? ` ${reviewCount}` : ""}</span>
      </a>
      <a href={routeHref({ name: "settings" })} aria-current={current("settings")}>
        <Settings size={21} aria-hidden="true" />
        <span>Settings</span>
      </a>
    </nav>
  );
}
