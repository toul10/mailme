/**
 * One task as a row (All) or a card (the channels on Today): who, what, the one time phrase with its light, the
 * sentence it came from, the next step and the two actions people use most — without opening the task. “Done”
 * can be undone from its toast.
 */
import { Check, Clock, CornerDownRight, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SnoozeMode } from "../../../src/domain/types.js";
import type { TaskDetail, TaskListItem } from "../../../src/server/api-types.js";
import { errorMessage, isApiError, isConflict } from "../api.js";
import { api } from "../client.js";
import { rowFocusPlan, type FocusPlan } from "../focus.js";
import { formatDateLong } from "../format.js";
import { isOpen } from "../labels.js";
import { displayTitle, ownerText, timePhrase, usefulNextAction, whoLabel } from "../present.js";
import { routeHref } from "../router.js";
import { CompanyAvatar, PersonAvatar } from "../ui/Avatar.js";
import { Quote } from "./Quote.js";
import { SnoozeDialog } from "./SnoozeDialog.js";
import { useToast } from "./Toast.js";

export const ROW_CONFLICT_TOAST = "It changed in the meantime — refreshed";

/** What a quick action did, for the parent list. */
export interface RowChange {
  /** The task as the action (or its undo) left it: update the row in place. */
  updated?: TaskDetail;
  /** The row's state is unknown (409/404): reload it. */
  stale?: boolean;
  /** Where focus goes if the row disappears. */
  focus?: FocusPlan | null;
}

interface Props {
  item: TaskListItem;
  zone: string;
  today: string;
  onChanged: (change: RowChange) => void;
  /** All: selection checkbox for bulk actions. */
  selectable?: { selected: boolean; onToggle: () => void };
  /** Hide the quote (dense lists). */
  showQuote?: boolean;
}

export function TaskRow({ item, zone, today, onChanged, selectable, showQuote = true }: Props) {
  const toast = useToast();
  const liRef = useRef<HTMLLIElement>(null);
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  // The version this row last saw: an action's response is newer than the parent's copy until it reloads.
  const [version, setVersion] = useState(item.version);
  useEffect(() => setVersion((v) => Math.max(v, item.version)), [item.version]);

  const time = timePhrase(item, today, zone);
  const who = whoLabel(item);
  const title = displayTitle(item);
  const next = usefulNextAction(item);
  const owner = ownerText(item);
  const open = isOpen(item.status);
  const href = routeHref({ name: "task", id: item.id });

  const failed = (err: unknown, focus: FocusPlan | null) => {
    if (isConflict(err) || (isApiError(err) && err.code === "not_found")) {
      toast(ROW_CONFLICT_TOAST, "info");
      onChanged({ stale: true, focus });
    } else if (!(isApiError(err) && err.handled)) toast(errorMessage(err), "error");
  };

  const run = async (fn: (version: number) => Promise<TaskDetail>, after: (res: TaskDetail) => void) => {
    if (busy) return;
    setBusy(true);
    const focus = rowFocusPlan(liRef.current);
    try {
      const res = await fn(version);
      setVersion(res.version);
      after(res);
      onChanged({ updated: res, focus });
    } catch (err) {
      failed(err, focus);
    } finally {
      setBusy(false);
    }
  };

  const undoComplete = async (done: TaskDetail) => {
    try {
      const back = await api.taskAction(item.id, { action: "reopen", version: done.version });
      toast(`Reopened: ${title}`, "success");
      onChanged({ updated: back });
    } catch (err) {
      failed(err, null);
    }
  };

  const complete = () =>
    run(
      (v) => api.taskAction(item.id, { action: "complete", version: v }),
      (res) => toast(`Done: ${title}`, "success", { action: { label: "Undo", onClick: () => void undoComplete(res) } }),
    );

  const snooze = async (mode: SnoozeMode, until: string | null) => {
    await run(
      (v) => api.taskAction(item.id, { action: "snooze", mode, until, version: v }),
      () => toast(until ? `Snoozed until ${formatDateLong(until, today)}` : "Snoozed until they reply", "success"),
    );
    setSnoozing(false);
  };

  return (
    <li ref={liRef} className={`trow${selectable?.selected ? " is-selected" : ""}${busy ? " is-busy" : ""}`}>
      {selectable ? (
        <label className="trow-check-hit">
          <input type="checkbox" className="trow-check" checked={selectable.selected} onChange={selectable.onToggle} aria-label={`Select: ${title}`} />
        </label>
      ) : null}
      <div className="trow-body">
        <div className="trow-top">
          {item.company ? <CompanyAvatar name={item.company} /> : <PersonAvatar name={who ?? "?"} size="md" />}
          <div className="trow-heading">
            <div className="trow-head">
              <span className="trow-who">
                {item.important ? (
                  <span className="trow-star" title="Important (What matters to me)">
                    <Star size={13} aria-hidden="true" />
                    <span className="sr-only">Important: </span>
                  </span>
                ) : null}
                {who ?? "No contact"}
              </span>
              {time ? (
                <span className={`trow-time tone-${time.tone}`} title={time.title}>
                  <span className="led" aria-hidden="true" />
                  {time.text}
                </span>
              ) : null}
            </div>
            <a className="trow-title" href={href} data-row-link data-id={item.id}>
              {title}
            </a>
          </div>
        </div>
        {showQuote && item.evidence ? <Quote evidence={item.evidence} zone={zone} today={today} /> : null}
        {item.needsReview || item.pendingSuggestions > 0 || item.priority === "URGENT" || owner ? (
          <p className="trow-flags">
            {owner ? <span className="flag">{owner}</span> : null}
            {item.priority === "URGENT" ? <span className="flag flag-urgent">Urgent</span> : null}
            {item.pendingSuggestions > 0 ? (
              <span className="flag flag-ask">
                <span className="led led-ai" aria-hidden="true" />
                The AI has a question
              </span>
            ) : item.needsReview ? (
              <span className="flag flag-ask">
                <span className="led led-ai" aria-hidden="true" />
                Needs a look
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      {next || open ? (
        <div className="trow-foot">
          {next ? (
            <p className="trow-next">
              <CornerDownRight size={15} aria-hidden="true" />
              <span>{next}</span>
            </p>
          ) : (
            <span />
          )}
          {open ? (
            <div className="trow-actions">
              {/* aria-disabled, not disabled: a disabled button drops the keyboard focus it holds. */}
              <button type="button" className="btn btn-quiet" aria-disabled={busy || undefined} onClick={() => void complete()}>
                <Check size={15} aria-hidden="true" />
                Done
              </button>
              <button type="button" className="btn btn-quiet" aria-disabled={busy || undefined} onClick={() => !busy && setSnoozing(true)}>
                <Clock size={15} aria-hidden="true" />
                Snooze
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {snoozing ? (
        <SnoozeDialog
          today={today}
          title={`Snooze: ${title}`}
          allowUntilReply={item.status === "WAITING_FOR_OTHER"}
          busy={busy}
          onConfirm={(m, u) => void snooze(m, u)}
          onClose={() => setSnoozing(false)}
        />
      ) : null}
    </li>
  );
}
