/**
 * “What matters to me”: the user's own rules (src/domain/preferences.ts). Important senders come first with ★;
 * muted senders never reach the AI; the Cc rule decides what a Cc-only request becomes; the profile tells the AI,
 * as data, what the user handles. Saved as one object; the bar at the bottom appears only with unsaved changes.
 */
import { AtSign, BellOff, Building2, ListChecks, Mail, Star, Truck, UserRound, X } from "lucide-react";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { MailRulesView, Preferences as Prefs } from "../../../src/server/api-types.js";
import type { MailRule, RuleKind } from "../../../src/domain/rules.js";
import { entryKind, parseEntry, PREFERENCE_LIMITS } from "../../../src/domain/preferences.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { CompanyDatalist } from "../components/CompanyDatalist.js";
import { useToast } from "../components/Toast.js";
import { useDocumentTitle } from "../hooks.js";
import { routeHref } from "../router.js";

type Draft = Omit<Prefs, "own">;

const CC_CHOICES: Array<{ value: Draft["ccPolicy"]; label: string; hint: string }> = [
  { value: "ask", label: "Ask me", hint: "The task goes to “Needs a look”, and you decide." },
  { value: "create", label: "Create it as usual", hint: "As if they had asked you directly." },
  { value: "ignore", label: "Ignore it", hint: "Requests where you're only in Cc don't become tasks." },
];

