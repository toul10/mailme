/**
 * Mailbox setup: connection settings (and correcting them), password (probe once → sealed on success), probe report,
 * folder roles / sync / private toggles, aliases, pause/resume, SMTP settings and the one-time ingest token.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { FolderSummary, MailboxSummary, ProbeSummary, UpdateMailboxRequest } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { CopyButton } from "../components/Chips.js";
import { ConfirmDialog } from "../components/Dialog.js";
import { useToast } from "../components/Toast.js";
import { agoLabel, formatDateTime, formatKb, minutesSince, plural } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { FOLDER_ROLE_LABELS, FOLDER_ROLE_ORDER, ROLE_SOURCE_LABELS, probeErrorLabel } from "../labels.js";
import { connectionFormFrom, connectionPatch, normalizeAliases, smtpFieldsProblem, validateConnectionForm, type ConnectionFormState, type ConnectionPatch } from "../mailbox-form.js";
import { routeHref } from "../router.js";
import { AliasEditor } from "./AliasEditor.js";
import { MailboxStatusPill } from "./Settings.js";

export function MailboxPage({ id }: { id: string }) {
  const toast = useToast();
  const [mailbox, setMailbox] = useState<MailboxSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderSummary[] | null>(null);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  useDocumentTitle(mailbox ? mailbox.address : "Mailbox");

  const loadMailbox = useCallback(async () => {
    try {
      const r = await api.listMailboxes();
      const m = r.mailboxes.find((x) => x.id === id) ?? null;
      setMailbox(m);
      setMissing(m === null);
      setError(null);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    }
  }, [id]);

  const loadFolders = useCallback(async () => {
    try {
      const r = await api.listFolders(id);
      setFolders(r.folders);
      setFoldersError(null);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setFoldersError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void loadMailbox();
    void loadFolders();
  }, [loadMailbox, loadFolders]);

  const update = async (req: Parameters<typeof api.updateMailbox>[1], success: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      setMailbox(await api.updateMailbox(id, req));
      toast(success, "success");
      return true;
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <a className="back-link" href={routeHref({ name: "settings" })}>
          ← Settings
        </a>
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => void loadMailbox()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (missing) {
    return (
      <div className="page">
        <a className="back-link" href={routeHref({ name: "settings" })}>
          ← Settings
        </a>
        <p className="error-box">Mailbox not found.</p>
      </div>
    );
  }
  if (!mailbox) {
    return (
      <div className="page">
        <p className="muted loading">Loading…</p>
      </div>
    );
  }

  const canPause = mailbox.status === "active";
  const canResume = mailbox.status === "paused";
  const imap = mailbox.provider === "imap";
  const login = mailbox.imapUsername ?? mailbox.address;

  return (
    <div className="page mailbox-page">
      <header className="bridge bridge-compact">
        <a className="back-link" href={routeHref({ name: "settings" })}>
          ← Settings
        </a>
        <div className="task-header-top">
          <MailboxStatusPill mailbox={mailbox} />
          {mailbox.aiPaused ? <span className="chip chip-today">AI paused</span> : null}
        </div>
        <h1 className="page-title">{mailbox.address}</h1>
        {mailbox.displayName ? <p className="bridge-sub">{mailbox.displayName}</p> : null}
      </header>

      <section className="card">
        <dl className="facts">
          <div className="fact">
            <dt>Connection</dt>
            <dd>{imap ? `IMAP ${mailbox.imapHost ?? "—"}:${mailbox.imapPort} · ${login}` : "Ingest API"}</dd>
          </div>
          <div className="fact">
            <dt>Last sync</dt>
            <dd>{mailbox.lastSyncAt ? agoLabel(minutesSince(mailbox.lastSyncAt)) : "never"}</dd>
          </div>
          {mailbox.statusReason ? (
            <div className="fact">
              <dt>Status reason</dt>
              <dd>{mailbox.statusReason}</dd>
            </div>
          ) : null}
          {mailbox.lastError ? (
            <div className="fact">
              <dt>Last error</dt>
              <dd className="text-danger">{probeErrorLabel(mailbox.lastError)}</dd>
            </div>
          ) : null}
          {mailbox.aiPaused && mailbox.aiPausedReason ? (
            <div className="fact">
              <dt>Why the AI is paused</dt>
              <dd>{mailbox.aiPausedReason}</dd>
            </div>
          ) : null}
        </dl>
        {mailbox.status === "auth_failed" ? (
          <p className="notice">The server rejected the password. MailMe stopped reconnecting so the account doesn't get locked — set the password again below.</p>
        ) : null}
        {mailbox.status === "setup" && mailbox.lastError === "auth" ? (
          <p className="notice">
            The server did not accept the username <strong>{login}</strong> with that password. If the password is right, check whether the address or the username is wrong — both are
            corrected under “Edit connection settings”.
          </p>
        ) : null}
        {editing ? (
          <ConnectionEditor
            mailbox={mailbox}
            onCancel={() => setEditing(false)}
            onSaved={(m) => {
              setMailbox(m);
              setEditing(false);
              toast(m.provider === "imap" ? "The connection settings changed. Now set the password." : "The address changed.", "success");
              void loadFolders();
            }}
          />
        ) : canPause || canResume || mailbox.status !== "disabled" ? (
          <div className="button-row">
            {canPause ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void update({ status: "paused" }, "Sync paused")}>
                Pause sync
              </button>
            ) : canResume ? (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void update({ status: "active" }, "Sync resumed")}>
                Resume sync
              </button>
            ) : null}
            {mailbox.status !== "disabled" ? (
              <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
                Edit connection settings
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      {mailbox.provider === "imap" ? (
        <PasswordCard
          mailbox={mailbox}
          onProbed={(probe) => {
            // Also after a refused login: the mailbox then says why (and how to correct the login name).
            void loadMailbox();
            if (probe.ok) void loadFolders();
          }}
        />
      ) : null}

      {mailbox.provider === "imap" ? <FoldersCard mailboxId={id} folders={folders} error={foldersError} onReload={() => void loadFolders()} onChange={setFolders} /> : null}

      <AliasesCard mailbox={mailbox} busy={busy} onSave={(aliases) => update({ aliases }, "Aliases saved")} />

      <SmtpCard mailbox={mailbox} busy={busy} onSave={(req) => update(req, "Saved")} />

      <IngestTokenCard mailboxId={id} primary={mailbox.provider === "ingest"} />
    </div>
  );
}

function PasswordCard({ mailbox, onProbed }: { mailbox: MailboxSummary; onProbed: (p: ProbeSummary) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ProbeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    setProbe(null);
    const secret = password;
    setPassword(""); // never keep the mailbox password in state longer than the request
    try {
      const p = await api.setMailboxPassword(mailbox.id, secret);
      setProbe(p);
      onProbed(p);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="pw-h">
      <h2 id="pw-h" className="section-title">
        Mailbox password
      </h2>
      <p className="muted small">
        {mailbox.hasCredentials ? "A password is already saved. " : ""}
        MailMe tries to connect <strong>once</strong> (so the account doesn't get locked). If it works, the password is saved encrypted, and only the worker can open it.
      </p>
      <form className="inline-form" onSubmit={(e) => void submit(e)}>
        <label className="field field-grow">
          <span className="field-label">Password for {mailbox.imapUsername ?? mailbox.address}</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !password}>
          {busy ? "Testing the connection…" : "Test & save"}
        </button>
      </form>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {probe ? <ProbeReport probe={probe} login={mailbox.imapUsername ?? mailbox.address} /> : null}
    </section>
  );
}

/** What the server said, when it explains more than the general message for its code. */
function saveErrorText(err: unknown): string {
  return isApiError(err) && (err.code === "conflict" || err.code === "forbidden") && err.serverMessage ? err.serverMessage : errorMessage(err);
}

