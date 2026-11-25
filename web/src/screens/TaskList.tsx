/**
 * “All”: one list with a segmented filter, debounced search, company filter, keyboard navigation, bulk actions.
 * A quick action on a row updates that row in place (list-model.ts), so pages loaded with “More” stay.
 * With a per-mailbox view (mailbox-view.ts) the list, its counts and its companies are of that one mailbox.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SnoozeMode } from "../../../src/domain/types.js";
import type { TaskAction, TaskListItem, TaskListResponse } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api, viewGone } from "../client.js";
import { ConfirmDialog } from "../components/Dialog.js";
import { SnoozeDialog } from "../components/SnoozeDialog.js";
import { TaskRow, type RowChange } from "../components/TaskRow.js";
import { useToast } from "../components/Toast.js";
import { restoreFocus, type FocusPlan } from "../focus.js";
import { plural } from "../format.js";
import { useApp, useDebounced, useDocumentTitle } from "../hooks.js";
import { FILTER_BAR, TAB_LABELS, type ListFilter } from "../labels.js";
import { apiTab, placeUpdated, snoozedOnly } from "../list-model.js";
import { mailboxNames, viewOf } from "../mailbox-view.js";
import { currentRoute, navigate, routeHref, type Route } from "../router.js";

type ListRoute = Extract<Route, { name: "list" }>;

const PAGE_SIZE = 50;
/** “Snoozed” filters the open list here: fetched whole, in big pages, up to a sane cap. */
const SNOOZED_PAGE_SIZE = 200;
const SNOOZED_MAX_PAGES = 10;

/** Last overview URL (Today or a filtered All list), so the task page's "back" returns there. */
let lastListHref = "#/";
export function getLastListHref(): string {
  return lastListHref;
}
export function setLastListHref(href: string): void {
  lastListHref = href;
}

const EMPTY_TEXT: Record<ListFilter, string> = {
  todo: "You have nothing to do right now.",
  waiting: "You're not waiting for a reply from anyone.",
  all: "No open tasks.",
  others: "No tasks for colleagues.",
  review: "Nothing to check.",
  closed: "No closed tasks.",
  earlier: "No older tasks to sort out.",
  snoozed: "Nothing is snoozed.",
};

type BulkIntent = { kind: "complete" } | { kind: "not_a_task" } | { kind: "snooze" };

