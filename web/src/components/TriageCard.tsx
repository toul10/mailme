/**
 * The AI asks, never announces: a pending suggestion or a flagged task as one plain question
 * with plain answers (triage.ts decides which), showing the sentence that made the AI ask. An answer that teaches
 * the AI asks for confirmation first; an answer that closes the task can be undone from its toast.
 */
import { useRef, useState } from "react";
import type { EvidenceView, TaskDetail, TaskEventView, TaskListItem } from "../../../src/server/api-types.js";
import { errorMessage, isApiError, isConflict } from "../api.js";
import { api } from "../client.js";
import { cardFocusPlan, type FocusPlan } from "../focus.js";
import { displayTitle, eventEvidence, whoLabel } from "../present.js";
import { navigate, routeHref } from "../router.js";
import { triageCopy, type TriageAnswer, type TriagePlace } from "../triage.js";
import { CompanyAvatar } from "../ui/Avatar.js";
import { ConfirmDialog } from "./Dialog.js";
import { Quote } from "./Quote.js";
import { useToast } from "./Toast.js";

/**
 * Suggestions the server refused (409/404: already open, already closed, merged, gone). Hidden for the rest of the
 * session, so a reload cannot bring back a question that can no longer be answered.
 */
const staleSuggestions = new Set<string>();

export function isStaleSuggestion(id: string): boolean {
  return staleSuggestions.has(id);
}

interface Props {
  kind: "suggestion" | "review";
  task: TaskListItem;
  suggestion: TaskEventView | null;
  zone: string;
  today: string;
  place: TriagePlace;
  /** After an answer (the parent reloads); `focus` is where focus goes if the card disappears. */
  onAnswered: (focus: FocusPlan | null) => void;
  /** Task page: open the edit form in place (Today goes to the task page with it open). */
  onEdit?: () => void;
  /** Task page: why the AI asks, in words (TaskDetail.reviewReasons). */
  reasons?: string[];
  /** Task page: the change the AI applied while unsure (triage.latestReviewedChange). */
  change?: string | null;
}

export function TriageCard({ kind, task, suggestion, zone, today, place, onAnswered, onEdit, reasons, change }: Props) {
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<TriageAnswer | null>(null);
  const copy = triageCopy({ kind, suggestion, task, place, today, change });
  const evidence: EvidenceView | null = (suggestion && eventEvidence(suggestion)) ?? task.evidence;
  const cardKey = `${kind}:${suggestion?.id ?? task.id}`;

  const undo = async (closed: TaskDetail) => {
    try {
      await api.taskAction(task.id, { action: "reopen", version: closed.version });
      toast("Reopened", "success");
    } catch (err) {
      if (!(isApiError(err) && err.handled)) toast(isConflict(err) ? "It changed in the meantime — refreshed" : errorMessage(err), isConflict(err) ? "info" : "error");
    }
    onAnswered(null);
  };

  const run = async (a: TriageAnswer, confirmed = false) => {
    if (busy) return;
    if (a.effect.type === "open") {
      navigate({ name: "task", id: task.id });
      return;
    }
    if (a.effect.type === "edit") {
      if (onEdit) onEdit();
      else navigate({ name: "task", id: task.id, edit: true });
      return;
    }
    if (a.confirm && !confirmed) {
      setConfirming(a);
      return;
    }
    setBusy(a.label);
    const focus = cardFocusPlan(ref.current);
    try {
      const res =
        a.effect.type === "suggestion" && suggestion
          ? await api.resolveSuggestion(suggestion.id, a.effect.decision)
          : a.effect.type === "action"
            ? await api.taskAction(task.id, { ...a.effect.action, version: task.version })
            : null;
      setConfirming(null);
      if (a.done) toast(a.done, "success", a.undo && res ? { action: { label: "Undo", onClick: () => void undo(res) } } : undefined);
      onAnswered(focus);
    } catch (err) {
      setConfirming(null);
      const stale = isConflict(err) || (isApiError(err) && err.code === "not_found");
      if (stale && a.effect.type === "suggestion" && suggestion) {
        // The question no longer applies (e.g. “Reopen it?” on a task already reopened): drop it, don't loop.
        staleSuggestions.add(suggestion.id);
        toast("The question no longer applies — refreshed", "info");
        onAnswered(focus);
      } else if (stale) {
        toast("It changed in the meantime — refreshed", "info");
        onAnswered(focus);
      } else if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`ask${copy.tone === "warn" ? " ask-warn" : ""}${busy ? " is-busy" : ""}`} data-ask={cardKey} ref={ref}>
      {place === "today" ? (
        <header className="ask-task">
          {task.company ? <CompanyAvatar name={task.company} size="sm" /> : null}
          <span className="ask-who">{whoLabel(task) ?? "No contact"}</span>
          <a className="ask-title" href={routeHref({ name: "task", id: task.id })}>
            {displayTitle(task)}
          </a>
        </header>
      ) : null}
      <p className="ask-q">
        {copy.lead ? <span className={copy.tone === "warn" ? "ask-lead ask-lead-warn" : "ask-lead"}>{copy.lead} </span> : null}
        <span className="ask-question">{copy.question}</span>
      </p>
      {evidence ? <Quote evidence={evidence} zone={zone} today={today} /> : null}
      {reasons && reasons.length > 0 ? <p className="ask-reasons">Why the AI asks: {reasons.map((r) => r.replace(/^⚠️\s*/u, "")).join(" · ")}</p> : null}
      <div className="ask-answer" role="group" aria-label={copy.question}>
        {copy.answers.map((a) => (
          // aria-disabled, not disabled: a disabled button drops the keyboard focus it holds.
          <button key={a.label} type="button" className={a.primary ? "btn btn-primary" : "btn"} aria-disabled={busy !== null || undefined} onClick={() => void run(a)}>
            {a.label}
          </button>
        ))}
      </div>
      {confirming?.confirm ? (
        <ConfirmDialog
          title={confirming.confirm.title}
          message={confirming.confirm.message}
          confirmLabel={confirming.confirm.confirmLabel}
          danger={confirming.confirm.danger}
          busy={busy !== null}
          onConfirm={() => void run(confirming, true)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </article>
  );
}
