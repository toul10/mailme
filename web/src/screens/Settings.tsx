/**
 * Settings: "What matters to me" and "AI costs" (links), mailboxes (list + add), the suppliers, system status with
 * what the worker is doing now, messages that could not be analysed, daily-report preferences (read-only), account.
 */
import { CircleDollarSign, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { MailRulesView, MailboxSummary } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { useToast } from "../components/Toast.js";
import { agoLabel, formatDateTime, minutesSince } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { mailboxShortNames } from "../mailbox-view.js";
import { SyncActivityPanel } from "../shell/SyncStatus.js";
import { DELIVERY_LABELS, MAILBOX_STATUS_LABELS } from "../labels.js";
import { EMPTY_MAILBOX_FORM, mailboxCreateRequest, validateMailboxForm, type MailboxFormState } from "../mailbox-form.js";
import { parkedErrorLabel, useParkedMessages } from "../problems.js";
import { navigate, routeHref } from "../router.js";
import { AliasEditor } from "./AliasEditor.js";
import { SupplierSetup } from "./Suppliers.js";

export function MailboxStatusPill({ mailbox }: { mailbox: Pick<MailboxSummary, "status"> }) {
  return <span className={`pill pill-mailbox pill-mb-${mailbox.status.replace(/_/g, "-")}`}>{MAILBOX_STATUS_LABELS[mailbox.status]}</span>;
}

export function Settings() {
  useDocumentTitle("Settings");
  const { me, logout } = useApp();
  const [mailboxes, setMailboxes] = useState<MailboxSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listMailboxes();
      setMailboxes(r.mailboxes);
      setError(null);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page settings">
      <header className="bridge bridge-compact">
        <h1 className="page-title">Settings</h1>
      </header>

      <a className="card prefs-link" href={routeHref({ name: "preferences" })}>
        <span className="prefs-icon prefs-icon-key" aria-hidden="true">
          <SlidersHorizontal size={18} />
        </span>
        <span className="prefs-link-text">
          <strong>What matters to me</strong>
          <span>Important customers, senders you ignore, what happens when you're only in Cc, and what your work is about.</span>
        </span>
      </a>

      <a className="card prefs-link" href={routeHref({ name: "costs" })}>
        <span className="prefs-icon prefs-icon-ai" aria-hidden="true">
          <CircleDollarSign size={18} />
        </span>
        <span className="prefs-link-text">
          <strong>AI costs</strong>
          <span>What the AI costs: today, this month, day by day, and each mailbox's daily limits.</span>
        </span>
      </a>

      <section className="card" aria-labelledby="mb-h">
        <div className="section-head">
          <h2 id="mb-h" className="section-title">
            Mailboxes
          </h2>
          {!adding ? (
            <button type="button" className="btn btn-small" onClick={() => setAdding(true)}>
              + Add
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="error-box" role="alert">
            <p>{error}</p>
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}
        {mailboxes === null && !error ? <p className="muted">Loading…</p> : null}
        {mailboxes?.length === 0 && !adding ? <p className="muted">No mailbox set up yet.</p> : null}
        {mailboxes && mailboxes.length > 0 ? (
          <ul className="mailbox-list">
            {mailboxes.map((m) => (
              <li key={m.id}>
                <a className="mailbox-row" href={routeHref({ name: "mailbox", id: m.id })}>
                  <span className="mailbox-address">
                    {m.address}
                    {m.displayName ? <span className="muted"> · {m.displayName}</span> : null}
                  </span>
                  <span className="row-chips">
                    <MailboxStatusPill mailbox={m} />
                    {m.aiPaused ? <span className="chip chip-today">AI paused</span> : null}
                    {!m.hasCredentials && m.provider === "imap" ? <span className="chip chip-quiet">no password</span> : null}
                    <span className="muted small">{m.lastSyncAt ? `synced ${agoLabel(minutesSince(m.lastSyncAt))}` : "not synced yet"}</span>
                  </span>
                  {m.lastError ? <span className="small text-danger">{m.lastError}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {adding ? (
          <AddMailboxForm
            onCancel={() => setAdding(false)}
            onCreated={(m) => {
              setAdding(false);
              navigate({ name: "mailbox", id: m.id });
            }}
          />
        ) : null}
      </section>

      <SuppliersCard hasMailboxes={mailboxes === null ? null : mailboxes.length > 0} />

      <HealthCard />

      <ParkedMessagesCard />

      <section className="card" aria-labelledby="digest-h">
        <h2 id="digest-h" className="section-title">
          Daily report
        </h2>
        <dl className="facts">
          <div className="fact">
            <dt>Status</dt>
            <dd>{me.digestEnabled ? "On" : "Off"}</dd>
          </div>
          <div className="fact">
            <dt>Send time</dt>
            <dd>{me.digestTime} (business days)</dd>
          </div>
          <div className="fact">
            <dt>Delivery</dt>
            <dd>{DELIVERY_LABELS[me.digestDelivery]}</dd>
          </div>
          <div className="fact">
            <dt>Time zone</dt>
            <dd>{me.timezone}</dd>
          </div>
        </dl>
        <p className="muted small">Your admin can change the report settings.</p>
      </section>

      <section className="card" aria-labelledby="acct-h">
        <h2 id="acct-h" className="section-title">
          Account
        </h2>
        <dl className="facts">
          <div className="fact">
            <dt>Name</dt>
            <dd>{me.name}</dd>
          </div>
          <div className="fact">
            <dt>Email</dt>
            <dd>{me.email}</dd>
          </div>
          <div className="fact">
            <dt>Role</dt>
            <dd>{me.role === "admin" ? "Admin" : "User"}</dd>
          </div>
          <div className="fact">
            <dt>Two-step verification</dt>
            <dd>{me.mfaVerified ? "On" : "Not in this session"}</dd>
          </div>
        </dl>
        <div className="button-row">
          <button type="button" className="btn" onClick={logout}>
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * "Suppliers" in Settings too (the same card as on their own screen, Suppliers.tsx). They belong to the account
 * whose mailboxes they sort, so an account without mailboxes only reads where they are set.
 */
function SuppliersCard({ hasMailboxes }: { hasMailboxes: boolean | null }) {
  const [rules, setRules] = useState<MailRulesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .rules()
      .then((v) => alive && setRules(v))
      .catch((err: unknown) => alive && !(isApiError(err) && err.handled) && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, []);
  if (hasMailboxes === false) {
    return (
      <section className="card" aria-labelledby="sup-none-h">
        <h2 id="sup-none-h" className="section-title">
          Suppliers
        </h2>
        <p className="muted small">Suppliers are set by the account that owns the mailboxes; this one has none.</p>
      </section>
    );
  }
  if (error) {
    return (
      <section className="card" aria-label="Suppliers">
        <p className="form-error">{error}</p>
      </section>
    );
  }
  return rules ? <SupplierSetup view={rules} onChanged={setRules} screenLink /> : null;
}

/** System status, with what the worker is doing now (the shell keeps `health` fresh: every 5 s while it works). */
function HealthCard() {
  const { health, syncView, zone, mailboxes } = useApp();
  return (
    <section className="card" aria-labelledby="health-h">
      <h2 id="health-h" className="section-title">
        System status
      </h2>
      {!health ? <p className="muted">Loading…</p> : null}
      {health ? (
        <>
          <SyncActivityPanel
            view={syncView}
            mailboxes={health.activity.mailboxes}
            ctx={{ now: new Date(), zone, names: mailboxShortNames(mailboxes) }}
          />
          {/* As in the shell: a pause or a delay is told above, with when it goes on; the banner only for a problem to fix. */}
          {health.banner && syncView.tone === "error" ? (
            <p className="banner banner-danger" role="alert">
              {health.banner}
            </p>
          ) : null}
          <dl className="facts">
            <div className="fact">
              <dt>Last sync</dt>
              <dd>{health.lastSyncAt ? agoLabel(health.staleMinutes ?? minutesSince(health.lastSyncAt)) : "never"}</dd>
            </div>
            <div className="fact">
              <dt>Waiting for analysis</dt>
              <dd>
                {health.pendingCount}
                {health.oldestPendingMinutes !== null && health.pendingCount > 0 ? ` (oldest ${agoLabel(health.oldestPendingMinutes)})` : ""}
              </dd>
            </div>
            <div className="fact">
              <dt>Not analysed</dt>
              <dd className={health.failedCount > 0 ? "text-danger" : undefined}>{health.failedCount}</dd>
            </div>
            <div className="fact">
              <dt>AI analysis</dt>
              <dd className={health.paused ? "text-danger" : undefined}>{health.paused ? "Paused" : "Running"}</dd>
            </div>
          </dl>
        </>
      ) : null}
    </section>
  );
}

/**
 * “Not analysed”: messages the AI could not analyse (parked). “Retry” sends one back to the queue; “Got it”
 * acknowledges it, so it stops appearing in the report and the banner.
 */
function ParkedMessagesCard() {
  const { zone, today } = useApp();
  const toast = useToast();
  const { parked, error, busy, act } = useParkedMessages();
  const run = async (messageId: string, action: "retry" | "acknowledge") => {
    if (await act(messageId, action)) toast(action === "retry" ? "It will be analysed again" : "It won't be shown again", "success");
  };
  if (parked !== null && parked.length === 0 && !error) return null;
  return (
    <section className="card" aria-labelledby="parked-h">
      <h2 id="parked-h" className="section-title">
        Not analysed{parked ? ` (${parked.length})` : ""}
      </h2>
      <p className="muted small">
        Messages the AI couldn't analyse. Check them in your mail app; “Retry” sends one back for analysis, “Got it” stops reporting it.
      </p>
      {error ? <p className="form-error">{error}</p> : null}
      {parked === null && !error ? <p className="muted">Loading…</p> : null}
      {parked && parked.length > 0 ? (
        <ul className="parked-list">
          {parked.map((p) => (
            <li key={p.messageId} className="parked-row">
              <span className="parked-subject">{p.subject || "(no subject)"}</span>
              <span className="muted small">
                {p.fromName || p.fromAddress || "unknown sender"} · {formatDateTime(p.date, zone, today)} · {parkedErrorLabel(p.error)}
              </span>
              <div className="button-row">
                <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void run(p.messageId, "retry")}>
                  Retry
                </button>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy !== null} onClick={() => void run(p.messageId, "acknowledge")}>
                  Got it
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AddMailboxForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (m: MailboxSummary) => void }) {
  const toast = useToast();
  const [form, setForm] = useState<MailboxFormState>(EMPTY_MAILBOX_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof MailboxFormState>(k: K, v: MailboxFormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const invalid = validateMailboxForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const m = await api.createMailbox(mailboxCreateRequest(form));
      toast("Mailbox added. Now set its password.", "success");
      onCreated(m);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="grid-form add-mailbox" onSubmit={(e) => void submit(e)}>
      <h3 className="field-wide sub-title">New mailbox</h3>
      <label className="field">
        <span className="field-label">Email address *</span>
        <input type="email" value={form.address} onChange={(e) => set("address", e.target.value)} required autoFocus autoComplete="off" />
      </label>
      <label className="field">
        <span className="field-label">Display name</span>
        <input value={form.displayName} onChange={(e) => set("displayName", e.target.value)} maxLength={200} />
      </label>
      <fieldset className="radio-group field-wide">
        <legend className="field-label">How to connect</legend>
        <label className="radio">
          <input type="radio" name="provider" checked={form.provider === "imap"} onChange={() => set("provider", "imap")} />
          <span>Directly to the mail server (IMAP, read-only)</span>
        </label>
        <label className="radio">
          <input type="radio" name="provider" checked={form.provider === "ingest"} onChange={() => set("provider", "ingest")} />
          <span>Through the ingest API (e.g. an Outlook agent)</span>
        </label>
      </fieldset>
      {form.provider === "imap" ? (
        <>
          <label className="field">
            <span className="field-label">IMAP server *</span>
            <input value={form.imapHost} onChange={(e) => set("imapHost", e.target.value)} placeholder="mail.example.com" required autoComplete="off" />
          </label>
          <label className="field field-narrow">
            <span className="field-label">Port (TLS)</span>
            <input inputMode="numeric" value={form.imapPort} onChange={(e) => set("imapPort", e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Username</span>
            <input value={form.imapUsername} onChange={(e) => set("imapUsername", e.target.value)} placeholder={form.address || "same as the address"} autoComplete="off" />
          </label>
          <label className="field">
            <span className="field-label">SMTP server (for the report by email — same as IMAP)</span>
            <input value={form.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder={form.imapHost || "same as the IMAP server"} autoComplete="off" />
          </label>
          <label className="field field-narrow">
            <span className="field-label">SMTP port (587 or 465)</span>
            <input inputMode="numeric" value={form.smtpPort} onChange={(e) => set("smtpPort", e.target.value)} />
          </label>
        </>
      ) : null}
      <div className="field field-wide">
        <span className="field-label">Aliases (other addresses that are “you”)</span>
        <AliasEditor value={form.aliases} onChange={(aliases) => set("aliases", aliases)} primary={form.address} />
      </div>
      {error ? (
        <p className="form-error field-wide" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row field-wide">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Add"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