export function TaskList({ route }: { route: ListRoute }) {
  const { zone, today, viewId, mailboxes, setView } = useApp();
  const toast = useToast();
  const [data, setData] = useState<TaskListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Array<{ name: string; open: number }>>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulk, setBulk] = useState<BulkIntent | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState(route.q);
  const debouncedSearch = useDebounced(search, 300);
  const requestSeq = useRef(0);
  const countsSeq = useRef(0);
  const focusPlan = useRef<FocusPlan | null>(null);
  /** Where rows removed by a quick action were, so an undo puts them back in place. */
  const removedAt = useRef(new Map<string, number>());
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filter = route.tab;
  const snoozedView = filter === "snoozed";

  const count = snoozedView ? data?.items.length : data?.counts[apiTab(filter)];
  useDocumentTitle(count !== undefined ? `${TAB_LABELS[filter]} (${count})` : TAB_LABELS[filter]);

  useEffect(() => {
    lastListHref = routeHref(route);
  }, [route]);

  // Search box → URL (replace, so typing doesn't flood history); URL → search box on back/forward.
  useEffect(() => {
    // Read the live URL, not the render-time route: a tab click may have changed the hash
    // before its hashchange event re-rendered us, and a stale route would undo it.
    const current = currentRoute();
    if (current.name === "list" && debouncedSearch.trim() !== current.q.trim()) navigate({ ...current, q: debouncedSearch }, { replace: true });
    // Only the debounced value drives this effect.
  }, [debouncedSearch]);
  useEffect(() => {
    if (route.q.trim() !== debouncedSearch.trim()) setSearch(route.q);
    // Only external URL changes (back/forward) drive this effect.
  }, [route.q]);

  const query = useMemo(() => ({ tab: apiTab(filter), company: route.company, q: route.q, review: route.review, mailbox: viewId }), [filter, route.company, route.q, route.review, viewId]);

  const load = useCallback(
    async (cursor: string | null = null) => {
      const seq = ++requestSeq.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        if (snoozedView) {
          // The API has no snoozed tab: read the open list whole and keep the snoozed rows.
          let res = await api.listTasks({ ...query, limit: SNOOZED_PAGE_SIZE });
          const items = [...res.items];
          for (let page = 1; res.nextCursor && page < SNOOZED_MAX_PAGES; page++) {
            res = await api.listTasks({ ...query, limit: SNOOZED_PAGE_SIZE, cursor: res.nextCursor });
            if (seq !== requestSeq.current) return;
            items.push(...res.items);
          }
          if (seq !== requestSeq.current) return;
          setData({ ...res, items: snoozedOnly(items, today), nextCursor: null });
          return;
        }
        const res = await api.listTasks({ ...query, limit: PAGE_SIZE, cursor });
        if (seq !== requestSeq.current) return;
        setData((prev) => (cursor && prev ? { ...res, items: [...prev.items, ...res.items.filter((i) => !prev.items.some((p) => p.id === i.id))] } : res));
      } catch (err) {
        if (seq !== requestSeq.current) return;
        // A view the server no longer knows was dropped: this runs again for all mailboxes.
        if (viewGone(err, viewId)) return;
        if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [query, snoozedView, today, viewId],
  );

  useEffect(() => {
    setSelected(new Set());
    removedAt.current.clear();
    void load();
  }, [load]);

  /** Counts only (a 1-row page), after a row changed in place. Its own sequence: it must not cancel “More”. */
  const refreshCounts = useCallback(async () => {
    const seq = ++countsSeq.current;
    try {
      const res = await api.listTasks({ ...query, limit: 1 });
      if (seq !== countsSeq.current) return;
      setData((prev) => (prev ? { ...prev, counts: res.counts } : prev));
    } catch {
      // The counts stay one action behind; the next load fixes them.
    }
  }, [query]);

  const applyUpdate = useCallback(
    (updated: TaskListItem) => {
      setData((prev) => {
        if (!prev) return prev;
        const r = placeUpdated(prev.items, updated, filter, today, removedAt.current.get(updated.id));
        if (r.removedAt !== null) removedAt.current.set(updated.id, r.removedAt);
        return { ...prev, items: r.items };
      });
      setSelected((s) => {
        if (!s.has(updated.id)) return s;
        const n = new Set(s);
        n.delete(updated.id);
        return n;
      });
    },
    [filter, today],
  );

  const onRowChanged = useCallback(
    (change: RowChange, id: string) => {
      if (change.focus) focusPlan.current = change.focus;
      if (change.updated) {
        applyUpdate(change.updated);
      } else if (change.stale) {
        // Someone else changed it: read that one task again (a whole reload would drop the extra pages).
        api
          .getTask(id)
          .then(applyUpdate)
          .catch((err: unknown) => {
            if (isApiError(err) && err.code === "not_found") setData((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== id) } : prev));
          });
      }
      void refreshCounts();
    },
    [applyUpdate, refreshCounts],
  );

  // After the row that had focus left the list: focus its neighbour instead of <body>.
  useEffect(() => {
    if (!focusPlan.current) return;
    restoreFocus({ targets: [...focusPlan.current.targets, "#list-h"] });
    focusPlan.current = null;
  }, [data]);

  useEffect(() => {
    let alive = true;
    api
      .companies(viewId)
      .then((r) => alive && setCompanies(r.companies))
      .catch(() => alive && setCompanies([]));
    return () => {
      alive = false;
    };
  }, [viewId]);

  // "/" focuses the search box (unless typing somewhere already).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const items = data?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = selected.size > 0 && !allSelected;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    // Keys typed in a row's dialog (a React child of the row) are the dialog's own.
    if ((e.target as Element).closest("dialog")) return;
    const links = Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>("a[data-row-link]") ?? []);
    if (links.length === 0) return;
    const current = (e.target as HTMLElement).closest("li")?.querySelector<HTMLAnchorElement>("a[data-row-link]") ?? null;
    const idx = current ? links.indexOf(current) : -1;
    const focusAt = (i: number) => links[Math.max(0, Math.min(links.length - 1, i))]?.focus();
    switch (e.key) {
      case "ArrowDown":
      case "j":
        e.preventDefault();
        focusAt(idx + 1);
        break;
      case "ArrowUp":
      case "k":
        e.preventDefault();
        focusAt(idx <= 0 ? 0 : idx - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(links.length - 1);
        break;
      case "x": {
        const id = current?.dataset.id;
        if (id) {
          e.preventDefault();
          toggle(id);
        }
        break;
      }
      case "Escape":
        if (selected.size > 0) {
          e.preventDefault();
          setSelected(new Set());
        }
        break;
    }
  };

  const selectedItems = items.filter((i) => selected.has(i.id));

  const runBulk = async (action: TaskAction, doneText: string) => {
    const ids = selectedItems.map((i) => i.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await api.bulkAction({ ids, action });
      const parts = [`${doneText}: ${res.done}`];
      const n = res.conflicts.length;
      if (n > 0) parts.push(n === 1 ? "1 changed in the meantime and wasn't updated" : `${n} changed in the meantime and weren't updated`);
      toast(parts.join(" · "), res.conflicts.length > 0 ? "info" : "success");
      setSelected(new Set());
      setBulk(null);
      void load();
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
    } finally {
      setBulkBusy(false);
    }
  };

  const onSnooze = (mode: SnoozeMode, until: string | null) => void runBulk({ action: "snooze", mode, until }, "Snoozed");

  const setCompany = (company: string | null) => navigate({ ...route, company });
  const companyOptions = useMemo(() => {
    const names = companies.map((c) => c.name);
    // Keep a company from the URL selectable even if it has no open tasks any more.
    if (route.company && !names.includes(route.company)) return [{ name: route.company, open: 0 }, ...companies];
    return companies;
  }, [companies, route.company]);

  // The mailbox the list is narrowed to, by name (null when all mailboxes are shown).
  const view = viewOf(mailboxes, viewId);
  const viewName = view ? (mailboxNames(mailboxes).get(view.id) ?? view.address) : null;

  // The five segments, plus the active one when a link opened another view (e.g. “Snoozed” from Today).
  const bar: ListFilter[] = FILTER_BAR.includes(filter) ? [...FILTER_BAR] : ["all", filter, ...FILTER_BAR.filter((f) => f !== "all")];

  return (
    <div className="list-screen" data-focus-fallback="list-h">
      <header className="bridge bridge-compact list-bridge">
        <h1 id="list-h" className="list-title" tabIndex={-1}>
          All tasks
        </h1>
        <nav className="filterbar" aria-label="Filters">
          {bar.map((tab) => {
            const active = tab === filter;
            const n = tab === "snoozed" ? (active ? data?.items.length : undefined) : data?.counts[apiTab(tab)];
            // Only filters with something in them (plus “Open” and the current one).
            if (!active && tab !== "all" && n === 0) return null;
            return (
              <a key={tab} href={routeHref({ ...route, tab })} className="filter" aria-current={active ? "page" : undefined}>
                <span>{TAB_LABELS[tab]}</span>
                {n !== undefined ? <span className="count">{n}</span> : null}
              </a>
            );
          })}
        </nav>
      </header>

      <div className="filters" role="search">
        <label className="field field-grow">
          <span className="sr-only">Search</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search: title, company, contact, subject…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.querySelector<HTMLAnchorElement>("a[data-row-link]")?.focus();
              }
            }}
          />
        </label>
        <label className="field">
          <span className="sr-only">Company</span>
          <select value={route.company ?? ""} onChange={(e) => setCompany(e.target.value || null)}>
            <option value="">All companies</option>
            {companyOptions.map((c) => (
              <option key={c.name} value={c.name}>
                {c.open > 0 ? `${c.name} (${c.open})` : c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="list-head">
          <label className="check">
            <input ref={selectAllRef} type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span>{selected.size > 0 ? plural(selected.size, "selected", "selected") : "Select all"}</span>
          </label>
        </div>
      ) : null}

      {loading && !data ? <p className="muted loading">Loading…</p> : null}

      {!loading && !error && items.length === 0 ? (
        <>
          <p className="empty">{route.q.trim() ? `Nothing found for “${route.q.trim()}”.` : EMPTY_TEXT[filter]}</p>
          {viewName ? (
            <p className="empty-view">
              You are looking at the mailbox {viewName} only.{" "}
              <button type="button" className="btn btn-small" onClick={() => setView(null)}>
                Show all mailboxes
              </button>
            </p>
          ) : null}
        </>
      ) : null}

      <ul className={loading && data ? "rows is-stale" : "rows"} ref={listRef} onKeyDown={onListKey} aria-label={TAB_LABELS[filter]} aria-busy={loading}>
        {items.map((item) => (
          <TaskRow
            key={item.id}
            item={item}
            zone={zone}
            today={today}
            onChanged={(change) => onRowChanged(change, item.id)}
            showQuote={filter !== "closed"}
            selectable={{ selected: selected.has(item.id), onToggle: () => toggle(item.id) }}
          />
        ))}
      </ul>

      {data?.nextCursor ? (
        <div className="more">
          <button type="button" className="btn" aria-disabled={loadingMore || undefined} onClick={() => !loadingMore && void load(data.nextCursor)}>
            {loadingMore ? "Loading…" : "More"}
          </button>
        </div>
      ) : null}

      {selected.size > 0 ? (
        <div className="bulkbar" role="region" aria-label="Bulk actions">
          <span className="bulkbar-count">{plural(selected.size, "selected", "selected")}</span>
          <div className="bulkbar-actions">
            <button type="button" className="btn btn-primary" onClick={() => setBulk({ kind: "complete" })}>
              Done
            </button>
            <button type="button" className="btn" onClick={() => setBulk({ kind: "not_a_task" })}>
              Not a task
            </button>
            <button type="button" className="btn" onClick={() => setBulk({ kind: "snooze" })}>
              Snooze
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setSelected(new Set())}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {bulk?.kind === "complete" ? (
        <ConfirmDialog
          title="Done"
          message={`Mark ${plural(selected.size, "task", "tasks")} as “Done”?`}
          confirmLabel="Done"
          busy={bulkBusy}
          onConfirm={() => void runBulk({ action: "complete" }, "Done")}
          onCancel={() => setBulk(null)}
        />
      ) : null}
      {bulk?.kind === "not_a_task" ? (
        <ConfirmDialog
          title="Not a task"
          message={`Remove ${plural(selected.size, "task", "tasks")}? The AI will remember they weren't tasks.`}
          confirmLabel="Remove"
          danger
          busy={bulkBusy}
          onConfirm={() => void runBulk({ action: "dismiss", kind: "not_a_task" }, "Removed")}
          onCancel={() => setBulk(null)}
        />
      ) : null}
      {bulk?.kind === "snooze" ? (
        <SnoozeDialog
          today={today}
          title={`Snooze ${plural(selected.size, "task", "tasks")}`}
          allowUntilReply={selectedItems.length > 0 && selectedItems.every((i) => i.status === "WAITING_FOR_OTHER")}
          busy={bulkBusy}
          onConfirm={onSnooze}
          onClose={() => setBulk(null)}
        />
      ) : null}
    </div>
  );
}
