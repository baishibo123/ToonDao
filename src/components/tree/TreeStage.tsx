import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUI } from "@/store/useUI";
import { TreeCanvas } from "@/components/tree/TreeCanvas";

/**
 * Where the tree lives (§6).
 *
 * Not a window, and no longer a column either. The stage covers the whole page
 * and sits *over* the thread, because a tree is mostly whitespace and reserving
 * a rectangle for its bounding box spends far more room than it uses. It takes
 * no pointer events itself — only the dots do — so everything underneath stays
 * live: selecting a passage, hitting send, scrolling the transcript.
 */
export function TreeStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const open = useUI((s) => s.treeOpen);
  const setTreeOpen = useUI((s) => s.setTreeOpen);
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

  // Escape gives the page back, but only while the tree has focus — Escape
  // inside the composer means something else entirely.
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
      <TreeCanvas width={size.width} height={size.height} />
    </div>
  );
}
