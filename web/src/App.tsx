/**
 * Root: auth state machine (login → TOTP verify/enroll → app) and the app shell: the rack (sidebar on desktop,
 * top bar + bottom tabs on phones), the health banners and the routed screens.
 */
import { MessageCircleQuestion } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { HealthSummary, LoginResponse, Me, OwnMailbox, TodayResponse } from "../../src/server/api-types.js";
import { errorMessage, isApiError } from "./api.js";
import { api, chat, clearMfaStep, mailboxView, readMfaStep, saveMfaStep, type MfaStep } from "./client.js";
import { ToastProvider } from "./components/Toast.js";
import { AppContext, useDocumentTitle, useToday } from "./hooks.js";
import { useParkedMessages } from "./problems.js";
import { navigate, routeHref, useRoute, type Route } from "./router.js";
import { LoginScreen, SetupScreen, TotpEnrollScreen, TotpVerifyScreen } from "./screens/Auth.js";
import { Admin } from "./screens/Admin.js";
import { AiCosts } from "./screens/AiCosts.js";
import { Chat } from "./screens/Chat.js";
import { MailboxPage } from "./screens/MailboxPage.js";
import { NewTask } from "./screens/NewTask.js";
import { Preferences } from "./screens/Preferences.js";
import { Settings } from "./screens/Settings.js";
import { Suppliers } from "./screens/Suppliers.js";
import { TaskList } from "./screens/TaskList.js";
import { Today } from "./screens/Today.js";
import { ThemeSwitch } from "./theme.js";
import { TaskPage } from "./screens/TaskPage.js";
import { useTodaySnapshot } from "./shell/counts.js";
import { MailboxSwitch } from "./shell/MailboxSwitch.js";
import { MobileNav } from "./shell/MobileNav.js";
import { Sidebar } from "./shell/Sidebar.js";
import { SyncNowButton } from "./shell/SyncNow.js";
import { SyncStrip } from "./shell/SyncStatus.js";
import { describeSync, isWorking } from "./sync-status.js";
import { mailboxShortNames } from "./mailbox-view.js";
import { PersonAvatar } from "./ui/Avatar.js";
import { BrandMark } from "./ui/BrandMark.js";

type AuthState =
  | { kind: "loading" }
  | { kind: "login"; notice: string | null }
  | { kind: "mfa"; step: MfaStep }
  | { kind: "ready"; me: Me }
  | { kind: "offline"; message: string };

const DEFAULT_ZONE = "Europe/Athens";
const HEALTH_POLL_MS = 5 * 60_000;
/** The sync bar (shell/SyncStatus.tsx): /api/health every 5 s while the worker is at work, every minute otherwise. */
const HEALTH_FAST_MS = 5_000;
const HEALTH_IDLE_MS = 60_000;
/** After “Check now”, fast for this long: the pass takes a few seconds to start. */
const SYNC_BOOST_MS = 2 * 60_000;

export function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}

let setupTokenOnce: string | null | undefined;

/**
 * A one-time setup link (#/setup?t=…, src/server/auth/setup-links.ts): read once, then the token is dropped from
 * the address bar and the history. Idempotent (StrictMode calls state initializers twice).
 */
function takeSetupToken(): string | null {
  if (setupTokenOnce === undefined) {
    const m = /^#\/setup\?(?:.*&)?t=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash);
    setupTokenOnce = m ? m[1]! : null;
    if (m) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  }
  return setupTokenOnce;
}

