/**
 * “Suppliers”: the user's open tasks supplier by supplier and, on the same screen, who the suppliers are
 * (src/domain/suppliers.ts): a name and the addresses or "@domain" entries its mail comes from. A task belongs to a
 * supplier when its counterparty is one of those senders, so naming a supplier sorts the tasks that exist already,
 * at once. With a per-mailbox view (mailbox-view.ts) the tasks are of that one mailbox; the suppliers themselves are
 * the user's, whatever the view.
 */
import { AtSign, Mail, Truck, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { companyKey, parseEntry } from "../../../src/domain/preferences.js";
import type { MailRule } from "../../../src/domain/rules.js";
import { parseSupplierList } from "../../../src/domain/suppliers.js";
import type { MailRulesView, SupplierGroup } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api, viewGone } from "../client.js";
import { ConfirmDialog } from "../components/Dialog.js";
import { TaskRow, type RowChange } from "../components/TaskRow.js";
import { useToast } from "../components/Toast.js";
import { restoreFocus, type FocusPlan } from "../focus.js";
import { plural } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { mailboxNames, viewOf } from "../mailbox-view.js";
import { DEFAULT_LIST, routeHref } from "../router.js";
import { setLastListHref } from "./TaskList.js";

const listOf = (id: string) => routeHref({ ...DEFAULT_LIST, supplier: id });

/** The server's own sentence for a refused entry (it names the entry and the reason); the general text otherwise. */
const refusal = (err: unknown) => (isApiError(err) && err.code === "invalid" && err.serverMessage ? err.serverMessage : errorMessage(err));

export function Suppliers() {
  const { zone, today, viewId, mailboxes, setView } = useApp();
  const [groups, setGroups] = useState<SupplierGroup[] | null>(null);
  const [rules, setRules] = useState<MailRulesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const focusPlan = useRef<FocusPlan | null>(null);
  useDocumentTitle("Suppliers");
  useEffect(() => setLastListHref(routeHref({ name: "suppliers" })), []);

  // Every quick action and every change to the suppliers reloads; only the latest request may land.
  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await api.suppliers(viewId);
      if (n !== seq.current) return;
      setGroups(res.suppliers);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      // A view the server no longer knows was dropped: this runs again for all mailboxes.
      if (viewGone(err, viewId)) return;
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    }
  }, [viewId]);

  useEffect(() => {
    void load();
  }, [load, today]);

  // Who the suppliers are (the rules themselves, the switched-off ones too), for the card at the bottom.
  const alive = useRef(true);
  const loadRules = useCallback(() => {
    api
      .rules()
      .then((v) => alive.current && setRules(v))
      .catch((err: unknown) => alive.current && !(isApiError(err) && err.handled) && setError(errorMessage(err)));
  }, []);
  useEffect(() => {
    alive.current = true;
    loadRules();
    return () => {
      alive.current = false;
    };
  }, [loadRules]);

  // After the reload that removed a row: focus its neighbour instead of leaving it on <body>.
  useEffect(() => {
    if (!focusPlan.current) return;
    restoreFocus({ targets: [...focusPlan.current.targets, "#suppliers-h"] });
    focusPlan.current = null;
  }, [groups]);

  const onRowChanged = useCallback(
    (change: RowChange) => {
      if (change.focus) focusPlan.current = change.focus;
      void load();
    },
    [load],
  );

  const onRulesChanged = useCallback(
    (next: MailRulesView) => {
      setRules(next);
      void load();
    },
    [load],
  );

  const view = viewOf(mailboxes, viewId);
  const viewName = view ? (mailboxNames(mailboxes).get(view.id) ?? view.address) : null;
  const busy = (groups ?? []).filter((g) => g.open > 0);
  const quiet = (groups ?? []).filter((g) => g.open === 0);
  const total = busy.reduce((n, g) => n + g.open, 0);

  return (
    <div className="list-screen suppliers" data-focus-fallback="suppliers-h">
      <header className="bridge bridge-compact">
        <h1 id="suppliers-h" className="page-title" tabIndex={-1}>
          Suppliers
        </h1>
        <p className="bridge-sub">
          {groups && groups.length > 0
            ? total > 0
              ? `${plural(total, "open task", "open tasks")} with ${plural(busy.length, "supplier", "suppliers")}: what they ask of you, what you promised, what you are waiting for.`
              : "No open tasks with a supplier right now."
            : "The tasks with each of your suppliers, gathered supplier by supplier."}
        </p>
      </header>

      {error ? (
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void load();
              if (!rules) loadRules();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}

      {!groups && !error ? <p className="muted loading">Loading…</p> : null}

      {busy.map((g) => (
        <section key={g.id} className="sup-group" aria-labelledby={`sup-${g.id}`} data-focus-fallback={`sup-${g.id}`}>
          <header className="sup-head">
            <h2 id={`sup-${g.id}`} className="sup-name" tabIndex={-1}>
              <Truck size={17} aria-hidden="true" />
              {g.name} <span className="count">{g.open}</span>
            </h2>
            <span className="sup-senders">{g.senders.join(" · ")}</span>
            <a className="sup-all" href={listOf(g.id)}>
              See in the list
            </a>
          </header>
          <ul className="rows" aria-label={`Tasks: ${g.name}`}>
            {g.items.map((item) => (
              <TaskRow key={item.id} item={item} zone={zone} today={today} onChanged={onRowChanged} showSupplier={false} />
            ))}
          </ul>
          {g.open > g.items.length ? (
            <p className="sup-rest">
              <a href={listOf(g.id)}>{g.open - g.items.length} more in the list</a>
            </p>
          ) : null}
        </section>
      ))}

      {groups && groups.length > 0 && total === 0 && viewName ? (
        <p className="empty-view">
          You are looking at the mailbox {viewName} only.{" "}
          <button type="button" className="btn btn-small" onClick={() => setView(null)}>
            Show all mailboxes
          </button>
        </p>
      ) : null}

      {quiet.length > 0 ? (
        <p className="sup-quiet">
          <span>No open tasks:</span>{" "}
          {quiet.map((g, i) => (
            <span key={g.id}>
              {i > 0 ? ", " : ""}
              <a href={listOf(g.id)} title={g.senders.join(" · ")}>
                {g.name}
              </a>
            </span>
          ))}
        </p>
      ) : null}

      {rules ? <SupplierSetup view={rules} onChanged={onRulesChanged} /> : null}
    </div>
  );
}

