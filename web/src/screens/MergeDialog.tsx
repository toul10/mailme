/** Merge: search for the other task, choose which one survives, confirm. */
import { useEffect, useId, useState } from "react";
import type { TaskDetail, TaskListItem } from "../../../src/server/api-types.js";
import { errorMessage, isApiError, isConflict } from "../api.js";
import { api } from "../client.js";
import { StatusPill } from "../components/Chips.js";
import { Dialog } from "../components/Dialog.js";
import { useDebounced } from "../hooks.js";

interface MergeDialogProps {
  task: TaskDetail;
  onClose: () => void;
  onMerged: (survivor: TaskDetail) => void;
  onConflict: () => void;
}

export function MergeDialog({ task, onClose, onMerged, onConflict }: MergeDialogProps) {
  const [q, setQ] = useState(task.company ?? "");
  const query = useDebounced(q, 300);
  const [results, setResults] = useState<TaskListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [other, setOther] = useState<TaskListItem | null>(null);
  const [keepCurrent, setKeepCurrent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  useEffect(() => {
    let alive = true;
    setSearching(true);
    api
      .listTasks({ tab: "all", q: query, limit: 20 })
      .then((r) => {
        if (alive) setResults(r.items.filter((i) => i.id !== task.id));
      })
      .catch((err: unknown) => {
        if (alive && !(isApiError(err) && err.handled)) setError(errorMessage(err));
      })
      .finally(() => {
        if (alive) setSearching(false);
      });
    return () => {
      alive = false;
    };
  }, [query, task.id]);

  const submit = async () => {
    if (!other || busy) return;
    setBusy(true);
    setError(null);
    const survivorId = keepCurrent ? task.id : other.id;
    const mergedId = keepCurrent ? other.id : task.id;
    try {
      onMerged(await api.mergeTasks({ survivorId, mergedId }));
    } catch (err) {
      if (isConflict(err)) onConflict();
      else if (!(isApiError(err) && err.handled)) setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Merge #${task.ref} with another task`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!other || busy} onClick={() => void submit()}>
            {busy ? "Merging…" : "Merge"}
          </button>
        </>
      }
    >
      {!other ? (
        <div className="stack">
          <label className="field">
            <span className="field-label">Search for a task</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-controls={listId} placeholder="Title, company, contact…" />
          </label>
          <ul className="pick-list" id={listId} aria-busy={searching}>
            {results.map((r) => (
              <li key={r.id}>
                <button type="button" className="pick" onClick={() => setOther(r)}>
                  <span className="ref">#{r.ref}</span>
                  <span className="pick-title">{r.title}</span>
                  <span className="pick-meta">
                    <StatusPill status={r.status} />
                    {r.company ? <span className="muted small">{r.company}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!searching && results.length === 0 ? <p className="muted">No tasks found.</p> : null}
        </div>
      ) : (
        <div className="stack">
          <p>
            You picked: <strong>#{other.ref}</strong> {other.title}{" "}
            <button type="button" className="link-button" onClick={() => setOther(null)}>
              change
            </button>
          </p>
          <fieldset className="radio-group">
            <legend className="field-label">Which one stays?</legend>
            <label className="radio">
              <input type="radio" name="merge-keep" checked={keepCurrent} onChange={() => setKeepCurrent(true)} />
              <span>
                This one (#{task.ref}) — #{other.ref} is merged into it
              </span>
            </label>
            <label className="radio">
              <input type="radio" name="merge-keep" checked={!keepCurrent} onChange={() => setKeepCurrent(false)} />
              <span>
                #{other.ref} — this one (#{task.ref}) is merged into that one
              </span>
            </label>
          </fieldset>
          <p className="muted small">Messages and history move to the task that stays.</p>
        </div>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
