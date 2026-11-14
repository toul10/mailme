import { useState } from "react";
import { looksLikeEmail } from "../format.js";
import { normalizeAliases } from "../mailbox-form.js";

interface AliasEditorProps {
  value: string[];
  onChange: (aliases: string[]) => void;
  primary?: string;
}

/** Chips with remove buttons + an input that adds on Enter / “Add”. */
export function AliasEditor({ value, onChange, primary }: AliasEditorProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!v) return;
    if (!looksLikeEmail(v)) {
      setError("Invalid address.");
      return;
    }
    onChange(normalizeAliases([...value, v], primary));
    setDraft("");
    setError(null);
  };

  return (
    <div className="alias-editor">
      {value.length > 0 ? (
        <ul className="alias-list">
          {value.map((a) => (
            <li key={a} className="chip chip-quiet">
              {a}
              <button type="button" className="chip-action" aria-label={`Remove ${a}`} onClick={() => onChange(value.filter((x) => x !== a))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="inline">
        <input
          type="email"
          value={draft}
          aria-label="New alias"
          placeholder="e.g. sales@example.com"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn btn-small" onClick={add}>
          Add
        </button>
      </div>
      {error ? <p className="hint hint-error">{error}</p> : null}
    </div>
  );
}