function Root() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [setupToken, setSetupToken] = useState<string | null>(takeSetupToken);

  const loadMe = useCallback(async () => {
    try {
      const me = await api.me();
      clearMfaStep();
      // Before the shell renders: its first requests already follow the view this user chose in this tab.
      mailboxView.bindUser(me.id);
      setAuth({ kind: "ready", me });
    } catch (err) {
      if (isApiError(err) && err.code === "unauthorized") setAuth({ kind: "login", notice: null });
      else if (isApiError(err) && err.code === "mfa_required") setAuth({ kind: "mfa", step: readMfaStep() ?? "totp" });
      else setAuth({ kind: "offline", message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    api.onAuthError = (kind) => {
      if (kind === "unauthorized") {
        // The session is gone: what was asked and answered must not stay on a screen somebody else may use.
        chat.reset();
        setAuth((prev) => (prev.kind === "login" ? prev : { kind: "login", notice: prev.kind === "ready" ? "Your session has expired. Sign in again." : null }));
      } else {
        setAuth((prev) => (prev.kind === "mfa" ? prev : { kind: "mfa", step: readMfaStep() ?? "totp" }));
      }
    };
    void loadMe();
    return () => {
      api.onAuthError = null;
    };
  }, [loadMe]);

  const onLoggedIn = (next: LoginResponse["next"]) => {
    if (next === "none") {
      clearMfaStep();
      setAuth({ kind: "loading" });
      void loadMe();
      return;
    }
    saveMfaStep(next);
    setAuth({ kind: "mfa", step: next });
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // The session may already be gone; the login screen is the right place either way.
    }
    chat.reset();
    clearMfaStep();
    setAuth({ kind: "login", notice: null });
  };

  const mfaDone = () => {
    clearMfaStep();
    setAuth({ kind: "loading" });
    void loadMe();
  };

  // The setup link comes first, even over a session already open in this browser (it ends that session).
  if (setupToken) {
    return (
      <SetupScreen
        token={setupToken}
        onDone={(next) => {
          setupTokenOnce = null;
          setSetupToken(null);
          onLoggedIn(next);
        }}
        onLeave={() => {
          setupTokenOnce = null;
          setSetupToken(null);
          setAuth({ kind: "login", notice: null });
        }}
      />
    );
  }

  switch (auth.kind) {
    case "loading":
      return (
        <main className="center" id="main">
          <p className="muted">Loading…</p>
        </main>
      );
    case "offline":
      return (
        <main className="center" id="main">
          <div className="error-box" role="alert">
            <p>{auth.message}</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setAuth({ kind: "loading" });
                void loadMe();
              }}
            >
              Try again
            </button>
          </div>
        </main>
      );
    case "login":
      return <LoginScreen notice={auth.notice} onLoggedIn={onLoggedIn} />;
    case "mfa":
      return auth.step === "totp_enroll" ? (
        <TotpEnrollScreen onDone={mfaDone} onCancel={() => void logout()} />
      ) : (
        <TotpVerifyScreen
          onDone={mfaDone}
          onCancel={() => void logout()}
          onEnroll={() => {
            saveMfaStep("totp_enroll");
            setAuth({ kind: "mfa", step: "totp_enroll" });
          }}
        />
      );
    case "ready":
      return <Shell me={auth.me} onLogout={() => void logout()} />;
  }
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const zone = me.timezone || DEFAULT_ZONE;
  const today = useToday(zone);
  const route = useRoute();
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const parked = useParkedMessages(HEALTH_POLL_MS).parked?.length ?? 0;
  const mainRef = useRef<HTMLElement>(null);
  // The per-mailbox view (mailbox-view.ts): the counts follow it, and the day's answer names the user's mailboxes.
  const viewId = useSyncExternalStore(mailboxView.subscribe, mailboxView.getSnapshot);
  const setView = useCallback((id: string | null) => mailboxView.set(id), []);
  const snapshot = useTodaySnapshot(viewId);
  // The same list while nothing in it changes (the snapshot is read again every minute).
  const mailboxesKey = JSON.stringify(snapshot?.mailboxes ?? []);
  const mailboxes = useMemo<readonly OwnMailbox[]>(() => snapshot?.mailboxes ?? [], [mailboxesKey]);
  // “Suppliers”: who they are and how many open tasks each has, for the rail, the list's filter and the screen.
  const suppliersKey = JSON.stringify(snapshot?.suppliers ?? []);
  const suppliers = useMemo<TodayResponse["suppliers"]>(() => snapshot?.suppliers ?? [], [suppliersKey]);

  // The chat's conversation belongs to the signed-in user: another account on this tab starts from nothing.
  useEffect(() => chat.bindUser(me.id), [me.id]);

  // A platform admin's home is #/admin (their own account has no mailbox); only on arrival, never afterwards.
  useEffect(() => {
    if (me.platformAdmin && route.name === "today") navigate({ name: "admin" });
  }, []);

  // Health (and with it the sync bar) is read again sooner while the worker is at work: only the latest request
  // schedules the next one, and a hidden tab slows down to HEALTH_POLL_MS.
  const alive = useRef(true);
  const healthSeq = useRef(0);
  const healthTimer = useRef<number | null>(null);
  const boostUntil = useRef(0);
  const refreshRef = useRef<() => void>(() => undefined);
  const refreshHealth = useCallback(() => {
    const n = ++healthSeq.current;
    if (healthTimer.current !== null) window.clearTimeout(healthTimer.current);
    healthTimer.current = null;
    void api
      .health()
      .then(
        (h) => h,
        () => null,
      )
      .then((h) => {
        if (!alive.current || n !== healthSeq.current) return;
        if (h) setHealth(h);
        const fast = isWorking(h) || Date.now() < boostUntil.current;
        const delay = document.visibilityState === "hidden" ? HEALTH_POLL_MS : fast ? HEALTH_FAST_MS : HEALTH_IDLE_MS;
        healthTimer.current = window.setTimeout(() => refreshRef.current(), delay);
      });
  }, []);
  refreshRef.current = refreshHealth;
  const onSyncStarted = useCallback(() => {
    boostUntil.current = Date.now() + SYNC_BOOST_MS;
    refreshHealth();
  }, [refreshHealth]);
  useEffect(() => {
    alive.current = true;
    refreshHealth();
    const onVisible = () => document.visibilityState === "visible" && refreshHealth();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      if (healthTimer.current !== null) window.clearTimeout(healthTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshHealth]);
  const syncView = useMemo(() => describeSync(health, { now: new Date(), zone, names: mailboxShortNames(mailboxes) }), [health, zone, mailboxes]);

  // Menus are plain disclosures (<details> + Tab-reachable links/buttons, no ARIA menu roles): close them on an
  // outside click, on a link inside them, or on Escape — handing focus back to their button if it was inside.
  useEffect(() => {
    const close = (except: EventTarget | null) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>("details.user-menu[open], details.more-menu[open]")) {
        if (except instanceof Node && d.contains(except)) continue;
        if (d.contains(document.activeElement)) d.querySelector<HTMLElement>("summary")?.focus();
        d.open = false;
      }
    };
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest(".menu a") : null;
      close(link ? null : e.target);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(null);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Any navigation (links, back/forward) closes the menus: the top bar outlives the screens.
  useEffect(() => {
    for (const d of document.querySelectorAll<HTMLDetailsElement>("details.user-menu[open], details.more-menu[open]")) d.open = false;
  }, [route]);

  // Move focus to the new screen on navigation (except list filter changes, which keep focus in place, and the
  // task page dropping its ?edit=1 flag).
  const screenKey = route.name === "list" ? "list" : route.name === "task" ? `task:${route.id}` : routeHref(route);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [screenKey]);

  const c = snapshot?.counts;

  return (
    <AppContext.Provider value={{ me, zone, today, logout: onLogout, mailboxes, viewId, setView, suppliers, health, syncView }}>
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </button>
      <div className="app">
        <Sidebar me={me} route={route} snapshot={snapshot} health={health} syncView={syncView} onRefreshHealth={refreshHealth} onSyncStarted={onSyncStarted} onLogout={onLogout} />
        <div className="app-main">
          <header className="mtop">
            <a className="mtop-brand" href="#/">
              <BrandMark size={26} />
              <span>MailMe</span>
            </a>
            <SyncNowButton health={health} onRefresh={refreshHealth} onStarted={onSyncStarted} className="mtop-sync-now" />
            {me.chat ? (
              <a className="mtop-chat" href={routeHref({ name: "chat" })} aria-label="Ask your mail" aria-current={route.name === "chat" ? "page" : undefined}>
                <MessageCircleQuestion size={22} aria-hidden="true" />
              </a>
            ) : null}
            <details className="user-menu">
              <summary aria-label={`Account: ${me.name}`}>
                <PersonAvatar name={me.name} size="md" />
              </summary>
              <div className="menu">
                <p className="menu-note">{me.email}</p>
                <a href={routeHref({ name: "settings" })}>Settings</a>
                <ThemeSwitch />
                <button type="button" onClick={onLogout}>
                  Sign out
                </button>
              </div>
            </details>
          </header>
          {/* The per-mailbox view's switch, on the screens the view changes. */}
          {route.name === "today" || route.name === "list" || route.name === "suppliers" || route.name === "chat" || route.name === "new" ? (
            <MailboxSwitch align={route.name === "today" ? "edge" : "column"} />
          ) : null}
          <SyncStrip view={syncView} />
          {/* Only a problem a person must fix: a pause or a late pass is told by the sync bar, with when it goes on. */}
          {health?.banner && syncView.tone === "error" ? (
            <div className="banner banner-danger health-banner" role="alert">
              <span aria-hidden="true">⚠ </span>
              {health.banner}
            </div>
          ) : null}
          {parked > 0 ? (
            <div className="banner banner-warn parked-notice" role="status">
              <a href={`${routeHref({ name: "settings" })}`} className="parked-link">
                <span aria-hidden="true">⚠ </span>Not analysed ({parked >= 100 ? "100+" : parked})
              </a>
              <span className="muted small hide-narrow"> — messages the AI couldn't analyse: “Retry” or “Got it”, in Settings</span>
            </div>
          ) : null}
          <main id="main" ref={mainRef} tabIndex={-1} className="screen">
            <Screen route={route} />
          </main>
        </div>
        <MobileNav route={route} todayCount={c ? c.doNow + c.promised + c.waiting : undefined} reviewCount={c?.triage} />
      </div>
    </AppContext.Provider>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "today":
      return <Today />;
    case "list":
      return <TaskList route={route} />;
    case "task":
      return <TaskPage key={route.id} id={route.id} startEditing={route.edit === true} />;
    case "new":
      return <NewTask key={route.fromMessageId ?? "blank"} fromMessageId={route.fromMessageId} />;
    case "chat":
      return <Chat />;
    case "suppliers":
      return <Suppliers />;
    case "settings":
      return <Settings />;
    case "costs":
      return <AiCosts />;
    case "preferences":
      return <Preferences />;
    case "admin":
      return <Admin />;
    case "mailbox":
      return <MailboxPage key={route.id} id={route.id} />;
    case "notFound":
      return <NotFound />;
  }
}

function NotFound() {
  useDocumentTitle("Not found");
  return (
    <div className="page">
      <p className="empty">Page not found.</p>
      <p>
        <a href="#/">Go to Today</a>
      </p>
    </div>
  );
}
