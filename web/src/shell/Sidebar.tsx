/**
 * The app's left rail ("console"): brand, primary views with live counts, the mailbox sync pulse, settings and
 * the account. Hidden under 900px, where MobileNav takes over.
 */
import { CheckCircle2, History, Hourglass, Inbox, Plus, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { HealthSummary, Me, TaskTab, TodayResponse } from "../../../src/server/api-types.js";
import { agoLabel, minutesSince } from "../format.js";
import { routeHref, type Route } from "../router.js";
import { ThemeSwitch } from "../theme.js";
import { BrandMark } from "../ui/BrandMark.js";
import { PersonAvatar } from "../ui/Avatar.js";
import { SyncNowButton } from "./SyncNow.js";

const list = (tab: TaskTab) => routeHref({ name: "list", tab, q: "", company: null, review: false });

export function activeKey(route: Route): string {
  if (route.name === "today") return "today";
  if (route.name === "list") return route.review ? "review" : route.tab;
  if (route.name === "settings" || route.name === "mailbox") return "settings";
  if (route.name === "preferences") return "preferences";
  if (route.name === "admin") return "admin";
  return "";
}

function Item({ href, icon, label, count, active, tone }: { href: string; icon: ReactNode; label: string; count?: number; active: boolean; tone?: "ai" }) {
  return (
    <a className={`side-item${active ? " is-active" : ""}${tone === "ai" ? " is-ai" : ""}`} href={href} aria-current={active ? "page" : undefined}>
      <span className="side-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="side-label">{label}</span>
      {count ? <span className="side-count">{count > 99 ? "99+" : count}</span> : null}
    </a>
  );
}

export function Sidebar({
  me,
  route,
  snapshot,
  health,
  onRefreshHealth,
  onLogout,
}: {
  me: Me;
  route: Route;
  snapshot: TodayResponse | null;
  health: HealthSummary | null;
  onRefreshHealth: () => void;
  onLogout: () => void;
}) {
  const key = activeKey(route);
  const c = snapshot?.counts;
  const todayCount = c ? c.doNow + c.promised + c.waiting : undefined;
  const synced = agoLabel(minutesSince(health?.lastSyncAt ?? null));
  // Green only for a mailbox that has actually synced; amber when the server flags a problem; grey otherwise.
  const live = Boolean(health && !health.banner && health.lastSyncAt);
  return (
    <aside className="side" aria-label="Navigation">
      <a className="side-brand" href="#/">
        <BrandMark size={30} />
        <span className="side-brand-name">MailMe</span>
      </a>

      <a className="side-new" href={routeHref({ name: "new", fromMessageId: null })}>
        <Plus size={16} aria-hidden="true" />
        New task
      </a>

      <nav className="side-nav" aria-label="Main navigation">
        {me.platformAdmin ? <Item href={routeHref({ name: "admin" })} icon={<ShieldCheck size={17} />} label="Admin" active={key === "admin"} /> : null}
        <Item href="#/" icon={<Sun size={17} />} label="Today" count={todayCount} active={key === "today"} />
        <Item href={list("review")} icon={<Sparkles size={17} />} label="Needs a look" count={c?.triage} active={key === "review"} tone="ai" />
        <p className="side-section">Tasks</p>
        <Item href={list("all")} icon={<Inbox size={17} />} label="All open" active={key === "all" || key === "todo"} />
        <Item href={list("waiting")} icon={<Hourglass size={17} />} label="Waiting" count={c?.waiting} active={key === "waiting"} />
        <Item href={list("others")} icon={<Users size={17} />} label="Colleagues" count={c?.others} active={key === "others"} />
        <Item href={list("earlier")} icon={<History size={17} />} label="Earlier" count={c?.earlier} active={key === "earlier"} />
        <Item href={list("closed")} icon={<CheckCircle2 size={17} />} label="Closed" active={key === "closed"} />
      </nav>

      <div className="side-foot">
        <div className="side-sync-row">
          <a className={`side-sync${live ? " is-live" : health?.banner ? " is-warn" : ""}`} href={routeHref({ name: "settings" })} title={health?.banner ?? undefined}>
            <span className="pulse" aria-hidden="true" />
            <span>{health?.banner ? "Sync: needs attention" : synced ? `Synced ${synced}` : "Sync"}</span>
          </a>
          <SyncNowButton health={health} onRefresh={onRefreshHealth} className="side-sync-now" />
        </div>
        <Item href={routeHref({ name: "preferences" })} icon={<SlidersHorizontal size={17} />} label="What matters to me" active={key === "preferences"} />
        <Item href={routeHref({ name: "settings" })} icon={<Settings size={17} />} label="Settings" active={key === "settings"} />
        <details className="user-menu side-user">
          <summary>
            <PersonAvatar name={me.name} size="md" />
            <span className="side-user-text">
              <span className="side-user-name">{me.name}</span>
              <span className="side-user-mail">{me.email}</span>
            </span>
          </summary>
          <div className="menu menu-up">
            <ThemeSwitch />
            <button type="button" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </details>
      </div>
    </aside>
  );
}