const draftOf = (p: Prefs): Draft => ({ important: p.important, muted: p.muted, ccPolicy: p.ccPolicy, profile: p.profile });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function Preferences() {
  useDocumentTitle("What matters to me");
  const toast = useToast();
  const [saved, setSaved] = useState<Prefs | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoadError(null);
    api
      .preferences()
      .then((p) => {
        setSaved(p);
        setDraft(draftOf(p));
      })
      .catch((err) => !(isApiError(err) && err.handled) && setLoadError(errorMessage(err)));
  };
  useEffect(load, []);

  const dirty = saved && draft ? !same(draftOf(saved), draft) : false;

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const p = await api.savePreferences({ ...draft, profile: draft.profile?.trim() ? draft.profile : null });
      setSaved(p);
      setDraft(draftOf(p));
      toast("Saved. It applies from the next email.", "success");
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setSaveError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="page prefs">
        <PrefsHeader />
        <div className="error-box" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={load}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!saved || !draft) {
    return (
      <div className="page prefs">
        <PrefsHeader />
        <p className="muted loading">Loading…</p>
      </div>
    );
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const profileLen = draft.profile?.length ?? 0;

  return (
    <form className={`page prefs${dirty ? " is-dirty" : ""}`} onSubmit={(e) => void save(e)}>
      <PrefsHeader />

      <section className="card prefs-card" aria-labelledby="p-important">
        <div className="prefs-head">
          <span className="prefs-icon prefs-icon-key" aria-hidden="true">
            <Star size={18} />
          </span>
          <div>
            <h2 id="p-important" className="section-title">
              Important
            </h2>
            <p className="prefs-lead">Customers and senders who come first. Their tasks go to the top of every column on “Today”, with a ★.</p>
          </div>
        </div>
        <EntryList
          list="important"
          values={draft.important}
          onChange={(v) => set("important", v)}
          placeholder="e.g. ABC Audio, @delta-events-gr.example or maria@abc-gr.example"
          empty="Nobody yet. Add the customers who shouldn't have to wait."
          datalist="prefs-companies"
        />
        <CompanyDatalist id="prefs-companies" />
      </section>

      <section className="card prefs-card" aria-labelledby="p-muted">
        <div className="prefs-head">
          <span className="prefs-icon" aria-hidden="true">
            <BellOff size={18} />
          </span>
          <div>
            <h2 id="p-muted" className="section-title">
              Ignore
            </h2>
            <p className="prefs-lead">
              Emails or domains you never want tasks from. The AI doesn't even read them. What you send to them still counts as usual.
            </p>
          </div>
        </div>
        <EntryList
          list="muted"
          values={draft.muted}
          onChange={(v) => set("muted", v)}
          placeholder="e.g. @newsletter-xyz.example or offers@supplier-gr.example"
          empty="Nothing yet. Newsletters, automatic replies and no-reply senders are already filtered out on their own."
        />
      </section>

      <section className="card prefs-card" aria-labelledby="p-cc">
        <div className="prefs-head">
          <span className="prefs-icon" aria-hidden="true">
            <UserRound size={18} />
          </span>
          <div>
            <h2 id="p-cc" className="section-title">
              When you're only in Cc
            </h2>
            <p className="prefs-lead">When someone writes to someone else with you in Cc, and the AI finds a request that is probably meant for you.</p>
          </div>
        </div>
        <fieldset className="prefs-choices">
          <legend className="sr-only">When you're only in Cc</legend>
          {CC_CHOICES.map((c) => (
            <label key={c.value} className={`prefs-choice${draft.ccPolicy === c.value ? " is-on" : ""}`}>
              <input type="radio" name="ccPolicy" value={c.value} checked={draft.ccPolicy === c.value} onChange={() => set("ccPolicy", c.value)} />
              <span className="prefs-choice-text">
                <span className="prefs-choice-label">
                  {c.label}
                  {c.value === "ask" ? <span className="prefs-default">default</span> : null}
                </span>
                <span className="prefs-choice-hint">{c.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card prefs-card" aria-labelledby="p-profile">
        <div className="prefs-head">
          <span className="prefs-icon prefs-icon-ai" aria-hidden="true">
            <Building2 size={18} />
          </span>
          <div>
            <h2 id="p-profile" className="section-title">
              About your work
            </h2>
            <p className="prefs-lead">In your own words: what you do and what you don't. The AI reads it as a description of you, to tell what is meant for you — not as an instruction.</p>
          </div>
        </div>
        <label className="field">
          <span className="sr-only">About your work</span>
          <textarea
            rows={4}
            maxLength={PREFERENCE_LIMITS.profileChars}
            value={draft.profile ?? ""}
            onChange={(e) => set("profile", e.target.value)}
            placeholder="e.g. I sell professional audio to hotels and theatres. I don't handle service and repairs, or invoicing: Maria does those."
          />
        </label>
        <p className="prefs-foot">
          <span>Applies when the AI is on (not in test mode).</span>
          <span className="prefs-count">
            {profileLen}/{PREFERENCE_LIMITS.profileChars}
          </span>
        </p>
      </section>

      {/* “Suppliers” have their own screen: the tasks of each one, and who they are. */}
      <a className="card prefs-link" href={routeHref({ name: "suppliers" })}>
        <span className="prefs-icon" aria-hidden="true">
          <Truck size={18} />
        </span>
        <span className="prefs-link-text">
          <strong>Suppliers</strong>
          <span>Who your suppliers are (a name and an email address or a domain). Their tasks are gathered supplier by supplier.</span>
        </span>
      </a>

      <RulesCard />

      {saveError ? (
        <p className="form-error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="prefs-savebar" role="region" aria-label="Save" hidden={!dirty}>
        <span>You have unsaved changes.</span>
        <div className="prefs-savebar-actions">
          <button type="button" className="btn" onClick={() => setDraft(draftOf(saved))} disabled={busy}>
            Discard
          </button>
          <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

const RULE_KIND_LABEL: Record<RuleKind, string> = {
  spam: "Spam",
  ignore: "Ignore",
  forward: "Forward",
  answered: "Answered",
  updates: "Updates",
  summary: "Summary",
  note: "For the AI",
  supplier: "Supplier",
};

/** What a rule matches, in one line (the rule's own words are its title). */
function ruleDetails(r: MailRule): string {
  const parts: string[] = [];
  if (r.topics?.length) parts.push(`words: ${r.topics.join(", ")}`);
  if (r.except?.length) parts.push(`except: ${r.except.join(", ")}`);
  if (r.recipients?.length) parts.push(`when the recipients include: ${r.recipients.join(", ")}`);
  if (r.target) parts.push(`when ${r.target} isn't in To or Cc`);
  if (r.kind === "note") parts.push("the AI reads it when it's on");
  return parts.join(" · ");
}

/**
 * “Rules” (src/domain/rules.ts): the user's own rules, each switched on or off at once (not part of the form's
 * save bar). The list itself comes from `pnpm cli rules:import` (docs/rules/README.md). The suppliers are rules
 * too, with a screen of their own (“Suppliers”): they are not listed here.
 */
function RulesCard() {
  const toast = useToast();
  const [view, setView] = useState<MailRulesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api
      .rules()
      .then(setView)
      .catch((err) => !(isApiError(err) && err.handled) && setError(errorMessage(err)));
  }, []);
  const rules = useMemo(() => (view?.rules ?? []).filter((r) => r.kind !== "supplier"), [view]);

  const toggle = async (r: MailRule) => {
    if (busy) return;
    setBusy(r.id);
    try {
      setView(await api.setRuleEnabled(r.id, !r.enabled));
      toast(r.enabled ? "Rule turned off." : "Rule turned on.", "success");
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card prefs-card" aria-labelledby="p-rules">
      <div className="prefs-head">
        <span className="prefs-icon" aria-hidden="true">
          <ListChecks size={18} />
        </span>
        <div>
          <h2 id="p-rules" className="section-title">
            Rules
          </h2>
          <p className="prefs-lead">Your own rules for what becomes a task, what is ignored and what goes into the report. Turn them on and off here; they apply from the next email.</p>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : !view ? (
        <p className="muted loading">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="entry-empty">No rules yet.</p>
      ) : (
        <ul className="prefs-choices" aria-label="Rules">
          {rules.map((r) => {
            const details = ruleDetails(r);
            return (
              <li key={r.id}>
                <label className={`prefs-choice${r.enabled ? " is-on" : ""}`}>
                  <input type="checkbox" checked={r.enabled} disabled={busy !== null} aria-busy={busy === r.id || undefined} onChange={() => void toggle(r)} />
                  <span className="prefs-choice-text">
                    <span className="prefs-choice-label">
                      {r.text}
                      <span className="prefs-default">{RULE_KIND_LABEL[r.kind]}</span>
                    </span>
                    {details ? <span className="prefs-choice-hint">{details}</span> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {view?.skipped.length ? (
        <p className="form-error">
          Couldn't read: {view.skipped.map((s) => `${s.id} (${s.error})`).join(", ")}
        </p>
      ) : null}
    </section>
  );
}

function PrefsHeader() {
  return (
    <header className="bridge bridge-compact">
      <h1 className="page-title">What matters to me</h1>
      <p className="bridge-sub">Who comes first, what MailMe should ignore, and what your work is about. Changes apply from the next email; the ★ shows up right away.</p>
    </header>
  );
}

const KIND_ICON = { address: Mail, domain: AtSign, company: Building2 } as const;
const KIND_LABEL = { address: "email", domain: "domain", company: "company" } as const;

/** Chips with a remove button, and an input that validates an entry the same way the server does. */
function EntryList({
  list,
  values,
  onChange,
  placeholder,
  empty,
  datalist,
}: {
  list: "important" | "muted";
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  empty: string;
  datalist?: string;
}) {
  const inputId = useId();
  const errorId = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keys = useMemo(() => new Set(values.map((v) => v.toLowerCase())), [values]);

  const add = () => {
    const p = parseEntry(text, list);
    if (!p.ok) {
      setError(p.error);
      return;
    }
    if (!keys.has(p.entry.value.toLowerCase())) onChange([...values, p.entry.value]);
    setText("");
    setError(null);
  };

  return (
    <div className="entries">
      {values.length > 0 ? (
        <ul className="entry-chips" aria-label={list === "important" ? "Important" : "Ignored"}>
          {values.map((v) => {
            const kind = entryKind(v);
            const Icon = KIND_ICON[kind];
            return (
              <li key={v} className={`entry-chip entry-${list}`}>
                <Icon size={14} aria-hidden="true" />
                <span className="entry-text">{v}</span>
                <span className="sr-only"> ({KIND_LABEL[kind]})</span>
                <button type="button" className="entry-remove" aria-label={`Remove: ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="entry-empty">{empty}</p>
      )}
      <div className="entry-add">
        <label className="sr-only" htmlFor={inputId}>
          {list === "important" ? "New important sender" : "New sender to ignore"}
        </label>
        <input
          id={inputId}
          value={text}
          list={datalist}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" onClick={add}>
          Add
        </button>
      </div>
      {error ? (
        <p id={errorId} className="form-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
