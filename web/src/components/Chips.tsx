import { useState } from "react";
import type { Priority, TaskStatus } from "../../../src/domain/types.js";
import type { Chip } from "../format.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "../labels.js";

export function ToneChip({ chip }: { chip: Chip }) {
  return (
    <span className={`chip chip-${chip.tone}`} title={chip.title}>
      {chip.text}
    </span>
  );
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return <span className={`pill pill-status pill-${status.toLowerCase().replace(/_/g, "-")}`}>{STATUS_LABELS[status]}</span>;
}

/** Shown only when it carries information (urgent/high/low), unless `always`. */
export function PriorityPill({ priority, always }: { priority: Priority; always?: boolean }) {
  if (!always && priority === "NORMAL") return null;
  return <span className={`pill pill-priority pill-${priority.toLowerCase()}`}>{PRIORITY_LABELS[priority]}</span>;
}

export function ReviewBadge() {
  return (
    <span className="chip chip-review" title="The AI wasn't sure — check it">
      <span aria-hidden="true">⚠️ </span>To check
    </span>
  );
}

/** Copies text to the clipboard, with a textarea fallback for older browsers / insecure origins. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.className = "offscreen";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
    }
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" className="btn btn-small" onClick={() => void copy()}>
      <span aria-live="polite">{copied ? "Copied ✓" : label}</span>
    </button>
  );
}
