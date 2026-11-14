/** Login → TOTP verify / TOTP enroll. Errors of /api/auth/* are shown inline, never as a redirect. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { LoginResponse, SetupCheck, TotpEnrollStart } from "../../../src/server/api-types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { CopyButton } from "../components/Chips.js";
import { groupSecret, normalizeTotpCode } from "../format.js";
import { useDocumentTitle } from "../hooks.js";
import { BrandMark } from "../ui/BrandMark.js";

function AuthCard({ title, children, notice }: { title: string; children: ReactNode; notice?: string | null }) {
  return (
    <main className="auth" id="main">
      <div className="auth-card">
        <div className="brand brand-large" aria-hidden="true">
          <BrandMark size={34} />
          MailMe
        </div>
        <h1 className="auth-title">{title}</h1>
        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        {children}
      </div>
    </main>
  );
}

function authError(err: unknown, fallback: string): string {
  if (isApiError(err)) {
    if (err.code === "unauthorized" || err.code === "invalid") return fallback;
    if (err.code === "forbidden") return "Your session has expired. Sign in again.";
  }
  return errorMessage(err);
}

export function LoginScreen({ notice, onLoggedIn }: { notice: string | null; onLoggedIn: (next: LoginResponse["next"]) => void }) {
  useDocumentTitle("Sign in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.login({ email: email.trim(), password });
      setPassword("");
      onLoggedIn(res.next);
    } catch (err) {
      setError(authError(err, "Wrong email or password."));
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" notice={notice}>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthCard>
  );
}

/**
 * The one-time setup link (#/setup?t=…): the person the admin invited chooses their own password here, then the
 * usual TOTP enrolment follows. The token was already removed from the address bar by App.tsx.
 */
export function SetupScreen({ token, onDone, onLeave }: { token: string; onDone: (next: LoginResponse["next"]) => void; onLeave: () => void }) {
  useDocumentTitle("Activate your account");
  const [info, setInfo] = useState<SetupCheck | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .setupCheck(token)
      .then((i) => alive && setInfo(i))
      .catch((err) => alive && setGone(isApiError(err) && err.code === "not_found" ? err.message : errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [token]);

  const min = info?.minPassword ?? 12;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < min) return setError(`The password needs at least ${min} characters.`);
    if (password !== again) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      const res = await api.setup(token, password);
      setPassword("");
      setAgain("");
      onDone(res.next);
    } catch (err) {
      if (isApiError(err) && err.code === "not_found") setGone(err.message);
      else setError(errorMessage(err));
      setBusy(false);
    }
  };

  if (gone) {
    return (
      <AuthCard title="This link isn't valid">
        <p>{gone}</p>
        <button type="button" className="btn btn-block" onClick={onLeave}>
          Go to sign in
        </button>
      </AuthCard>
    );
  }
  if (!info) {
    return (
      <AuthCard title="Activate your account">
        <p className="muted">Checking the link…</p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={`Welcome, ${info.name}`}>
      <p className="muted">
        Choose the password for the account <strong>{info.email}</strong>. Then you'll connect your authenticator app (TOTP).
      </p>
      <form onSubmit={(e) => void submit(e)} className="stack">
        <input type="email" autoComplete="username" value={info.email} readOnly hidden />
        <label className="field">
          <span className="field-label">New password (at least {min} characters)</span>
          <input type="password" autoComplete="new-password" minLength={min} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          <span className="field-label">Password again</span>
          <input type="password" autoComplete="new-password" minLength={min} value={again} onChange={(e) => setAgain(e.target.value)} required />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "Saving…" : "Set password"}
        </button>
      </form>
    </AuthCard>
  );
}

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">6-digit code from your authenticator app</span>
      <input
        className="code-input"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6,8}"
        value={value}
        onChange={(e) => onChange(normalizeTotpCode(e.target.value))}
        required
        autoFocus
      />
    </label>
  );
}

interface MfaProps {
  onDone: () => void;
  onCancel: () => void;
}

export function TotpVerifyScreen({ onDone, onCancel, onEnroll }: MfaProps & { onEnroll: () => void }) {
  useDocumentTitle("Verification");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || code.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyTotp({ code, rememberDevice: remember });
      onDone();
    } catch (err) {
      setError(authError(err, "Wrong or expired code. Try the next one."));
      setCode("");
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Two-step verification">
      <form onSubmit={(e) => void submit(e)} className="stack">
        <CodeInput value={code} onChange={setCode} />
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember this device for 30 days</span>
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length < 6}>
          {busy ? "Checking…" : "Verify"}
        </button>
        <div className="auth-links">
          <button type="button" className="link-button" onClick={onEnroll}>
            I haven't set up an authenticator app yet
          </button>
          <button type="button" className="link-button" onClick={onCancel}>
            Sign out
          </button>
        </div>
      </form>
    </AuthCard>
  );
}

export function TotpEnrollScreen({ onDone, onCancel }: MfaProps) {
  useDocumentTitle("Set up verification");
  const [enroll, setEnroll] = useState<TotpEnrollStart | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const start = async () => {
    setLoadError(null);
    try {
      setEnroll(await api.startTotpEnroll());
    } catch (err) {
      setLoadError(authError(err, "Couldn't start the setup."));
    }
  };

  useEffect(() => {
    // Each call may mint a new secret: start exactly once (StrictMode runs effects twice).
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || code.length < 6) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmTotp(code);
      onDone();
    } catch (err) {
      setError(authError(err, "Wrong code. Check the time on your phone and try again."));
      setCode("");
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Set up two-step verification">
      {loadError ? (
        <div className="stack">
          <p className="form-error" role="alert">
            {loadError}
          </p>
          <button type="button" className="btn" onClick={() => void start()}>
            Try again
          </button>
        </div>
      ) : !enroll ? (
        <p className="muted">Getting ready…</p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="stack">
          <ol className="steps">
            <li>Open an authenticator app (e.g. Google Authenticator, Microsoft Authenticator, 1Password).</li>
            <li>Add an account with “Enter a setup key” and type this key:</li>
          </ol>
          <div className="secret-box">
            <code className="secret" aria-label="Secret key">
              {groupSecret(enroll.secret)}
            </code>
            <CopyButton text={enroll.secret} label="Copy key" />
          </div>
          <details className="details">
            <summary>otpauth link (for apps that accept it)</summary>
            <div className="secret-box">
              <code className="uri">{enroll.otpauthUri}</code>
              <CopyButton text={enroll.otpauthUri} label="Copy link" />
            </div>
          </details>
          <p className="muted">Then type the 6-digit code the app shows:</p>
          <CodeInput value={code} onChange={setCode} />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Turn on"}
          </button>
        </form>
      )}
      <div className="auth-links">
        <button type="button" className="link-button" onClick={onCancel}>
          Sign out
        </button>
      </div>
    </AuthCard>
  );
}