/**
 * Correct the address, the server, the port or the login name. Saving a change removes the stored password (the
 * server does): the password is entered again and tried against the new settings.
 */
function ConnectionEditor({ mailbox, onSaved, onCancel }: { mailbox: MailboxSummary; onSaved: (m: MailboxSummary) => void; onCancel: () => void }) {
  const [form, setForm] = useState<ConnectionFormState>(() => connectionFormFrom(mailbox));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConnectionPatch | null>(null);
  const imap = mailbox.provider === "imap";
  const set = <K extends keyof ConnectionFormState>(k: K, v: ConnectionFormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (patch: ConnectionPatch) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateMailbox(mailbox.id, patch));
    } catch (err) {
      setConfirming(null);
      if (!(isApiError(err) && err.handled)) setError(saveErrorText(err));
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const invalid = validateConnectionForm(mailbox, form);
    if (invalid) {
      setError(invalid);
      return;
    }
    const patch = connectionPatch(mailbox, form);
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    // A mailbox with a stored password stops syncing until the password is entered again: say so first.
    if (imap && mailbox.hasCredentials) setConfirming(patch);
    else void save(patch);
  };

  return (
    <form className="grid-form connection-edit" onSubmit={submit} aria-labelledby="conn-h">
      <h2 id="conn-h" className="field-wide sub-title">
        Edit connection settings
      </h2>
      <label className="field">
        <span className="field-label">Email address</span>
        <input type="email" value={form.address} onChange={(e) => set("address", e.target.value)} disabled={mailbox.hasMail} required autoComplete="off" autoFocus={!mailbox.hasMail} />
      </label>
      {imap ? (
        <>
          <label className="field">
            <span className="field-label">Username</span>
            <input value={form.imapUsername} onChange={(e) => set("imapUsername", e.target.value)} disabled={mailbox.hasMail} placeholder={form.address.trim() || "same as the address"} autoComplete="off" />
            <span className="hint">Empty = same as the address.</span>
          </label>
          <label className="field">
            <span className="field-label">IMAP server</span>
            <input value={form.imapHost} onChange={(e) => set("imapHost", e.target.value)} autoComplete="off" autoFocus={mailbox.hasMail} />
          </label>
          <label className="field field-narrow">
            <span className="field-label">Port (TLS)</span>
            <input inputMode="numeric" value={form.imapPort} onChange={(e) => set("imapPort", e.target.value)} />
          </label>
        </>
      ) : null}
      {mailbox.hasMail ? (
        <p className="hint field-wide">The mailbox already holds mail, so its address and username can't be changed. For another address, add a new mailbox.</p>
      ) : null}
      {imap ? <p className="hint field-wide">After a change you enter the password again: it is tried against the new settings.</p> : null}
      {error ? (
        <p className="form-error field-wide" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row field-wide">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {confirming ? (
        <ConfirmDialog
          title="Change connection settings"
          message="The stored password will be removed and syncing will stop until you enter the password again. The new password is tried against the new settings."
          confirmLabel="Change"
          busy={busy}
          onConfirm={() => void save(confirming)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </form>
  );
}

function ProbeReport({ probe, login }: { probe: ProbeSummary; login: string }) {
  const quotaPct = probe.quota && probe.quota.limitKb > 0 ? Math.round((probe.quota.usedKb / probe.quota.limitKb) * 100) : null;
  return (
    <div className={probe.ok ? "probe probe-ok" : "probe probe-fail"} role="status">
      {probe.ok ? (
        <p className="probe-title">✓ Connected — the password is saved.</p>
      ) : (
        <p className="probe-title">
          ✗ Couldn't connect: {probeErrorLabel(probe.errorKind) ?? "unknown error"}
          {probe.error ? <span className="muted small"> ({probe.error})</span> : null}
        </p>
      )}
      {!probe.ok && probe.errorKind === "auth" ? (
        <p className="small">
          The username <strong>{login}</strong> was tried. If the password is right, correct the address or the username under “Edit connection settings” above.
        </p>
      ) : null}
      {probe.quota ? (
        <div className="quota">
          <span>
            Storage: {formatKb(probe.quota.usedKb)} of {formatKb(probe.quota.limitKb)}
            {quotaPct !== null ? ` (${quotaPct}%)` : ""}
          </span>
          {quotaPct !== null ? (
            <meter min={0} max={100} low={70} high={80} optimum={0} value={Math.min(100, quotaPct)} aria-label="Storage used">
              {quotaPct}%
            </meter>
          ) : null}
        </div>
      ) : null}
      {probe.capabilities.length > 0 ? (
        <details className="details">
          <summary>Server capabilities ({probe.capabilities.length})</summary>
          <ul className="caps">
            {probe.capabilities.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {probe.folders.length > 0 ? (
        <details className="details">
          <summary>Folders found ({probe.folders.length})</summary>
          <ul className="caps">
            {probe.folders.map((f) => (
              <li key={f.path}>
                {f.name} <span className="muted small">— {FOLDER_ROLE_LABELS[f.role]}</span>
                {f.messages !== null ? <span className="muted small"> · {plural(f.messages, "message", "messages")}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

interface FoldersCardProps {
  mailboxId: string;
  folders: FolderSummary[] | null;
  error: string | null;
  onReload: () => void;
  onChange: (folders: FolderSummary[]) => void;
}

function FoldersCard({ mailboxId, folders, error, onReload, onChange }: FoldersCardProps) {
  const { zone, today } = useApp();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [confirmPrivate, setConfirmPrivate] = useState<FolderSummary | null>(null);

  const patch = async (folder: FolderSummary, req: Parameters<typeof api.updateFolder>[2]) => {
    if (!folders || !folder.id || saving) return;
    const folderId = folder.id;
    const before = folders;
    onChange(folders.map((f) => (f.id === folderId ? { ...f, ...req } : f)));
    setSaving(folderId);
    try {
      const updated = await api.updateFolder(mailboxId, folderId, req);
      onChange(before.map((f) => (f.id === folderId ? updated : f)));
    } catch (err) {
      onChange(before);
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="card" aria-labelledby="folders-h">
      <div className="section-head">
        <h2 id="folders-h" className="section-title">
          Folders
        </h2>
        <button type="button" className="btn btn-small btn-ghost" onClick={onReload}>
          Refresh
        </button>
      </div>
      <p className="muted small">
        The role tells MailMe what a folder is (e.g. “Sent” = your own messages). The AI never reads private folders.
      </p>
      {error ? <p className="form-error">{error}</p> : null}
      {folders === null && !error ? <p className="muted">Loading…</p> : null}
      {folders && folders.length === 0 ? <p className="muted">No folders yet — set the password so MailMe can find them.</p> : null}
      {folders && folders.length > 0 ? (
        <div className="table-wrap">
          <table className="folders">
            <thead>
              <tr>
                <th scope="col">Folder</th>
                <th scope="col">Role</th>
                <th scope="col">Sync</th>
                <th scope="col">Private</th>
                <th scope="col" className="num">
                  Messages
                </th>
                <th scope="col">Last read</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((f) => {
                const disabled = !f.id || saving === f.id;
                return (
                  <tr key={f.path}>
                    <th scope="row">
                      <span className="folder-name">{f.name}</span>
                      {f.path !== f.name ? <span className="muted small folder-path">{f.path}</span> : null}
                    </th>
                    <td>
                      <select
                        aria-label={`Role of folder ${f.name}`}
                        value={f.role}
                        disabled={disabled}
                        onChange={(e) => void patch(f, { role: e.target.value as FolderSummary["role"] })}
                      >
                        {FOLDER_ROLE_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {FOLDER_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                      <span className="muted small role-source">{ROLE_SOURCE_LABELS[f.roleSource]}</span>
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Sync folder ${f.name}`}
                        checked={f.syncEnabled}
                        disabled={disabled || f.private || f.role === "drafts"}
                        title={f.role === "drafts" ? "Drafts are never read" : undefined}
                        onChange={(e) => void patch(f, { syncEnabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Private folder ${f.name}`}
                        checked={f.private}
                        disabled={disabled}
                        onChange={(e) => (e.target.checked ? setConfirmPrivate(f) : void patch(f, { private: false }))}
                      />
                    </td>
                    <td className="num">{f.messages ?? "—"}</td>
                    <td className="small">{f.lastSyncedAt ? formatDateTime(f.lastSyncedAt, zone, today) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {folders?.some((f) => !f.id) ? <p className="muted small">Folders that aren't saved yet can be set up after the first sync.</p> : null}
      {confirmPrivate ? (
        <ConfirmDialog
          title="Private folder"
          message={`The folder “${confirmPrivate.name}” will be left out of sync, and the AI won't read it.`}
          confirmLabel="Make private"
          onConfirm={() => {
            const f = confirmPrivate;
            setConfirmPrivate(null);
            void patch(f, { private: true, syncEnabled: false });
          }}
          onCancel={() => setConfirmPrivate(null)}
        />
      ) : null}
    </section>
  );
}

function AliasesCard({ mailbox, busy, onSave }: { mailbox: MailboxSummary; busy: boolean; onSave: (aliases: string[]) => Promise<boolean> }) {
  const [aliases, setAliases] = useState(mailbox.aliases);
  useEffect(() => setAliases(mailbox.aliases), [mailbox.aliases]);
  const normalized = normalizeAliases(aliases, mailbox.address);
  const dirty = normalized.join(",") !== normalizeAliases(mailbox.aliases, mailbox.address).join(",");
  return (
    <section className="card" aria-labelledby="aliases-h">
      <h2 id="aliases-h" className="section-title">
        Aliases
      </h2>
      <p className="muted small">Other addresses that are “you” (so your own messages can be told apart from other people's).</p>
      <AliasEditor value={aliases} onChange={setAliases} primary={mailbox.address} />
      <div className="button-row">
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void onSave(normalized)}>
          Save aliases
        </button>
      </div>
    </section>
  );
}

function SmtpCard({ mailbox, busy, onSave }: { mailbox: MailboxSummary; busy: boolean; onSave: (req: Pick<UpdateMailboxRequest, "displayName" | "smtpHost" | "smtpPort">) => Promise<boolean> }) {
  const [displayName, setDisplayName] = useState(mailbox.displayName ?? "");
  const [smtpHost, setSmtpHost] = useState(mailbox.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(mailbox.smtpPort ? String(mailbox.smtpPort) : "");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDisplayName(mailbox.displayName ?? "");
    setSmtpHost(mailbox.smtpHost ?? "");
    setSmtpPort(mailbox.smtpPort ? String(mailbox.smtpPort) : "");
  }, [mailbox.displayName, mailbox.smtpHost, mailbox.smtpPort]);

  const imap = mailbox.provider === "imap";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const host = imap ? smtpHost.trim() || null : null;
    const port = host && smtpPort.trim() ? Number(smtpPort.trim()) : null;
    // Unchanged values are always accepted (e.g. a server set up through the CLI); new ones follow the server's rule.
    const changed = (host ?? "").toLowerCase() !== (mailbox.smtpHost ?? "").toLowerCase() || port !== mailbox.smtpPort;
    const problem = changed && imap ? smtpFieldsProblem(mailbox.imapHost, smtpHost, smtpPort) : null;
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    void onSave(imap ? { displayName: displayName.trim() || null, smtpHost: host, smtpPort: port } : { displayName: displayName.trim() || null });
  };

  return (
    <section className="card" aria-labelledby="smtp-h">
      <h2 id="smtp-h" className="section-title">
        {imap ? "Details & SMTP" : "Details"}
      </h2>
      <form className="grid-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={200} />
        </label>
        {imap ? (
          <>
            <label className="field">
              <span className="field-label">SMTP server (same as IMAP)</span>
              <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder={mailbox.imapHost ?? ""} autoComplete="off" />
            </label>
            <label className="field field-narrow">
              <span className="field-label">SMTP port (587 or 465)</span>
              <input inputMode="numeric" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
            </label>
          </>
        ) : null}
        {error ? (
          <p className="form-error field-wide" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row field-wide">
          <button type="submit" className="btn" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </section>
  );
}

function IngestTokenCard({ mailboxId, primary }: { mailboxId: string; primary: boolean }) {
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const issue = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const r = await api.issueIngestToken(mailboxId);
      setToken(r.token);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  };

  const endpoint = `${window.location.origin}/api/ingest/${encodeURIComponent(mailboxId)}`;

  return (
    <section className="card" aria-labelledby="ingest-h">
      <h2 id="ingest-h" className="section-title">
        Ingest API {primary ? "" : <span className="muted small">(backup method, e.g. an Outlook agent)</span>}
      </h2>
      <p className="muted small">
        Endpoint: <code>{endpoint}</code>
      </p>
      {token ? (
        <div className="token-box" role="status">
          <p>
            <strong>Copy the token now — it won't be shown again.</strong>
          </p>
          <div className="secret-box">
            <code className="secret">{token}</code>
            <CopyButton text={token} />
          </div>
          <button type="button" className="btn btn-small" onClick={() => setToken(null)}>
            I've copied it — hide
          </button>
        </div>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(true)}>
          {busy ? "Issuing…" : "Issue a new token"}
        </button>
      )}
      {confirming ? (
        <ConfirmDialog
          title="New ingest token"
          message="A new token will be issued. If an agent already uses the old one, you may need to change it there too."
          confirmLabel="Issue"
          onConfirm={() => void issue()}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}
