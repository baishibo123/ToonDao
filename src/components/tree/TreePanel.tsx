import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { TreeCanvas } from "@/components/tree/TreeCanvas";
import { EdgeLegend } from "@/components/tree/edges";

const MIN_WIDTH = 300;
const MIN_HEIGHT = 220;
const HEADER_HEIGHT = 34;

/**
 * The floating overlay panel (§6). Explicitly *not* a fixed rail of dots pinned
 * to the scroll container — that pattern is a scroll indicator wearing a tree
 * costume, and it cannot represent a fork at all.
 *
 * Draggable, resizable, collapsible to a handle, and it remembers where it was.
 * Position is persisted in settings so it survives a reload; it is written on
 * pointer-up rather than on every frame of a drag.
 */
export function TreePanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const open = useUI((s) => s.treeOpen);
  const setTreeOpen = useUI((s) => s.setTreeOpen);
  const stored = useStore((s) => s.settings.treePanel);
  const updateSettings = useStore((s) => s.updateSettings);

  const [rect, setRect] = useState<{
    x: number | null;
    y: number | null;
    width: number;
    height: number;
  }>(() => normalize(stored));
  const [collapsed, setCollapsed] = useState(stored.collapsed);
  const [legend, setLegend] = useState(false);
  const [canvas, setCanvas] = useState({ width: 0, height: 0 });

  // Adopt persisted geometry once it has loaded from IndexedDB.
  useEffect(() => {
    setRect(normalize(stored));
    setCollapsed(stored.collapsed);
  }, [stored]);

  const persist = useCallback(
    (
      next: { x: number | null; y: number | null; width: number; height: number },
      isCollapsed: boolean,
    ) => {
      void updateSettings({ treePanel: { ...next, collapsed: isCollapsed } });
    },
    [updateSettings],
  );

  // Keep the panel on screen when the window shrinks under it.
  useEffect(() => {
    const clampToViewport = () => {
      setRect((r) =>
        r.x === null || r.y === null
          ? r
          : {
              ...r,
              x: Math.max(8 - r.width + 60, Math.min(r.x, window.innerWidth - 60)),
              y: Math.max(8, Math.min(r.y, window.innerHeight - HEADER_HEIGHT - 8)),
            },
      );
    };
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || collapsed) return;
    const observer = new ResizeObserver(() => {
      setCanvas({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    setCanvas({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, [collapsed, legend]);

  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button")) return;
    e.preventDefault();
    const box = panelRef.current?.getBoundingClientRect();
    const start = {
      px: e.clientX,
      py: e.clientY,
      x: rect.x ?? box?.left ?? 0,
      y: rect.y ?? box?.top ?? 0,
    };
    let latest = { ...rect, x: start.x, y: start.y };
    const move = (ev: PointerEvent) => {
      latest = {
        ...rect,
        x: start.x + (ev.clientX - start.px),
        y: Math.max(8, start.y + (ev.clientY - start.py)),
      };
      setRect(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persist(latest, collapsed);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: React.PointerEvent, corner: "sw" | "se") => {
    e.preventDefault();
    e.stopPropagation();
    const box = panelRef.current?.getBoundingClientRect();
    const start = {
      px: e.clientX,
      py: e.clientY,
      x: rect.x ?? box?.left ?? 0,
      y: rect.y ?? box?.top ?? 0,
      width: rect.width,
      height: rect.height,
    };
    let latest = { ...rect, x: start.x, y: start.y };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.px;
      const dy = ev.clientY - start.py;
      if (corner === "se") {
        latest = {
          ...start,
          width: Math.max(MIN_WIDTH, start.width + dx),
          height: Math.max(MIN_HEIGHT, start.height + dy),
        };
      } else {
        const width = Math.max(MIN_WIDTH, start.width - dx);
        latest = {
          ...start,
          x: start.x + (start.width - width),
          width,
          height: Math.max(MIN_HEIGHT, start.height + dy),
        };
      }
      setRect(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persist(latest, collapsed);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!panelRef.current?.contains(document.activeElement)) return;
      setTreeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setTreeOpen]);

  if (!open) {
    return (
      <button
        type="button"
        className="treehandle"
        onClick={() => setTreeOpen(true)}
        title="Show conversation tree"
      >
        <span aria-hidden>⑃</span> tree
      </button>
    );
  }

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    persist(rect, next);
  };

  return (
    <div
      ref={panelRef}
      className={`treepanel${collapsed ? " treepanel--collapsed" : ""}`}
      style={{
        ...(rect.x === null
          ? { right: 24 }
          : { left: rect.x }),
        ...(rect.y === null ? { top: 56 } : { top: rect.y }),
        width: rect.width,
        height: collapsed ? HEADER_HEIGHT : rect.height,
      }}
      role="dialog"
      aria-label="Conversation tree"
    >
      <div className="treepanel__head" onPointerDown={startDrag}>
        <span className="treepanel__grip" aria-hidden>
          ⠿
        </span>
        <span className="treepanel__title">Lineage</span>
        <span className="treepanel__spacer" />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setLegend((v) => !v)}
          aria-pressed={legend}
          title="Edge types"
        >
          ?
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={toggleCollapsed}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▢" : "—"}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setTreeOpen(false)}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>

      {collapsed ? null : (
        <div className="treepanel__body" ref={bodyRef}>
          {legend ? <EdgeLegend onClose={() => setLegend(false)} /> : null}
          <TreeCanvas width={canvas.width} height={canvas.height} />
        </div>
      )}

      {collapsed ? null : (
        <>
          <span
            className="treepanel__resize treepanel__resize--se"
            onPointerDown={(e) => startResize(e, "se")}
            aria-hidden
          />
          <span
            className="treepanel__resize treepanel__resize--sw"
            onPointerDown={(e) => startResize(e, "sw")}
            aria-hidden
          />
        </>
      )}
    </div>
  );
}

/**
 * An unmoved panel keeps x/y null and is placed by CSS in the right-hand
 * gutter, so nothing depends on reading the viewport before it has laid out.
 */
function normalize(stored: {
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  collapsed: boolean;
}) {
  return {
    x: stored.x,
    y: stored.y,
    width: Math.max(MIN_WIDTH, stored.width || 440),
    height: Math.max(MIN_HEIGHT, stored.height || 520),
  };
}
