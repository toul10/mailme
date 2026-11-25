/**
 * Task page: the head (who, what, state), the AI's open questions, why it is a task (the
 * sentence, highlighted again where it was written), the conversation, then actions and facts. Desktop: two
 * columns, facts and actions sticky on the right. Mobile: one column in that same order (DOM order = visual order),
 * with the actions in a bottom bar. Editing opens in place of the facts. A 409 reloads the task and says so.
 */
import { ArrowLeft, Paperclip } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { SnoozeMode } from "../../../src/domain/types.js";
import type { EvidenceView, TaskActionRequest, TaskDetail, TaskEventView, TaskMessageExcerpt } from "../../../src/server/api-types.js";
import { errorMessage, isApiError, isConflict, type ApiRequestError } from "../api.js";
import { api } from "../client.js";
import { CompanyDatalist } from "../components/CompanyDatalist.js";
import { ConfirmDialog } from "../components/Dialog.js";
import { Quote } from "../components/Quote.js";
import { SnoozeDialog } from "../components/SnoozeDialog.js";
import { useToast } from "../components/Toast.js";
import { TriageCard, isStaleSuggestion } from "../components/TriageCard.js";
import { restoreFocus, type FocusPlan } from "../focus.js";
import { counterpartyLabel, formatDateLong, formatDateTime } from "../format.js";
import { useApp, useDocumentTitle } from "../hooks.js";
import { hasViews, mailboxName } from "../mailbox-view.js";
import { LOCKABLE_FIELD_LABELS, OPEN_STATUS_ORDER, PRIORITY_LABELS, PRIORITY_ORDER, eventOpLabel, isOpen } from "../labels.js";
import {
  STATUS_WORDS,
  ageFact,
  collectQuotes,
  displayTitle,
  distinctOrigin,
  eventEvidence,
  highlightRanges,
  isSnoozed,
  repeatsQuote,
  timePhrase,
  usefulNextAction,
  whoLabel,
} from "../present.js";
import { navigate, routeHref } from "../router.js";
import { diffTaskEdit, formFromTask, isEmptyPatch, validateTaskForm, type TaskFormState } from "../task-form.js";
import { NOT_A_TASK_CONFIRM, latestReviewedChange } from "../triage.js";
import { CompanyAvatar, PersonAvatar } from "../ui/Avatar.js";
import { MergeDialog } from "./MergeDialog.js";
import { getLastListHref } from "./TaskList.js";

export const CONFLICT_TOAST = "The task changed in the meantime — refreshed";

type Modal = null | "snooze" | "merge" | "not_a_task" | "handled_by_other";

