import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { TreeCanvas } from "@/components/tree/TreeCanvas";

/** Narrowest the tree canvas may be squeezed to before it stops being a map. */
export const MIN_GUTTER = 230;
/** Narrowest the thread may be squeezed to before it stops being readable. */
export const MIN_THREAD = 420;
/** Bottom strip the canvas keeps for its own controls and counts. */
const CHROME_BOTTOM = 44;

/**
 * The tree is not a window any more (§6).
 *
 * A floating panel with a title bar is a second application sitting on top of
 * the first: it has its own chrome to look past, it hides the thread it is
 * describing, and dragging it is a chore nobody asked for. The lineage and the
 * conversation are one artifact, so they now share one canvas — the thread
 * floats as a card on the left, the tree lives on the open ground beside it,
 * and the out-of-focus stretches of the tree drift behind the card's margins.
 *
 * The stage is full-bleed and sits *under* the thread. What it hands the canvas
 * is a viewport — the open ground to the right — so the tree fits and centres
 * itself in the part you can actually see while still being free to bleed.
 */
export function fitGutter(stored: number, stageWidth: number): number {
  if (stageWidth === 0) return stored;
  return Math.max(MIN_GUTTER, Math.min(stored, Math.max(MIN_GUTTER, stageWidth - MIN_THREAD)));
}

export function TreeStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const open = useUI((s) => s.treeOpen);
  const setTreeOpen = useUI((s) => s.setTreeOpen);
  const override = useUI((s) => s.treeGutter);
  const setTreeGutter = useUI((s) => s.setTreeGutter);
  const panel = useStore((s) => s.settings.treePanel);
  const updateSettings = useStore((s) => s.updateSettings);

  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [open]);

  const gutter = fitGutter(override ?? panel.width, size.width);

  // Publish the width the thread has to size itself around.
  useEffect(() => {
    setTreeGutter(gutter);
  }, [gutter, setTreeGutter]);

  const viewport = useMemo(
    () => ({
      x: Math.max(0, size.width - gutter),
      y: 0,
      width: gutter,
      height: Math.max(1, size.height - CHROME_BOTTOM),
    }),
    [size.width, size.height, gutter],
  );

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = gutter;
      let latest = startWidth;

      const move = (ev: PointerEvent) => {
        latest = fitGutter(startWidth - (ev.clientX - startX), size.width);
        setTreeGutter(latest);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        void updateSettings({ treePanel: { ...panel, width: latest } });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [gutter, panel, setTreeGutter, size.width, updateSettings],
  );

  // Escape gives the canvas back to the thread, but only while the tree has
  // focus — Escape inside the composer means something else entirely.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!stageRef.current?.contains(document.activeElement)) return;
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

  return (
    <div className="treestage" ref={stageRef}>
      <TreeCanvas width={size.width} height={size.height} viewport={viewport} />
      <span
        className="treestage__grip"
        style={{ right: gutter - 3 }}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the tree canvas"
      />
    </div>
  );
}
