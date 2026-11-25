/** “+ New task”: a manual task (a task the AI missed is also a recall signal). */
import { useState, type FormEvent } from "react";
import type { OpenStatus } from "../../../src/domain/types.js";
import { errorMessage, isApiError } from "../api.js";
import { api } from "../client.js";
import { CompanyDatalist } from "../components/CompanyDatalist.js";
import { useToast } from "../components/Toast.js";
import { formatDateLong } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { OPEN_STATUS_ORDER, PRIORITY_LABELS, PRIORITY_ORDER, STATUS_LABELS } from "../labels.js";
import { chosenMailbox, hasViews, mailboxNames, newTaskMailbox } from "../mailbox-view.js";
import { navigate } from "../router.js";
import { EMPTY_TASK_FORM, createRequestFromForm, validateTaskForm, type TaskFormState } from "../task-form.js";
import { getLastListHref } from "./TaskList.js";

const STATUS_HINTS: Record<OpenStatus, string> = {
  ACTION_REQUIRED: "someone asked you for something",
  WAITING_FOR_ME: "you promised to do something",
  WAITING_FOR_OTHER: "you asked for something and are waiting for a reply",
};

export function NewTask({ fromMessageId }: { fromMessageId: string | null }) {
  useDocumentTitle("New task");
  const { today, mailboxes, viewId } = useApp();
  const toast = useToast();
  const [form, setForm] = useState<TaskFormState>(EMPTY_TASK_FORM);
  // For a user with several mailboxes: the one the task belongs to. Until they choose, the one they are looking at.
  const [pickedBox, setPickedBox] = useState<string | null>(null);
  const box = pickedBox ?? newTaskMailbox(mailboxes, viewId);
  const offerBox = hasViews(mailboxes) && !fromMessageId;
  const boxNames = mailboxNames(mailboxes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof TaskFormState>(k: K, v: TaskFormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const invalid = validateTaskForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api.createTask(createRequestFromForm(form, fromMessageId, offerBox ? chosenMailbox(mailboxes, box) : null));
      toast(`Created #${created.ref}`, "success");
      navigate({ name: "task", id: created.id }, { replace: true });
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="bridge bridge-compact">
        <a className="back-link" href={getLastListHref()}>
          ← Back to the list
        </a>
        <h1 className="page-title">New task</h1>
      </header>
      <section className="card">
        {fromMessageId ? <p className="muted small">It will be linked to the message you started from.</p> : null}
        <form className="grid-form" onSubmit={(e) => void submit(e)}>
          <CompanyDatalist id="new-company-options" />
          <label className="field field-wide">
            <span className="field-label">Title *</span>
            <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={300} required autoFocus placeholder="e.g. Send ABC a quote for 20 speakers" />
          </label>
          <fieldset className="radio-group field-wide">
            <legend className="field-label">What kind of task?</legend>
            {OPEN_STATUS_ORDER.map((s) => (
              <label key={s} className="radio">
                <input type="radio" name="new-status" checked={form.status === s} onChange={() => set("status", s)} />
                <span>
                  {STATUS_LABELS[s]} <span className="muted small">— {STATUS_HINTS[s]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="field">
            <span className="field-label">Priority</span>
            <select value={form.priority} onChange={(e) => set("priority", e.target.value as TaskFormState["priority"])}>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Due date</span>
            <input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
            {form.dueDate ? <span className="hint">{formatDateLong(form.dueDate, today)}</span> : null}
          </label>
          <label className="field field-wide">
            <span className="field-label">Next step</span>
            <input value={form.nextAction} onChange={(e) => set("nextAction", e.target.value)} maxLength={300} />
          </label>
          <label className="field">
            <span className="field-label">Company</span>
            <input value={form.company} onChange={(e) => set("company", e.target.value)} maxLength={200} list="new-company-options" />
          </label>
          <label className="field">
            <span className="field-label">Contact (name)</span>
            <input value={form.counterpartyName} onChange={(e) => set("counterpartyName", e.target.value)} maxLength={200} />
          </label>
          <label className="field">
            <span className="field-label">Contact (email)</span>
            <input type="email" value={form.counterpartyAddress} onChange={(e) => set("counterpartyAddress", e.target.value)} maxLength={320} />
          </label>
          {offerBox ? (
            <label className="field">
              <span className="field-label">Mailbox</span>
              <select value={chosenMailbox(mailboxes, box) ?? ""} onChange={(e) => setPickedBox(e.target.value)}>
                <option value="">No particular one</option>
                {mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>
                    {boxNames.get(m.id) ?? m.address}
                  </option>
                ))}
              </select>
              <span className="hint">That is where you will find it when you look at one mailbox at a time.</span>
            </label>
          ) : null}
          <label className="field field-wide">
            <span className="field-label">Notes / summary</span>
            <textarea rows={3} value={form.summary} onChange={(e) => set("summary", e.target.value)} maxLength={2000} />
          </label>
          {error ? (
            <p className="form-error field-wide" role="alert">
              {error}
            </p>
          ) : null}
          <div className="button-row field-wide">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </button>
            <a className="btn" href={getLastListHref()}>
              Cancel
            </a>
          </div>
        </form>
      </section>
    </div>
  );
}