export function TaskPage({ id, startEditing = false }: { id: string; startEditing?: boolean }) {
  const { me, zone, today, mailboxes } = useApp();
  const toast = useToast();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiRequestError | Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** Next edit-form change moves focus: into the form when it opens, back to its toggle after a save. */
  const editFocus = useRef<"form" | "toggle" | null>(null);
  const focusPlan = useRef<FocusPlan | null>(null);

  useDocumentTitle(task ? displayTitle(task) : "Task");

  const load = useCallback(async () => {
    try {
      const t = await api.getTask(id);
      setTask(t);
      setLoadError(null);
      return t;
    } catch (err) {
      if (!(isApiError(err) && err.handled)) setLoadError(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }, [id]);

  useEffect(() => {
    setTask(null);
    void load();
  }, [load]);

  const openEdit = useCallback(() => {
    editFocus.current = "form";
    setEditing(true);
  }, []);

  // ?edit=1 (an answer on “Today”): open the form once the task is here, then drop the flag from the URL.
  const loaded = task !== null;
  useEffect(() => {
    if (!startEditing || !loaded) return;
    openEdit();
    navigate({ name: "task", id }, { replace: true });
  }, [startEditing, loaded, id, openEdit]);

  useEffect(() => {
    const target = editFocus.current;
    if (!target) return;
    editFocus.current = null;
    if (target === "form" && editing) {
      const el = editRef.current;
      el?.scrollIntoView({ block: "start" });
      el?.querySelector<HTMLElement>("select, input, textarea")?.focus({ preventScroll: true });
    } else if (target === "toggle" && !editing) {
      toggleRef.current?.focus();
    }
  }, [editing]);

  // After an answered question disappeared: the next question, else the title.
  useEffect(() => {
    if (!focusPlan.current) return;
    restoreFocus({ targets: [...focusPlan.current.targets, "#tp-title-h"] });
    focusPlan.current = null;
  }, [task]);

  /** Runs a mutation that returns the updated task; on 409 reloads and tells the user. */
  const mutate = useCallback(
    async (key: string, fn: (t: TaskDetail) => Promise<TaskDetail>, success?: string): Promise<boolean> => {
      if (!task || busy) return false;
      setBusy(key);
      try {
        const next = await fn(task);
        setTask(next);
        if (success) toast(success, "success");
        return true;
      } catch (err) {
        if (isConflict(err)) {
          await load();
          toast(CONFLICT_TOAST, "info");
        } else if (!(isApiError(err) && err.handled)) {
          toast(errorMessage(err), "error");
        }
        return false;
      } finally {
        setBusy(null);
      }
    },
    [task, busy, load, toast],
  );

  const act = (key: string, action: TaskActionRequest, success: string) => mutate(key, (t) => api.taskAction(t.id, { ...action, version: t.version }), success);

  if (loadError) {
    const notFound = isApiError(loadError) && (loadError.code === "not_found" || loadError.code === "forbidden");
    return (
      <div className="page">
        <BackLink />
        <div className="error-box" role="alert">
          <p>{notFound ? "Task not found (it may have been merged into another task, or deleted)." : errorMessage(loadError)}</p>
          {!notFound ? (
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="page">
        <BackLink />
        <p className="muted loading">Loading…</p>
      </div>
    );
  }

  const open = isOpen(task.status);
  const snoozed = isSnoozed(task, today);
  const time = timePhrase(task, today, zone);
  const pending = task.suggestions.filter((s) => (s.suggestionState === "pending" || s.suggestionState === null) && !isStaleSuggestion(s.id));
  const why = task.evidence ?? firstAiEvidence(task.events);
  const origin = distinctOrigin(task);
  const next = usefulNextAction(task);
  const quotes = collectQuotes(task);
  const age = ageFact(task, zone, today);
  const summary = task.summary && !repeatsQuote(task.summary, why?.quote ?? null) ? task.summary : null;
  const showWhy = Boolean(why || origin || summary || task.items.length > 0 || task.origin !== "manual");
  const owner = task.ownerKind === "INTERNAL" ? task.ownerLabel?.trim() || task.ownerName?.trim() || task.ownerAddress?.trim() || "Colleague" : null;
  // Which of the user's mailboxes the task belongs to, when they have several.
  const box = hasViews(mailboxes) ? mailboxName(mailboxes, task.mailboxId) : null;
  const busyAttr = busy !== null || undefined;

  const onAnswered = (focus: FocusPlan | null) => {
    if (focus) focusPlan.current = focus;
    void load();
  };

  const onSnooze = async (mode: SnoozeMode, until: string | null) => {
    const ok = await act("snooze", { action: "snooze", mode, until }, until ? `Snoozed until ${formatDateLong(until, today)}` : "Snoozed until they reply");
    if (ok) setModal(null);
  };

  const onDismiss = async (kind: "not_a_task" | "handled_by_other") => {
    const ok = await act(kind, { action: "dismiss", kind }, kind === "not_a_task" ? "Removed" : "Closed: someone else has it");
    if (ok) setModal(null);
    if (ok && kind === "not_a_task") offerMute();
  };

  /** After “Not a task” from an outside sender: ask whether to ignore their mail from now on. */
  const offerMute = () => {
    const addr = task.counterpartyAddress?.trim().toLowerCase();
    const ownDomain = me.email.slice(me.email.lastIndexOf("@")).toLowerCase();
    if (!addr || !addr.includes("@") || addr.endsWith(ownDomain)) return;
    toast(`Ignore email from ${addr} from now on?`, "info", {
      action: {
        label: "Yes, ignore it",
        onClick: () =>
          void api
            .muteSender(addr)
            .then(() => toast(`No more tasks will be created from ${addr}. You can change this in “What matters to me”.`, "success"))
            .catch((err) => !(isApiError(err) && err.handled) && toast(errorMessage(err), "error")),
      },
    });
  };

  /** Menu items: move focus to ⋯ before hiding the menu, so a dialog opened from it returns focus there. */
  const closeMenu = (e: { currentTarget: HTMLElement }) => {
    const d = e.currentTarget.closest("details");
    d?.querySelector<HTMLElement>("summary")?.focus();
    d?.removeAttribute("open");
  };

  // One stable primary button (label and action follow the state), so keyboard focus survives the switch.
  const primary = open
    ? { label: "Done", run: () => act("complete", { action: "complete" }, "Done") }
    : { label: task.status === "DISMISSED" ? "Reopen it" : "Not done, reopen it", run: () => act("reopen", { action: "reopen" }, "Reopened") };

  return (
    <div className="tp">
      <header className="bridge tp-head">
        <div className="tp-head-row">
          <div className="tp-head-main">
            <BackLink />
            <p className="tp-who">
              {task.company ? <CompanyAvatar name={task.company} size="sm" /> : null}
              <span>{whoLabel(task) ?? "No contact"}</span>
            </p>
            <TitleEditor task={task} busy={busy !== null} onSave={(title) => mutate("title", (t) => api.editTask(t.id, { version: t.version, title }), "Title changed")} />
            <p className="tp-state">
              <span className="tp-status">{STATUS_WORDS[task.status]}</span>
              {time ? (
                <span className={`trow-time tone-${time.tone}`} title={time.title}>
                  <span className="led" aria-hidden="true" />
                  {time.text}
                </span>
              ) : null}
              {task.priority === "URGENT" ? <span className="tp-urgent">Urgent</span> : null}
            </p>
          </div>
          <div className="tp-actions" role="group" aria-label="Actions">
            {/* aria-disabled, not disabled: a disabled button drops the keyboard focus it holds. */}
            <button type="button" className="btn btn-primary" aria-disabled={busyAttr} onClick={() => void primary.run()}>
              {primary.label}
            </button>
            {open ? (
              snoozed ? (
                <button type="button" className="btn" aria-disabled={busyAttr} onClick={() => void act("unsnooze", { action: "unsnooze" }, "Snooze cancelled")}>
                  Cancel snooze
                </button>
              ) : (
                <button type="button" className="btn" aria-disabled={busyAttr} onClick={() => busy === null && setModal("snooze")}>
                  Snooze
                </button>
              )
            ) : null}
            <details className="more-menu">
              <summary className="btn" aria-label="More actions">
                ⋯
              </summary>
              <div className="menu">
                {open ? (
                  <>
                    <button type="button" onClick={(e) => (closeMenu(e), setModal("not_a_task"))}>
                      Not a task
                    </button>
                    <button type="button" onClick={(e) => (closeMenu(e), setModal("handled_by_other"))}>
                      Someone else has it
                    </button>
                    <button type="button" onClick={(e) => (closeMenu(e), void act("still_valid", { action: "still_valid" }, "Noted: still valid"))}>
                      Still valid
                    </button>
                  </>
                ) : null}
                <button type="button" onClick={(e) => (closeMenu(e), setModal("merge"))}>
                  Merge with another task…
                </button>
                <button type="button" onClick={(e) => (closeMenu(e), void act("would_have_missed", { action: "would_have_missed" }, "Noted — thank you"))}>
                  I'd have missed this
                </button>
              </div>
            </details>
          </div>
        </div>
        {pending.length > 0 || task.needsReview ? (
          <section className="asks" aria-labelledby="asks-h" data-focus-fallback="tp-title-h">
            <div className="asks-head">
              <h2 id="asks-h" className="asks-title">
                <span className="led led-ai" aria-hidden="true" />
                The AI asks
              </h2>
            </div>
            <div className="asks-list">
              {pending.map((s) => (
                <TriageCard key={s.id} kind="suggestion" task={task} suggestion={s} zone={zone} today={today} place="task" onAnswered={onAnswered} onEdit={openEdit} />
              ))}
              {/* The flag's own question too (a bounce or a forged sender must not hide behind a suggestion). */}
              {task.needsReview ? (
                <TriageCard
                  kind="review"
                  task={task}
                  suggestion={null}
                  zone={zone}
                  today={today}
                  place="task"
                  onAnswered={onAnswered}
                  onEdit={openEdit}
                  reasons={task.reviewReasons}
                  change={latestReviewedChange(task.events)}
                />
              ) : null}
            </div>
          </section>
        ) : null}
      </header>

      <div className="tp-main">
        {showWhy ? (
          <section className="tp-why" aria-labelledby="why-h">
            <h2 id="why-h">{task.origin === "manual" && !why ? "Note" : "Why it's a task"}</h2>
            {why ? <Quote evidence={why} zone={zone} today={today} size="large" /> : task.origin === "manual" ? null : <p className="muted">The AI didn't keep a quote for this task.</p>}
            {origin ? (
              <div className="tp-origin">
                <p className="tp-origin-label">The original request</p>
                <Quote evidence={origin} zone={zone} today={today} />
              </div>
            ) : null}
            {summary ? <p className="tp-summary">{summary}</p> : null}
            {task.items.length > 0 ? (
              <ul className="items">
                {task.items.map((it, i) => (
                  <li key={i}>{it}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        <section className="tp-thread" aria-labelledby="thread-h">
          <h2 id="thread-h">
            Conversation {task.messages.length > 0 ? <span className="count">{task.messages.length}</span> : null}
          </h2>
          <Letters messages={task.messages} quotes={quotes} zone={zone} today={today} />
        </section>

        <History events={task.events} zone={zone} today={today} />
      </div>

      <aside className={editing ? "tp-side is-editing" : "tp-side"} aria-label="Actions and details">
        {editing ? null : (
          <dl className="tp-facts">
            <Fact label="Contact" value={counterpartyLabel(task) ?? task.company ?? "—"} />
            {next ? <Fact label="Next step" value={next} /> : null}
            <Fact
              label="Due date"
              value={task.dueDate ? `${formatDateLong(task.dueDate, today)}${task.duePhrase ? ` (“${task.duePhrase}”)` : ""}` : task.duePhrase ? `“${task.duePhrase}”` : "No due date"}
            />
            {task.priority !== "NORMAL" ? <Fact label="Priority" value={PRIORITY_LABELS[task.priority]} /> : null}
            {owner ? <Fact label="Handled by" value={owner} /> : null}
            {box ? <Fact label="Mailbox" value={box} /> : null}
            <Fact label={age.label} value={age.value} />
            {task.lockedFields.length > 0 ? <Fact label="The AI won't change" value={task.lockedFields.map((f) => LOCKABLE_FIELD_LABELS[f] ?? f).join(", ")} /> : null}
          </dl>
        )}

        <button
          ref={toggleRef}
          type="button"
          className="btn btn-quiet tp-edit-toggle"
          aria-expanded={editing}
          aria-controls="task-edit"
          onClick={() => (editing ? setEditing(false) : openEdit())}
        >
          {editing ? "Close editor" : "Edit details"}
        </button>

        {editing ? (
          <div id="task-edit" className="tp-edit" ref={editRef}>
            <EditForm
              task={task}
              busy={busy !== null}
              onSave={async (patch) => {
                const ok = await mutate("edit", (t) => api.editTask(t.id, { ...patch, version: t.version }), "Changes saved");
                if (ok) {
                  editFocus.current = "toggle";
                  setEditing(false);
                }
                return ok;
              }}
            />
          </div>
        ) : null}
      </aside>

      {modal === "snooze" ? (
        <SnoozeDialog
          today={today}
          title="Snooze"
          allowUntilReply={task.status === "WAITING_FOR_OTHER"}
          busy={busy !== null}
          onConfirm={(m, u) => void onSnooze(m, u)}
          onClose={() => setModal(null)}
        />
      ) : null}
      {modal === "not_a_task" ? (
        <ConfirmDialog
          title={NOT_A_TASK_CONFIRM.title}
          message={NOT_A_TASK_CONFIRM.message}
          confirmLabel={NOT_A_TASK_CONFIRM.confirmLabel}
          danger
          busy={busy !== null}
          onConfirm={() => void onDismiss("not_a_task")}
          onCancel={() => setModal(null)}
        />
      ) : null}
      {modal === "handled_by_other" ? (
        <ConfirmDialog
          title="Someone else has it"
          message="It will be closed for you as “someone else has it”."
          confirmLabel="Close"
          busy={busy !== null}
          onConfirm={() => void onDismiss("handled_by_other")}
          onCancel={() => setModal(null)}
        />
      ) : null}
      {modal === "merge" ? (
        <MergeDialog
          task={task}
          onClose={() => setModal(null)}
          onMerged={(survivor) => {
            setModal(null);
            toast("Merged into one task", "success");
            if (survivor.id === task.id) setTask(survivor);
            else navigate({ name: "task", id: survivor.id }, { replace: true });
          }}
          onConflict={() => {
            setModal(null);
            void load();
            toast(CONFLICT_TOAST, "info");
          }}
        />
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <a className="back-link" href={getLastListHref()}>
      <ArrowLeft size={16} aria-hidden="true" />
      Back
    </a>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function firstAiEvidence(events: TaskEventView[]): EvidenceView | null {
  const sorted = [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const e of sorted) if (e.actor === "ai" && e.evidenceQuote) return eventEvidence(e);
  return null;
}

/** Wraps the first occurrence of each quote in <mark> (ranges from present.highlightRanges, on the original text). */
export function highlight(text: string, quotes: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  highlightRanges(text, quotes).forEach(([s, e], i) => {
    if (s > pos) out.push(<Fragment key={`t${i}`}>{text.slice(pos, s)}</Fragment>);
    out.push(<mark key={`m${i}`}>{text.slice(s, e)}</mark>);
    pos = e;
  });
  if (pos < text.length) out.push(<Fragment key="tail">{text.slice(pos)}</Fragment>);
  return out;
}

function Letters({ messages, quotes, zone, today }: { messages: TaskMessageExcerpt[]; quotes: string[]; zone: string; today: string }) {
  const sorted = useMemo(() => [...messages].sort((a, b) => a.date.localeCompare(b.date)), [messages]);
  if (sorted.length === 0) return <p className="muted">No linked emails.</p>;
  return (
    <ol className="letters">
      {sorted.map((m) => {
        const out = m.direction === "OUTBOUND";
        const from = out ? "You" : m.fromName || m.fromAddress || "Unknown sender";
        return (
          <li key={`${m.messageId}:${m.role}`} className={out ? "letter letter-out" : "letter"}>
            {out ? (
              <span className="av av-me av-md" aria-hidden="true">
                You
              </span>
            ) : (
              <PersonAvatar name={from} size="md" />
            )}
            <div className="letter-sheet">
              <div className="letter-head">
                <span className="letter-from" title={out ? undefined : (m.fromAddress ?? undefined)}>
                  {from}
                </span>
                <span className="letter-when">{formatDateTime(m.date, zone, today)}</span>
              </div>
              <p className="letter-subject">{m.subject || "(no subject)"}</p>
              {m.excerpt ? <p className="letter-body">{highlight(m.excerpt, quotes)}</p> : null}
              <div className="letter-foot">
                {m.attachments.map((a, i) => (
                  <span key={i} className="letter-file">
                    <Paperclip size={14} aria-hidden="true" />
                    {a}
                  </span>
                ))}
                <a href={routeHref({ name: "new", fromMessageId: m.messageId })}>New task from this email</a>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const WHO: Record<TaskEventView["actor"], string> = { ai: "AI", user: "You", system: "MailMe" };

function History({ events, zone, today }: { events: TaskEventView[]; zone: string; today: string }) {
  const sorted = useMemo(() => [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [events]);
  if (sorted.length === 0) return null;
  return (
    <section className="tp-history">
      <details>
        <summary>
          History <span className="count">{sorted.length}</span>
        </summary>
        <ol>
          {sorted.map((e) => (
            <li key={e.id}>
              <span className={`led led-${e.actor}`} aria-hidden="true" />
              <span className="when">{formatDateTime(e.createdAt, zone, today)}</span>
              <span>
                <strong>{WHO[e.actor]}</strong>: {eventOpLabel(e.op)}
                {e.summary ? `, ${e.summary}` : ""}
                {e.suggestionState === "pending" ? " (waiting for your answer)" : e.suggestionState === "rejected" ? " (you said no)" : !e.applied && !e.suggestionState ? " (not applied)" : ""}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function TitleEditor({ task, busy, onSave }: { task: TaskDetail; busy: boolean; onSave: (title: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  useEffect(() => {
    if (!editing) setValue(task.title);
  }, [task.title, editing]);

  if (!editing) {
    return (
      <div className="tp-title-row">
        <h1 id="tp-title-h" className="tp-title" tabIndex={-1}>
          {displayTitle(task)}
        </h1>
        <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)} aria-label="Rename title">
          Rename
        </button>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const t = value.trim();
    if (!t || t === task.title) {
      setEditing(false);
      return;
    }
    if (await onSave(t)) setEditing(false);
  };
  return (
    <form className="title-edit" onSubmit={(e) => void submit(e)}>
      <label className="field field-grow">
        <span className="sr-only">Title</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={300} autoFocus required onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
      </label>
      <button type="submit" className="btn btn-primary btn-small" aria-disabled={busy || undefined}>
        Save
      </button>
      <button type="button" className="btn btn-small" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </form>
  );
}

function LockMark({ task, field }: { task: TaskDetail; field: string }) {
  if (!task.lockedFields.includes(field)) return null;
  return (
    <span className="lock" title="You changed this — the AI no longer changes it (it only suggests)">
      <span aria-hidden="true">🔒</span>
      <span className="sr-only"> (you changed this)</span>
    </span>
  );
}

function EditForm({ task, busy, onSave }: { task: TaskDetail; busy: boolean; onSave: (patch: ReturnType<typeof diffTaskEdit>) => Promise<boolean> }) {
  const { today } = useApp();
  const [form, setForm] = useState<TaskFormState>(() => formFromTask(task));
  const [error, setError] = useState<string | null>(null);
  // A new server state (save, action, 409 reload) resets the form to it.
  useEffect(() => {
    setForm(formFromTask(task));
    setError(null);
  }, [task]);

  const patch = useMemo(() => diffTaskEdit(task, form), [task, form]);
  const dirty = !isEmptyPatch(patch);
  const open = isOpen(task.status);
  const set = <K extends keyof TaskFormState>(k: K, v: TaskFormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const invalid = validateTaskForm(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    if (dirty) await onSave(patch);
  };

  const lockedNames = task.lockedFields.map((f) => LOCKABLE_FIELD_LABELS[f] ?? f);

  return (
    <section aria-labelledby="edit-h">
      <h2 id="edit-h" className="section-title">
        Details
      </h2>
      {lockedNames.length > 0 ? <p className="muted small">🔒 You changed these, so the AI only suggests changes: {lockedNames.join(", ")}</p> : null}
      <form className="grid-form" onSubmit={(e) => void submit(e)}>
        <CompanyDatalist id="company-options" />
        <label className="field">
          <span className="field-label">
            Status <LockMark task={task} field="status" />
          </span>
          {open ? (
            <select value={form.status} onChange={(e) => set("status", e.target.value as TaskFormState["status"])}>
              {OPEN_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_WORDS[s]}
                </option>
              ))}
            </select>
          ) : (
            <input value={STATUS_WORDS[task.status]} disabled />
          )}
        </label>
        <label className="field">
          <span className="field-label">
            Priority <LockMark task={task} field="priority" />
          </span>
          <select value={form.priority} onChange={(e) => set("priority", e.target.value as TaskFormState["priority"])}>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <label className="field-label" htmlFor="due-input">
            Due date <LockMark task={task} field="dueDate" />
          </label>
          <div className="inline">
            <input id="due-input" type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
            {form.dueDate ? (
              <button type="button" className="btn btn-ghost btn-small" onClick={() => set("dueDate", "")}>
                Clear
              </button>
            ) : null}
          </div>
          {form.dueDate && form.dueDate.length === 10 ? <span className="hint">{formatDateLong(form.dueDate, today)}</span> : null}
          {task.duePhrase ? <span className="hint">As written: “{task.duePhrase}”</span> : null}
        </div>
        <label className="field field-wide">
          <span className="field-label">
            Next step <LockMark task={task} field="nextAction" />
          </span>
          <input value={form.nextAction} onChange={(e) => set("nextAction", e.target.value)} maxLength={300} />
        </label>
        <label className="field">
          <span className="field-label">
            Company <LockMark task={task} field="company" />
          </span>
          <input value={form.company} onChange={(e) => set("company", e.target.value)} maxLength={200} list="company-options" />
        </label>
        <label className="field">
          <span className="field-label">Contact (name)</span>
          <input value={form.counterpartyName} onChange={(e) => set("counterpartyName", e.target.value)} maxLength={200} />
        </label>
        <label className="field">
          <span className="field-label">Contact (email)</span>
          <input type="email" value={form.counterpartyAddress} onChange={(e) => set("counterpartyAddress", e.target.value)} maxLength={320} />
        </label>
        <label className="field field-wide">
          <span className="field-label">
            Summary <LockMark task={task} field="summary" />
          </span>
          <textarea rows={3} value={form.summary} onChange={(e) => set("summary", e.target.value)} maxLength={2000} />
        </label>
        {error ? (
          <p className="form-error field-wide" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row field-wide">
          <button type="submit" className="btn btn-primary" disabled={!dirty} aria-disabled={busy || undefined}>
            Save changes
          </button>
          {dirty ? (
            <button type="button" className="btn" onClick={() => setForm(formFromTask(task))}>
              Discard changes
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
