/**
 * Admin → AI (the first section of #/admin): the provider, model and key for the whole installation. The section:
 * - shows what the worker last reported running with, and a banner whenever AI is paused or a chosen provider can't
 *   run (a pause nobody notices leaves mail unread for hours);
 * - lets a platform admin pick Claude, OpenAI, Gemini or Grok, or turn AI off (the free mock);
 * - loads a pasted key's models on its own, after a short pause in typing.
 *
 * The key:
 * - stays in this component's state only: it goes to the server in a JSON body, never in a URL, storage, a toast or
 *   a log;
 * - is cleared after a save, on a provider switch, and when the page is hidden or closed.
 * The server seals it with the credentials public key, so only the worker can open it; only its last four
 * characters ever come back.
 */
import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AI_KEY_ENV } from "../../../src/ai/providers.js";
import type { AdminAi as AdminAiState } from "../../../src/server/api-types.js";
import {
  aiErrorText,
  applyPending,
  capsText,
  costNote,
  currentModel,
  freeModelHint,
  IDLE,
  initialChoice,
  keyProblem,
  keyStatusText,
  MODEL_LIST_DELAY_MS,
  modelField,
  modelsNote,
  pauseBanner,
  pickModel,
  qualityNote,
  safeKeyUrl,
  saveBlocker,
  saveRequest,
  savedChoiceText,
  shouldLoadModels,
  workerOf,
  workerStatus,
  type AiChoice,
  type Listing,
} from "../ai-form.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { ConfirmDialog } from "../components/Dialog.js";
import { useToast } from "../components/Toast.js";
import { agoLabel, formatDateTime, minutesSince } from "../format.js";
import { useApp } from "../hooks.js";

