import { useUI } from "@/store/useUI";
import { SHORTCUTS } from "@/hooks/useShortcuts";

export function Shortcuts() {
  const open = useUI((s) => s.shortcutsOpen);
  const setOpen = useUI((s) => s.setShortcutsOpen);
  if (!open) return null;

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="modal__panel modal__panel--narrow">
        <header className="modal__head">
          <h2 className="modal__title">Keyboard</h2>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal__body">
          <dl className="keys">
            {SHORTCUTS.map((shortcut) => (
              <div className="keys__row" key={shortcut.keys}>
                <dt>
                  {shortcut.keys.split(" ").map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dt>
                <dd>{shortcut.label}</dd>
              </div>
            ))}
          </dl>
          <p className="field__hint">
            Combinations use Shift as well as Cmd/Ctrl on purpose — the
            unshifted ones belong to the browser.
          </p>
        </div>
      </div>
    </div>
  );
}
