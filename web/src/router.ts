/**
 * Tiny hash router. Hash routes need no server-side fallback: the server only serves "/".
 *   #/                       Today (home); with list params (?tab=…, from report links) → the list
 *   #/all                    All: task list (?tab=&q=&company=&review=1&supplier=; tab may be the web-only “snoozed”)
 *   #/suppliers              “Suppliers”: the open tasks, supplier by supplier
 *   #/tasks/:id              task page (?edit=1 opens the edit form, e.g. from a question on Today)
 *   #/new                    new task (?from=<messageId>)
 *   #/chat                   “Ask your mail” (where the install has the chat on: Me.chat)
 *   #/settings               settings (mailboxes, digest)
 *   #/preferences            “What matters to me” (important / muted senders, Cc rule, profile)
 *   #/admin                  platform admin: organizations and accounts (never content)
 *   #/setup?t=…              one-time account setup link (handled before login, in App.tsx)
 *   #/settings/mailboxes/:id mailbox setup
 * Path-style links (/tasks/:id, /?tab=) are rewritten to the hash form on boot.
 */
import { useMemo, useSyncExternalStore } from "react";
import { isListFilter, type ListFilter } from "./labels.js";

export type Route =
  | { name: "today" }
  /** `supplier` (the id of a supplier rule) is present only when the list is narrowed to one, so plain list routes compare equal. */
  | { name: "list"; tab: ListFilter; q: string; company: string | null; review: boolean; supplier?: string }
  | { name: "suppliers" }
  /** `edit` is present only when true, so plain task routes compare equal. */
  | { name: "task"; id: string; edit?: true }
  | { name: "new"; fromMessageId: string | null }
  | { name: "chat" }
  | { name: "settings" }
  | { name: "preferences" }
  | { name: "admin" }
  | { name: "mailbox"; id: string }
  | { name: "notFound"; path: string };

export const DEFAULT_LIST: Extract<Route, { name: "list" }> = { name: "list", tab: "all", q: "", company: null, review: false };

/** A supplier rule's id as the server takes it (src/server/validation.ts). */
const SUPPLIER_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Parse a location hash ("#/tasks/abc", "", "#/?tab=waiting"). */
export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const qIndex = raw.indexOf("?");
  const pathPart = (qIndex >= 0 ? raw.slice(0, qIndex) : raw) || "/";
  const params = new URLSearchParams(qIndex >= 0 ? raw.slice(qIndex + 1) : "");
  const segments = pathPart.split("/").filter(Boolean);

  const listParams = ["tab", "q", "company", "review", "supplier"].some((k) => params.has(k));
  if (segments.length === 0 && !listParams) return { name: "today" };
  if (segments.length === 0 || (segments.length === 1 && (segments[0] === "tasks" || segments[0] === "all"))) {
    const tab = params.get("tab");
    const supplier = (params.get("supplier") ?? "").toLowerCase();
    return {
      name: "list",
      tab: isListFilter(tab) ? tab : "all",
      q: params.get("q") ?? "",
      company: params.get("company") || null,
      review: params.get("review") === "1",
      ...(SUPPLIER_ID.test(supplier) ? { supplier } : {}),
    };
  }
  const [first, second, third] = segments;
  if (first === "tasks" && second && segments.length === 2) {
    const id = safeDecode(second);
    if (id) return params.get("edit") === "1" ? { name: "task", id, edit: true } : { name: "task", id };
  }
  if (first === "new" && segments.length === 1) return { name: "new", fromMessageId: params.get("from") || null };
  if (first === "chat" && segments.length === 1) return { name: "chat" };
  if (first === "suppliers" && segments.length === 1) return { name: "suppliers" };
  if (first === "settings" && segments.length === 1) return { name: "settings" };
  if (first === "preferences" && segments.length === 1) return { name: "preferences" };
  if (first === "admin" && segments.length === 1) return { name: "admin" };
  if (first === "settings" && second === "mailboxes" && third && segments.length === 3) {
    const id = safeDecode(third);
    if (id) return { name: "mailbox", id };
  }
  return { name: "notFound", path: pathPart };
}

/** Hash href for a route (inverse of parseHash). */
export function routeHref(route: Route): string {
  switch (route.name) {
    case "today":
      return "#/";
    case "list": {
      const p = new URLSearchParams();
      if (route.tab !== "all") p.set("tab", route.tab);
      if (route.q.trim()) p.set("q", route.q.trim());
      if (route.company) p.set("company", route.company);
      if (route.review) p.set("review", "1");
      if (route.supplier) p.set("supplier", route.supplier);
      const qs = p.toString();
      return qs ? `#/all?${qs}` : "#/all";
    }
    case "task":
      return `#/tasks/${encodeURIComponent(route.id)}${route.edit ? "?edit=1" : ""}`;
    case "new":
      return route.fromMessageId ? `#/new?from=${encodeURIComponent(route.fromMessageId)}` : "#/new";
    case "chat":
      return "#/chat";
    case "suppliers":
      return "#/suppliers";
    case "settings":
      return "#/settings";
    case "preferences":
      return "#/preferences";
    case "admin":
      return "#/admin";
    case "mailbox":
      return `#/settings/mailboxes/${encodeURIComponent(route.id)}`;
    case "notFound":
      return `#${route.path}`;
  }
}

/**
 * Digest links may be path-style when the server falls back to index.html:
 * "/tasks/abc" → "#/tasks/abc", "/?tab=waiting" → "#/?tab=waiting". Returns null when nothing to rewrite.
 */
export function legacyLocationToHash(pathname: string, search: string, hash: string): string | null {
  if (hash && hash !== "#") return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  const known = path === "/" || /^\/(tasks(\/[^/]+)?|new|settings(\/mailboxes\/[^/]+)?)$/.test(path);
  if (!known) return null;
  if (path === "/" && !search) return null;
  return `#${path}${search}`;
}

// ── Browser binding ─────────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  window.addEventListener("hashchange", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("hashchange", cb);
  };
}

function notify(): void {
  for (const l of listeners) l();
}

function getHash(): string {
  return window.location.hash;
}

/** Go to a route. `replace` rewrites the current history entry (used for search-as-you-type). */
export function navigate(to: Route | string, opts: { replace?: boolean } = {}): void {
  const href = typeof to === "string" ? to : routeHref(to);
  if (opts.replace) {
    window.history.replaceState(window.history.state, "", href);
    notify();
    return;
  }
  if (window.location.hash === href) {
    notify();
    return;
  }
  window.location.hash = href;
}

/** Rewrites a path-style deep link into the hash form (call once before the first render). */
export function normalizeInitialLocation(): void {
  const { pathname, search, hash } = window.location;
  const next = legacyLocationToHash(pathname, search, hash);
  if (next) window.history.replaceState(null, "", `/${next}`);
}

/** The route of the live URL (may be ahead of the last render during a pending hashchange). */
export function currentRoute(): Route {
  return parseHash(window.location.hash);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => "");
  return useMemo(() => parseHash(hash), [hash]);
}