export function AdminAi() {
  const { zone, today } = useApp();
  const toast = useToast();
  const ids = useId();
  const [ai, setAi] = useState<AdminAiState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<AiChoice>("mock");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [listing, setListing] = useState<Listing>(IDLE);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** Bumped by every key, provider or server change: a model listing still in flight for an older one is ignored. */
  const seq = useRef(0);

  /** Server state in, and the form reset to it. `keep` holds the admin's provider choice, else the saved one is used. */
  const apply = useCallback((next: AdminAiState, keep?: AiChoice) => {
    seq.current++;
    const c = keep && (keep === "mock" || next.providers.some((p) => p.id === keep)) ? keep : initialChoice(next);
    setAi(next);
    setChoice(c);
    setModel(c === "mock" ? "" : pickModel(next.providers.find((p) => p.id === c)?.models ?? [], currentModel(next, c)));
    setApiKey("");
    setListing(IDLE);
    setFormError(null);
  }, []);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .adminAi()
      .then((d) => apply(d))
      .catch((err) => !(isApiError(err) && err.handled) && setLoadError(errorMessage(err)));
  }, [apply]);
  useEffect(load, [load]);

  /** The status only: the form and a key being typed stay as they are. */
  const refresh = () => {
    api
      .adminAi()
      .then(setAi)
      .catch((err) => !(isApiError(err) && err.handled) && toast(errorMessage(err), "error"));
  };

  // A pasted key's models load on their own, MODEL_LIST_DELAY_MS after the last change. The key and the provider
  // come from the same render, so a key is only ever sent to the provider it was typed for.
  useEffect(() => {
    const n = ++seq.current;
    if (choice === "mock" || !shouldLoadModels(apiKey)) {
      setListing(IDLE);
      return;
    }
    const provider = choice;
    const key = apiKey.trim();
    setListing({ state: "loading" });
    const timer = window.setTimeout(() => {
      api
        .adminAiModels({ provider, apiKey: key })
        .then((r) => {
          if (n !== seq.current) return;
          setListing({ state: "ok", models: r.models });
          setModel((m) => pickModel(r.models, m));
        })
        .catch((err) => {
          if (n !== seq.current || (isApiError(err) && err.handled)) return;
          setListing({ state: "error", message: aiErrorText(err) });
        });
    }, MODEL_LIST_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [apiKey, choice]);

  // Leaving the page: answers still in flight are dropped (the listing effect's cleanup cancels the timer).
  // A hidden page (another site, a closed tab, the back-forward cache) also loses the typed key.
  useEffect(() => {
    const clear = () => setApiKey("");
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      seq.current++;
    };
  }, []);

  const head = (
    <div className="admin-head">
      <h2 id="adm-ai" className="section-title">
        AI provider
      </h2>
      {ai ? (
        <button type="button" className="btn btn-small" onClick={refresh}>
          <RefreshCw size={14} aria-hidden="true" />
          Refresh status
        </button>
      ) : null}
    </div>
  );

  if (loadError) {
    return (
      <section aria-labelledby="adm-ai" className="admin-section">
        {head}
        <div className="error-box" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={load}>
            Try again
          </button>
        </div>
      </section>
    );
  }
  if (!ai) {
    return (
      <section aria-labelledby="adm-ai" className="admin-section">
        {head}
        <p className="muted loading">Loading…</p>
      </section>
    );
  }

  const selected = choice === "mock" ? null : (ai.providers.find((p) => p.id === choice) ?? null);
  const label = selected?.label ?? "the free mock";
  const values = { choice, model, apiKey, listing };
  const blocker = saveBlocker(selected, values);
  const field = selected ? modelField(selected, apiKey, listing) : null;
  const status = workerStatus(ai);
  const when = (iso: string) => formatDateTime(iso, zone, today);
  const envKey = selected?.key?.source === "env";
  const storedKey = selected?.key?.source === "stored" ? selected.key : null;
  const keyUrl = safeKeyUrl(selected?.keyUrl);
  const problem = keyProblem(apiKey);
  const listNote = selected ? modelsNote(selected, when) : null;
  const banner = pauseBanner(ai);
  const worker = workerOf(ai);
  // Removing this key leaves the provider in use without one: AI pauses until another key or provider is saved.
  const keyInUse = Boolean(
    selected && storedKey && (ai.selection?.provider === selected.id || (worker?.mode === "provider" && worker.provider === selected.id && worker.source === "stored")),
  );
  const reported = ai.worker ? agoLabel(minutesSince(ai.worker.at)) : null;
  const notes = [capsText(ai.caps), costNote(choice, label), qualityNote(choice, label)].filter((n): n is string => Boolean(n));

  const choose = (c: AiChoice) => {
    setChoice(c);
    setApiKey("");
    setListing(IDLE);
    setFormError(null);
    setModel(c === "mock" ? "" : pickModel(ai.providers.find((p) => p.id === c)?.models ?? [], currentModel(ai, c)));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (blocker) {
      setFormError(blocker);
      return;
    }
    setBusy(true);
    setFormError(null);
    const body = saveRequest(selected, { choice, model, apiKey });
    try {
      const next = await api.adminAiSave(body);
      apply(next, body.provider);
      toast(body.provider === "mock" ? "Saved: AI off (free mock)" : `Saved: ${label} · ${body.model ?? ""}`, "success");
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setFormError(aiErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = () => {
    if (!selected || !storedKey) return;
    setBusy(true);
    api
      .adminAiDeleteKey(selected.id)
      .then((next) => {
        apply(next, choice);
        toast(`Removed the ${selected.label} key`, "success");
      })
      .catch((err) => !(isApiError(err) && err.handled) && toast(aiErrorText(err), "error"))
      .finally(() => {
        setBusy(false);
        setConfirmRemove(false);
      });
  };

  return (
    <section aria-labelledby="adm-ai" className="admin-section">
      {head}
      {banner ? (
        <div className="banner banner-danger admin-ai-alert" role="alert">
          <TriangleAlert size={20} aria-hidden="true" />
          <p>
            <strong>{banner.text}</strong> {banner.fix}
            {banner.since ? ` Since ${when(banner.since)}.` : null}
            {banner.pending ? ` ${banner.pending}` : null}
          </p>
        </div>
      ) : null}
      <form className="card admin-form" autoComplete="off" onSubmit={(e) => void save(e)}>
        <div className="admin-ai-status" aria-live="polite">
          <p className="admin-state">
            <span className={status.tone === "ai" ? "led led-ai" : status.tone === "paused" ? "led led-paused" : "led"} aria-hidden="true" />
            {status.text}
            {reported ? <span className="muted">· reported {reported}</span> : null}
          </p>
          {status.detail ? <p className="muted small">{status.detail}</p> : null}
          {applyPending(ai) ? <p className="notice small">{savedChoiceText(ai)} It applies on the worker's next run, within a few minutes.</p> : null}
        </div>

        <fieldset className="radio-group">
          <legend className="field-label">Provider</legend>
          {ai.providers.map((p) => (
            <label key={p.id} className="radio">
              <input type="radio" name="ai-provider" value={p.id} checked={choice === p.id} onChange={() => choose(p.id)} />
              <span>{p.label}</span>
              {p.key ? <span className="admin-chip">{p.key.source === "env" ? "key in the environment" : `key …${p.key.last4}`}</span> : null}
            </label>
          ))}
          <label className="radio">
            <input type="radio" name="ai-provider" value="mock" checked={choice === "mock"} onChange={() => choose("mock")} />
            <span>Off (free mock, no AI)</span>
          </label>
        </fieldset>

        {selected && field ? (
          <div className="grid-form">
            <div className="field field-wide">
              <label className="field-label" htmlFor={`${ids}-key`}>
                API key for {selected.label}
              </label>
              <input
                id={`${ids}-key`}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                readOnly={envKey}
                placeholder={envKey ? "Set in the server environment" : storedKey ? "Paste a new key to replace the saved one" : "Paste the key"}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore=""
                data-form-type="other"
                aria-describedby={`${ids}-key-status`}
              />
              <span className="hint" id={`${ids}-key-status`}>
                {keyStatusText(selected.key, when)}
                {keyUrl && !envKey ? (
                  <>
                    {" · "}
                    <a className="admin-ai-keylink" href={keyUrl} target="_blank" rel="noopener noreferrer">
                      Create a key
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </>
                ) : null}
              </span>
              {envKey ? (
                <span className="hint">
                  {AI_KEY_ENV[selected.id]} in the worker's environment wins over a key typed here. To change it, edit it there and restart the worker.
                </span>
              ) : null}
              {problem ? <span className="hint hint-error">{problem}</span> : null}
            </div>

            <div className="field field-wide">
              <label className="field-label" htmlFor={`${ids}-model`}>
                Model
              </label>
              {field.kind === "select" ? (
                <select id={`${ids}-model`} value={model} onChange={(e) => setModel(e.target.value)}>
                  {field.options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label === o.id ? o.id : `${o.label} (${o.id})`}
                    </option>
                  ))}
                </select>
              ) : field.kind === "text" ? (
                <input
                  id={`${ids}-model`}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="The model's id"
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <select id={`${ids}-model`} disabled value="">
                  <option value="">{field.kind === "error" ? "No models" : "—"}</option>
                </select>
              )}
              {field.kind === "text" ? <span className="hint">{freeModelHint(ai)}</span> : null}
              {field.kind === "select" && !apiKey.trim() && listNote ? <span className="hint">{listNote}</span> : null}
              {field.kind === "wait" ? (
                <span className="hint" aria-live="polite">
                  {field.text}
                </span>
              ) : null}
              {field.kind === "error" ? (
                <span className="hint hint-error" role="alert">
                  {field.text}
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="muted small">With AI off, MailMe uses simple built-in rules instead. They make no network calls and cost nothing, but only recognise simple phrasings.</p>
        )}

        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}
        <div className="button-row">
          <button type="submit" className="btn btn-primary" aria-disabled={busy || blocker !== null || undefined}>
            {busy ? "Saving…" : "Save"}
          </button>
          {storedKey ? (
            <button type="button" className="btn btn-danger-quiet" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove key
            </button>
          ) : null}
        </div>

        <ul className="admin-ai-notes muted small">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            The web server uses a pasted key only to list its models (which checks it), then seals it with this installation's public key: from then on
            only the worker can open it. It is never shown again (only its last 4 characters), and every change is written to the security audit log.
          </li>
        </ul>
      </form>

      {confirmRemove && selected && storedKey ? (
        <ConfirmDialog
          title={`Remove the ${selected.label} key`}
          message={
            keyInUse
              ? `MailMe forgets the saved key …${storedKey.last4}. ${selected.label} is the provider in use, so AI pauses until you add another key or choose another provider.`
              : `MailMe forgets the saved key …${storedKey.last4}. The provider in use doesn't change.`
          }
          confirmLabel="Remove key"
          danger
          busy={busy}
          onConfirm={removeKey}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </section>
  );
}
