import { useState } from "react";
import type { SnoozeMode } from "../../../src/domain/types.js";
import { addDays, formatDateLong, isIsoDate, nextMonday, nextWeekday } from "../format.js";
import { Dialog } from "./Dialog.js";

interface SnoozeDialogProps {
  today: string;
  /** e.g. “Snooze: Quote for 40 speakers” or “Snooze 3 tasks”. */
  title: string;
  /**
   * Offer “until they reply” — only for tasks that wait on someone (WAITING_FOR_OTHER): for anything else nobody
   * is expected to reply, and the task would stay hidden indefinitely.
   */
  allowUntilReply: boolean;
  busy?: boolean;
  onConfirm: (mode: SnoozeMode, until: string | null) => void;
  onClose: () => void;
}

/** Snooze until a date (quick picks + date input) or until the other side replies. */
export function SnoozeDialog({ today, title, allowUntilReply, busy, onConfirm, onClose }: SnoozeDialogProps) {
  const [mode, setMode] = useState<SnoozeMode>("until_date");
  const [date, setDate] = useState(() => nextWeekday(today));
  const min = addDays(today, 1);
  const validDate = isIsoDate(date) && date >= min;
  const quick: Array<{ label: string; value: string }> = [
    { label: "Tomorrow", value: addDays(today, 1) },
    { label: "Next business day", value: nextWeekday(today) },
    { label: "Monday", value: nextMonday(today) },
    { label: "In a week", value: addDays(today, 7) },
  ];

  const submit = () => {
    if (mode === "until_reply") onConfirm("until_reply", null);
    else if (validDate) onConfirm("until_date", date);
  };

  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || (mode === "until_date" && !validDate)}>
            {busy ? "Please wait…" : "Snooze"}
          </button>
        </>
      }
    >
      <fieldset className="radio-group">
        <legend className="sr-only">Snooze type</legend>
        <label className="radio">
          <input type="radio" name="snooze-mode" checked={mode === "until_date"} onChange={() => setMode("until_date")} />
          <span>Until a date</span>
        </label>
        {mode === "until_date" ? (
          <div className="snooze-date">
            <div className="quick-picks" role="group" aria-label="Quick picks">
              {quick.map((q) => (
                <button key={q.label} type="button" className={q.value === date ? "btn btn-small is-active" : "btn btn-small"} aria-pressed={q.value === date} onClick={() => setDate(q.value)}>
                  {q.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span className="field-label">Date</span>
              <input type="date" value={date} min={min} onChange={(e) => setDate(e.target.value)} required />
            </label>
            {validDate ? <p className="hint">It will come back on {formatDateLong(date, today)}.</p> : <p className="hint hint-error">Pick a date from tomorrow on.</p>}
          </div>
        ) : null}
        {allowUntilReply ? (
          <label className="radio">
            <input type="radio" name="snooze-mode" checked={mode === "until_reply"} onChange={() => setMode("until_reply")} />
            <span>Until they reply</span>
          </label>
        ) : null}
      </fieldset>
    </Dialog>
  );
}
