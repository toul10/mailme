import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type ToastKind = "info" | "success" | "error";

/** One button in the toast, e.g. “Undo” after “Done”. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

type ShowToast = (text: string, kind?: ToastKind, opts?: { action?: ToastAction }) => void;

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
  action: ToastAction | null;
}

const ToastContext = createContext<ShowToast>(() => undefined);

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

const LIFETIME_MS: Record<ToastKind, number> = { info: 5000, success: 3500, error: 8000 };
/** A toast with an undo stays long enough to reach it. */
const ACTION_LIFETIME_MS = 8000;

/** Short notices in a polite live region; errors and undoable actions stay longer. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback<ShowToast>(
    (text, kind = "info", opts) => {
      const id = nextId.current++;
      const action = opts?.action ?? null;
      setToasts((ts) => [...ts.filter((t) => t.text !== text).slice(-3), { id, text, kind, action }]);
      timers.current.set(id, window.setTimeout(() => dismiss(id), action ? ACTION_LIFETIME_MS : LIFETIME_MS[kind]));
    },
    [dismiss],
  );

  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const t of all.values()) window.clearTimeout(t);
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.text}</span>
            {t.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.onClick();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button type="button" className="toast-close" aria-label="Close notification" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
