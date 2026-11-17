import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export interface RowMenuRequest {
  /** Where the pointer was, or the row's corner when opened from the keyboard. */
  x: number;
  y: number;
  items: RowMenuItem[];
  /** Given focus back when the menu closes without moving it elsewhere. */
  returnTo: HTMLElement | null;
}

/**
 * Where a context menu opens: the pointer, or — opened with the menu key or
 * Shift-F10, which report no pointer — the row's own lower left.
 */
export function menuPoint(event: React.MouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left + 16, y: box.bottom };
}

/**
 * A sidebar row's right-click menu. Measured before it is placed, so it opens
 * at the pointer and stays inside the window; closed by Escape, a press
 * anywhere else, a scroll or the window losing focus.
 */
export function RowMenu({ request, onClose }: { request: RowMenuRequest; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const margin = 6;
    const left = Math.max(margin, Math.min(request.x, window.innerWidth - el.offsetWidth - margin));
    const below = request.y + el.offsetHeight + margin <= window.innerHeight;
    const top = below ? request.y : Math.max(margin, request.y - el.offsetHeight);
    setPos({ top, left });
    el.querySelector<HTMLButtonElement>("button")?.focus();
  }, [request]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    const close = () => {
      onClose();
      request.returnTo?.focus();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose, request]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      className="rowmenu"
      role="menu"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {request.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`rowmenu__item${item.danger ? " rowmenu__item--danger" : ""}`}
          onClick={() => {
            onClose();
            request.returnTo?.focus();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