/**
 * Who the suppliers are. Every change is saved at once (there is no save bar): a new supplier, one more address or
 * domain for one that exists, one taken away, a supplier switched off or removed. A pasted list (a table from a
 * sheet: name, then its addresses or domains) is shown as it was understood before anything is saved.
 */
function SupplierSetup({ view, onChanged }: { view: MailRulesView; onChanged: (next: MailRulesView) => void }) {
  const toast = useToast();
  const nameId = useId();
  const senderId = useId();
  const listId = useId();
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [sender, setSender] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listText, setListText] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<MailRule | null>(null);

  const suppliers = useMemo(() => view.rules.filter((r) => r.kind === "supplier"), [view]);
  const parsed = useMemo(() => parseSupplierList(listText), [listText]);

  /** One change: the server's answer becomes the list; a refusal is returned as its sentence. */
  const run = async (fn: () => Promise<MailRulesView>, done: string): Promise<string | null> => {
    if (busy) return null;
    setBusy(true);
    try {
      onChanged(await fn());
      toast(done, "success");
      return null;
    } catch (err) {
      if (isApiError(err) && err.handled) return null;
      return refusal(err);
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError("Write the supplier's name.");
    const p = parseEntry(sender, "muted");
    if (!p.ok) return setError(sender.trim() ? p.error : "Write their email address (e.g. info@example.com) or their domain (e.g. @example.com).");
    // The same supplier as the server sees it: whatever the case and the accents of the name.
    const known = suppliers.find((r) => companyKey(r.name ?? "") === companyKey(n) && companyKey(n) !== "");
    const failed = await run(
      () => api.saveSuppliers({ suppliers: [{ name: n, senders: [p.entry.value] }], mode: "add" }),
      known ? `${p.entry.value} was added to the supplier ${known.name}.` : `The supplier ${n} was added.`,
    );
    setError(failed);
    if (!failed) {
      setName("");
      setSender("");
    }
  };

  const addList = async () => {
    if (parsed.entries.length === 0) return;
    const failed = await run(() => api.saveSuppliers({ suppliers: parsed.entries, mode: "add" }), parsed.entries.length === 1 ? "1 supplier saved." : `${parsed.entries.length} suppliers saved.`);
    setListError(failed);
    if (!failed) setListText("");
  };

  const toggle = async (r: MailRule) => {
    const failed = await run(() => api.setRuleEnabled(r.id, !r.enabled), r.enabled ? `The supplier ${r.name} is switched off.` : `The supplier ${r.name} is switched on again.`);
    if (failed) toast(failed, "error");
  };

  const dropSender = async (r: MailRule, entry: string) => {
    const rest = (r.senders ?? []).filter((s) => s !== entry);
    const failed = await run(() => api.saveSuppliers({ suppliers: [{ name: r.name ?? r.text, senders: rest }], mode: "replace" }), `${entry} was removed.`);
    if (failed) toast(failed, "error");
  };

  const remove = async (r: MailRule) => {
    const failed = await run(() => api.removeSupplier(r.id), `The supplier ${r.name} was removed.`);
    if (failed) toast(failed, "error");
    setRemoving(null);
  };

  return (
    <section className="card prefs-card sup-setup" aria-labelledby="sup-setup-h">
      <div className="prefs-head">
        <span className="prefs-icon" aria-hidden="true">
          <Truck size={18} />
        </span>
        <div>
          <h2 id="sup-setup-h" className="section-title">
            Who your suppliers are
          </h2>
          <p className="prefs-lead">
            A name and the email address or the domain they write from. Every task with someone from there takes the supplier's name and is gathered here. It applies at once, to the tasks you
            already have too; it does not change what becomes a task.
          </p>
        </div>
      </div>

      {suppliers.length > 0 ? (
        <ul className="sup-rules" aria-label="Suppliers">
          {suppliers.map((r) => {
            const senders = r.senders ?? [];
            return (
              <li key={r.id} className={r.enabled ? "sup-rule" : "sup-rule is-off"}>
                <label className="sup-rule-on" title={r.enabled ? "Switched on" : "Switched off"}>
                  <input type="checkbox" checked={r.enabled} disabled={busy} onChange={() => void toggle(r)} aria-label={`Switched on: ${r.name}`} />
                </label>
                <div className="sup-rule-body">
                  <span className="sup-rule-name">
                    {r.name}
                    {r.enabled ? null : <span className="prefs-default">off</span>}
                  </span>
                  <ul className="entry-chips" aria-label={`Addresses: ${r.name}`}>
                    {senders.map((s) => {
                      const Icon = s.startsWith("@") ? AtSign : Mail;
                      return (
                        <li key={s} className="entry-chip">
                          <Icon size={14} aria-hidden="true" />
                          <span className="entry-text">{s.startsWith("@") ? s.slice(1) : s}</span>
                          <span className="sr-only"> ({s.startsWith("@") ? "domain" : "email"})</span>
                          {/* The last one stays: a supplier without a sender is removed as a whole. */}
                          {senders.length > 1 ? (
                            <button type="button" className="entry-remove" aria-label={`Remove: ${s}`} disabled={busy} onClick={() => void dropSender(r, s)}>
                              <X size={14} aria-hidden="true" />
                            </button>
                          ) : (
                            <span className="entry-last" aria-hidden="true" />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => setRemoving(r)}>
                  Remove<span className="sr-only">: {r.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="entry-empty sup-none">None yet. Add the first one, or paste your whole list below.</p>
      )}

      <form className="sup-add" onSubmit={(e) => void add(e)} noValidate>
        <div className="sup-add-fields">
          <label className="field" htmlFor={nameId}>
            <span>Supplier</span>
            <input
              id={nameId}
              value={name}
              maxLength={60}
              placeholder="e.g. ABC Audio"
              autoComplete="off"
              list="sup-names"
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
            />
          </label>
          <label className="field field-grow" htmlFor={senderId}>
            <span>Email address or domain</span>
            <input
              id={senderId}
              value={sender}
              placeholder="e.g. @abc-audio.example or sales@abc-audio.example"
              autoComplete="off"
              inputMode="email"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setSender(e.target.value);
                if (error) setError(null);
              }}
            />
          </label>
          <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined}>
            Add
          </button>
        </div>
        <datalist id="sup-names">
          {suppliers.map((r) => (
            <option key={r.id} value={r.name} />
          ))}
        </datalist>
        <p className="sup-hint">For one more email address or domain of the same supplier, write their name again.</p>
        {error ? (
          <p id={errorId} className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      <details className="sup-paste">
        <summary>Paste a list</summary>
        <div className="sup-paste-body">
          <label className="field" htmlFor={listId}>
            <span>A name with its email address or @domain next to it or below it, as in a table</span>
            <textarea
              id={listId}
              rows={6}
              value={listText}
              placeholder={"ABC Audio   @abc-audio.example\nNorthwind   @northwind.example  orders@nw-parts.example"}
              spellCheck={false}
              onChange={(e) => {
                setListText(e.target.value);
                if (listError) setListError(null);
              }}
            />
          </label>
          {parsed.entries.length > 0 ? (
            <ul className="sup-preview" aria-label="To be added">
              {parsed.entries.map((e) => (
                <li key={e.name}>
                  <strong>{e.name}</strong> <span>{e.senders.join(" · ")}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {parsed.ignored.length > 0 ? <p className="sup-hint">Left out, no email address or domain: {parsed.ignored.join(", ")}</p> : null}
          {parsed.errors.length > 0 ? (
            <ul className="form-error sup-errors">
              {parsed.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          {listError ? (
            <p className="form-error" role="alert">
              {listError}
            </p>
          ) : null}
          <div>
            <button type="button" className="btn btn-primary" disabled={busy || parsed.entries.length === 0} onClick={() => void addList()}>
              {parsed.entries.length > 0 ? `Add ${plural(parsed.entries.length, "supplier", "suppliers")}` : "Add"}
            </button>
          </div>
        </div>
      </details>

      {removing ? (
        <ConfirmDialog
          title="Remove supplier"
          message={`Remove the supplier ${removing.name}? Their tasks stay as they are; they will just no longer be gathered under this name.`}
          confirmLabel="Remove"
          danger
          busy={busy}
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}
