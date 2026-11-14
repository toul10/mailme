/**
 * Admin (#/admin, platform admins only): organizations and accounts of every organization. Configuration and
 * health only — no task or message content reaches this page. A new account gets a one-time setup link that the
 * admin sends to the person; nobody but that person ever chooses the password.
 */
import { Building2, KeyRound, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { AdminOrg, AdminOverview, AdminSetupLink, AdminUser } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { CopyButton } from "../components/Chips.js";
import { ConfirmDialog, Dialog } from "../components/Dialog.js";
import { useToast } from "../components/Toast.js";
import { agoLabel, formatDateTime, minutesSince, plural } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { MAILBOX_STATUS_LABELS } from "../labels.js";
import { PersonAvatar } from "../ui/Avatar.js";

const ROLE_LABEL = { member: "User", admin: "Organization admin" } as const;
const STATE_LABEL = { active: "Active", invited: "Waiting for activation", disabled: "Disabled" } as const;
const splitDomains = (s: string) => s.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);

export function Admin() {
  useDocumentTitle("Admin");
  const { me, zone, today } = useApp();
  const toast = useToast();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orgFilter, setOrgFilter] = useState<string>("");
  const [newOrg, setNewOrg] = useState(false);
  const [newUser, setNewUser] = useState<string | null>(null);
  const [linkFor, setLinkFor] = useState<{ user: Pick<AdminUser, "name" | "email">; link: AdminSetupLink } | null>(null);

  const load = useCallback(() => {
    api
      .adminOverview()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => !(isApiError(err) && err.handled) && setError(isApiError(err) && err.code === "forbidden" ? "This page is for admins only." : errorMessage(err)));
  }, []);
  useEffect(load, [load]);

  const orgName = useMemo(() => new Map((data?.orgs ?? []).map((o) => [o.id, o.name])), [data]);
  const users = (data?.users ?? []).filter((u) => !orgFilter || u.orgId === orgFilter);

  const header = (
    <header className="bridge bridge-compact">
      <h1 className="page-title">Admin</h1>
      <p className="bridge-sub">Organizations and accounts. Content from emails or tasks never appears here.</p>
    </header>
  );

  if (error) {
    return (
      <div className="page admin">
        {header}
        <div className="error-box" role="alert">
          <p>{error}</p>
          <button type="button" className="btn" onClick={load}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page admin">
        {header}
        <p className="muted loading">Loading…</p>
      </div>
    );
  }

  return (
    <div className="page admin">
      {header}

      <section aria-labelledby="adm-orgs" className="admin-section">
        <div className="admin-head">
          <h2 id="adm-orgs" className="section-title">
            Organizations <span className="count">{data.orgs.length}</span>
          </h2>
          {!newOrg ? (
            <button type="button" className="btn" onClick={() => setNewOrg(true)}>
              <Plus size={16} aria-hidden="true" />
              New organization
            </button>
          ) : null}
        </div>
        {newOrg ? (
          <OrgForm
            title="New organization"
            onCancel={() => setNewOrg(false)}
            onSave={async (v) => {
              await api.adminCreateOrg(v);
              toast(`Created: ${v.name}`, "success");
              setNewOrg(false);
              load();
            }}
          />
        ) : null}
        <ul className="admin-orgs">
          {data.orgs.map((o) => (
            <OrgCard
              key={o.id}
              org={o}
              onChanged={load}
              onAddUser={() => {
                setOrgFilter(o.id);
                setNewUser(o.id);
                window.setTimeout(() => document.getElementById("adm-users")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              }}
              onShowUsers={() => {
                setOrgFilter(o.id);
                document.getElementById("adm-users")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="adm-users" className="admin-section">
        <div className="admin-head">
          <h2 id="adm-users" className="section-title">
            Accounts <span className="count">{users.length}</span>
          </h2>
          <div className="admin-tools">
            <label className="field">
              <span className="sr-only">Organization</span>
              <select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)}>
                <option value="">All organizations</option>
                {data.orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            {newUser === null ? (
              <button type="button" className="btn btn-primary" onClick={() => setNewUser(orgFilter)}>
                <UserPlus size={16} aria-hidden="true" />
                New account
              </button>
            ) : null}
          </div>
        </div>
        {newUser !== null ? (
          <UserForm
            key={newUser}
            orgs={data.orgs}
            defaultOrg={newUser}
            onCancel={() => setNewUser(null)}
            onCreated={(created) => {
              setNewUser(null);
              setLinkFor({ user: created.user, link: created.link });
              load();
            }}
          />
        ) : null}
        <ul className="admin-users">
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              orgs={data.orgs}
              orgName={orgName.get(u.orgId) ?? "—"}
              isMe={u.id === data.me}
              zone={zone}
              today={today}
              onChanged={load}
              onLink={(link) => setLinkFor({ user: u, link })}
            />
          ))}
        </ul>
        {users.length === 0 ? <p className="empty">No accounts in this organization.</p> : null}
      </section>

      {linkFor ? (
        <Dialog
          title="Setup link"
          onClose={() => setLinkFor(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => setLinkFor(null)}>
              Done
            </button>
          }
        >
          <p>
            Send it <strong>only</strong> to {linkFor.user.name} ({linkFor.user.email}). With it they choose their own password and then set up their
            authenticator app. It works <strong>once</strong>, until {formatDateTime(linkFor.link.expiresAt, zone, today)}.
          </p>
          <div className="admin-link">
            <code>{linkFor.link.url}</code>
            <CopyButton text={linkFor.link.url} label="Copy link" />
          </div>
          <p className="muted small">The link won't be shown again. If it gets lost, make a new one from the account.</p>
        </Dialog>
      ) : null}
      <p className="muted small admin-foot">Signed in as {me.email}.</p>
    </div>
  );
}

function OrgCard({ org, onChanged, onAddUser, onShowUsers }: { org: AdminOrg; onChanged: () => void; onAddUser: () => void; onShowUsers: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const empty = org.users === 0 && org.mailboxes === 0;
  if (editing) {
    return (
      <li>
        <OrgForm
          title={`Edit: ${org.name}`}
          initial={org}
          onCancel={() => setEditing(false)}
          onSave={async (v) => {
            await api.adminUpdateOrg(org.id, v);
            toast("Saved", "success");
            setEditing(false);
            onChanged();
          }}
        />
      </li>
    );
  }
  return (
    <li className="card admin-org">
      <span className="prefs-icon" aria-hidden="true">
        <Building2 size={18} />
      </span>
      <div className="admin-org-main">
        <strong>{org.name}</strong>
        <span className="admin-domains">
          {org.internalDomains.length ? org.internalDomains.map((d) => <span key={d} className="admin-chip">@{d}</span>) : <span className="muted">no domains</span>}
        </span>
      </div>
      <button type="button" className="admin-stat admin-stat-link" onClick={onShowUsers} disabled={org.users === 0}>
        {plural(org.users, "account", "accounts")}
      </button>
      <span className="admin-stat">{plural(org.mailboxes, "mailbox", "mailboxes")}</span>
      <span className="admin-stat muted">{org.timezone}</span>
      <div className="admin-actions">
        <button type="button" className="btn btn-small" onClick={onAddUser}>
          <UserPlus size={14} aria-hidden="true" />
          Add account
        </button>
        <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
          Edit
        </button>
        {empty ? (
          <button type="button" className="btn btn-small btn-danger-quiet" onClick={() => setDeleting(true)}>
            Delete
          </button>
        ) : null}
      </div>
      {deleting ? (
        <ConfirmDialog
          title={`Delete organization: ${org.name}`}
          message="The organization has no accounts and no mailboxes. It will be deleted along with its domains."
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => {
            setBusy(true);
            api
              .adminDeleteOrg(org.id)
              .then(() => {
                toast(`Deleted: ${org.name}`, "success");
                onChanged();
              })
              .catch((err) => !(isApiError(err) && err.handled) && toast(errorMessage(err), "error"))
              .finally(() => {
                setBusy(false);
                setDeleting(false);
              });
          }}
          onCancel={() => setDeleting(false)}
        />
      ) : null}
    </li>
  );
}

function OrgForm({
  title,
  initial,
  onSave,
  onCancel,
}: {
  title: string;
  initial?: AdminOrg;
  onSave: (v: { name: string; domains: string[]; timezone: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [domains, setDomains] = useState((initial?.internalDomains ?? []).join(", "));
  const [timezone, setTimezone] = useState(initial?.timezone ?? "Europe/Athens");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), domains: splitDomains(domains), timezone: timezone.trim() });
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form className="card admin-form" onSubmit={(e) => void submit(e)}>
      <h3 className="sub-title">{title}</h3>
      <div className="grid-form">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus placeholder="e.g. Contoso" />
        </label>
        <label className="field">
          <span className="field-label">Company domains (colleagues)</span>
          <input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="e.g. example.com, example.org" />
        </label>
        <label className="field">
          <span className="field-label">Time zone</span>
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} required />
        </label>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserForm({
  orgs,
  defaultOrg,
  onCreated,
  onCancel,
}: {
  orgs: AdminOrg[];
  defaultOrg: string;
  onCreated: (c: { user: AdminUser; link: AdminSetupLink }) => void;
  onCancel: () => void;
}) {
  const [orgId, setOrgId] = useState(defaultOrg || orgs.find((o) => o.internalDomains.length > 0)?.id || orgs[0]?.id || "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.adminCreateUser({ orgId, name: name.trim(), email: email.trim(), role }));
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <form className="card admin-form" onSubmit={(e) => void submit(e)}>
      <h3 className="sub-title">New account</h3>
      <p className="muted small">
        Once the account is created you get a setup link to send to the person. They choose their own password. The daily report starts off: you turn it on
        from Edit, once their mailbox has been checked.
      </p>
      <div className="grid-form">
        <label className="field">
          <span className="field-label">Organization</span>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} required>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus placeholder="e.g. Maria Papadaki" />
        </label>
        <label className="field">
          <span className="field-label">Sign-in email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="e.g. maria@example.com" />
        </label>
        <label className="field">
          <span className="field-label">Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
            <option value="member">{ROLE_LABEL.member}: their own tasks</option>
            <option value="admin">{ROLE_LABEL.admin}: settings and health, without other people's content</option>
          </select>
        </label>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined}>
          {busy ? "Creating…" : "Create and get link"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function UserRow({
  user,
  orgs,
  orgName,
  isMe,
  zone,
  today,
  onChanged,
  onLink,
}: {
  user: AdminUser;
  orgs: AdminOrg[];
  orgName: string;
  isMe: boolean;
  zone: string;
  today: string;
  onChanged: () => void;
  onLink: (l: AdminSetupLink) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"link" | "disable" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);

  const update = async (body: Parameters<typeof api.adminUpdateUser>[1], done: string) => {
    setBusy(true);
    try {
      await api.adminUpdateUser(user.id, body);
      toast(done, "success");
      onChanged();
      return true;
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const newLink = async () => {
    setBusy(true);
    try {
      onLink(await api.adminSetupLink(user.id));
      onChanged();
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <li className={`card admin-user${user.state === "disabled" ? " is-disabled" : ""}`}>
      <div className="admin-user-top">
        <PersonAvatar name={user.name} size="md" />
        <div className="admin-user-id">
          <strong>
            {user.name}
            {isMe ? <span className="admin-chip">you</span> : null}
          </strong>
          <span className="muted">{user.email}</span>
        </div>
        <span className="admin-stat">{orgName}</span>
        <span className="admin-stat">
          {user.platformAdmin ? (
            <span className="admin-chip admin-chip-key">
              <ShieldCheck size={13} aria-hidden="true" />
              Platform admin
            </span>
          ) : (
            ROLE_LABEL[user.role]
          )}
        </span>
        <span className={`admin-state state-${user.state}`}>
          <span className="led" aria-hidden="true" />
          {STATE_LABEL[user.state]}
          {user.state === "active" && !user.mfa ? <span className="muted"> (no TOTP)</span> : null}
        </span>
        <div className="admin-actions">
          <button type="button" className="btn btn-small" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            Edit
          </button>
          {user.state !== "disabled" ? (
            <button type="button" className="btn btn-small" aria-disabled={busy || undefined} onClick={() => setConfirm("link")}>
              <KeyRound size={14} aria-hidden="true" />
              New link
            </button>
          ) : null}
        </div>
      </div>

      <div className="admin-user-meta">
        {user.mailboxes.length ? (
          user.mailboxes.map((m) => (
            <span key={m.id} className={`admin-mailbox mb-${m.status}`}>
              <span className="led" aria-hidden="true" />
              {m.address}: {MAILBOX_STATUS_LABELS[m.status]}
              {m.lastSyncAt ? `, synced ${agoLabel(minutesSince(m.lastSyncAt))}` : ""}
            </span>
          ))
        ) : (
          <span className="muted">No mailbox (they add it themselves, in their Settings).</span>
        )}
        <span className="muted">Report: {user.digestEnabled ? `on, ${user.digestTime}` : "off"}</span>
        {user.setupExpiresAt ? <span className="muted">Link pending until {formatDateTime(user.setupExpiresAt, zone, today)}</span> : null}
      </div>

      {editing ? (
        <UserEdit
          user={user}
          orgs={orgs}
          isMe={isMe}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            if (await update(body, "Saved")) setEditing(false);
          }}
          onDisable={() => setConfirm("disable")}
          onEnable={() => void update({ disabled: false }, "Account enabled")}
          onDelete={() => setConfirm("delete")}
        />
      ) : null}
      {confirm === "delete" ? (
        <DeleteAccountDialog
          user={user}
          onClose={() => setConfirm(null)}
          onDeleted={(msg) => {
            setConfirm(null);
            toast(msg, "success");
            onChanged();
          }}
        />
      ) : null}

      {confirm === "link" ? (
        <ConfirmDialog
          title={`New link for ${user.name}`}
          message={
            user.state === "invited"
              ? "The previous link stops working."
              : "Once it's used, it sets a new password, asks for the authenticator app again and signs them out on all their devices. Until then the current password still works."
          }
          confirmLabel="Make link"
          busy={busy}
          onConfirm={() => void newLink()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === "disable" ? (
        <ConfirmDialog
          title={`Disable: ${user.name}`}
          message="They are signed out on all devices at once and can't sign in. Their data stays. You can enable the account again from here."
          confirmLabel="Disable"
          danger
          busy={busy}
          onConfirm={() => void update({ disabled: true }, "Account disabled").then(() => setConfirm(null))}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </li>
  );
}

function UserEdit({
  user,
  orgs,
  isMe,
  busy,
  onSave,
  onCancel,
  onDisable,
  onEnable,
  onDelete,
}: {
  user: AdminUser;
  orgs: AdminOrg[];
  isMe: boolean;
  busy: boolean;
  onSave: (body: { orgId?: string; name: string; role: "admin" | "member"; platformAdmin: boolean; digestEnabled: boolean; digestTime: string }) => Promise<void>;
  onCancel: () => void;
  onDisable: () => void;
  onEnable: () => void;
  onDelete: () => void;
}) {
  const [orgId, setOrgId] = useState(user.orgId);
  const movable = user.mailboxes.length === 0;
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [platformAdmin, setPlatformAdmin] = useState(user.platformAdmin);
  const [digestEnabled, setDigestEnabled] = useState(user.digestEnabled);
  const [digestTime, setDigestTime] = useState(user.digestTime);
  return (
    <form
      className="admin-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ ...(orgId !== user.orgId ? { orgId } : {}), name: name.trim(), role, platformAdmin, digestEnabled, digestTime });
      }}
    >
      <div className="grid-form">
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span className="field-label">Organization</span>
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} disabled={!movable}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          {!movable ? <span className="hint">It has a mailbox, so it can't be moved. Delete it and create a new account in the right organization.</span> : null}
        </label>
        <label className="field">
          <span className="field-label">Role in the organization</span>
          <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
            <option value="member">{ROLE_LABEL.member}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Daily report time</span>
          <input type="time" value={digestTime} onChange={(e) => setDigestTime(e.target.value)} required />
        </label>
        <label className="check">
          <input type="checkbox" checked={digestEnabled} onChange={(e) => setDigestEnabled(e.target.checked)} />
          <span>Daily report on (written into their mailbox)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={platformAdmin} disabled={isMe} onChange={(e) => setPlatformAdmin(e.target.checked)} />
          <span>Platform admin (this page, all organizations)</span>
        </label>
      </div>
      <div className="button-row">
        <button type="submit" className="btn btn-primary" aria-disabled={busy || undefined}>
          Save
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <span className="admin-spacer" />
        {isMe ? null : user.state === "disabled" ? (
          <button type="button" className="btn" onClick={onEnable}>
            Enable
          </button>
        ) : (
          <button type="button" className="btn btn-danger-quiet" onClick={onDisable}>
            Disable
          </button>
        )}
        {isMe ? null : (
          <button type="button" className="btn btn-danger" onClick={onDelete}>
            <Trash2 size={15} aria-hidden="true" />
            Delete account
          </button>
        )}
      </div>
    </form>
  );
}

/** Permanent deletion: the admin types the account's email to confirm (src/ops/delete-account.ts). */
function DeleteAccountDialog({ user, onClose, onDeleted }: { user: AdminUser; onClose: () => void; onDeleted: (message: string) => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.adminDeleteUser(user.id, typed.trim());
      onDeleted(`Deleted: ${user.name} (${plural(r.deleted.tasks, "task", "tasks")}, ${plural(r.deleted.messages, "email", "emails")})`);
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Delete account: ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p>This deletes for good, with no undo:</p>
        <ul className="admin-delete-list">
          <li>the account {user.email} and all its sessions</li>
          {user.mailboxes.length ? <li>{user.mailboxes.map((m) => m.address).join(", ")}: the saved password, and the emails and conversations that were synced</li> : null}
          <li>all its tasks, their history, and its reports</li>
        </ul>
        <p className="muted small">The mailbox on the server isn't affected: MailMe only read it. Backups expire on their own after 30 days.</p>
        <label className="field">
          <span className="field-label">To confirm, type the email: {user.email}</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} autoFocus />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <button type="submit" className="btn btn-danger" disabled={!matches} aria-disabled={busy || undefined}>
            {busy ? "Deleting…" : "Delete for good"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
