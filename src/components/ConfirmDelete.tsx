import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * Asks before a conversation is deleted. Deleting takes every message and
 * aside with it and cannot be undone, and the ✕ sits right beside the row
 * you click to open it. Cancel has the focus, so Enter keeps the conversation;
 * Esc or a click outside cancels too.
 */
export function ConfirmDelete({
  title,
  onCancel,
  onConfirm,
}: {
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // On the body, not inside the sidebar's tree it was opened from.
  return createPortal(
    <div
      className="modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal__panel modal__panel--narrow">
        <header className="modal__head">
          <h2 className="modal__title" id="confirm-delete-title">
            Delete this conversation?
          </h2>
        </header>
        <div className="modal__body">
          <p className="pane__note">
            “{title}” and every message and aside in it will be deleted. This cannot be undone;
            Export it from Settings first if you may want it back.
          </p>
          <div className="pane__row confirm__actions">
            <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn--danger" onClick={onConfirm}>
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
