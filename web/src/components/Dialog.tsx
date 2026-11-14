import { useEffect, useId, useRef, type ReactNode } from "react";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons row; rendered at the bottom. */
  footer?: ReactNode;
  wide?: boolean;
}

/**
 * Modal built on the native <dialog>: focus trap, Esc and inert background come from the browser.
 * The parent controls visibility by mounting/unmounting it. Keystrokes stay inside: a dialog rendered within a
 * list row must not feed the list's arrow/Escape shortcuts (stopPropagation keeps the native defaults — radio
 * arrows, date fields, Esc → cancel).
 */
export function Dialog({ title, onClose, children, footer, wide }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
      opener?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? "dialog dialog-wide" : "dialog"}
      aria-labelledby={titleId}
      onKeyDown={(e) => e.stopPropagation()}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div className="dialog-body">
        <h2 id={titleId} className="dialog-title">
          {title}
        </h2>
        {children}
      </div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger, busy, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={danger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Please wait…" : confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Dialog>
  );
}
