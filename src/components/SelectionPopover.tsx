import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type PendingGesture } from "@/store/useUI";
import { useStartGesture } from "@/hooks/useStartGesture";
import { BRANCH_META } from "@/lib/policyMeta";

/**
 * The toolbar that appears on a passage: what a reader does when the text gets
 * hard, named the way a reader would name it.
 *
 *   Explain    "wait — what's this?"    §5.1, opens an aside
 *   Reply      "about this —"           §5.4, stays in this conversation
 *   Just this  "take only this"         §5.3, opens an aside
 *
 * A click has been expanded to a term (§5.1) and a drag resolves to its range;
 * both offer the same moves, so the toolbar is learnt once. No action sends
 * anything: each *starts* a gesture, and the carried context is on screen before
 * the user commits.
 */
export function SelectionPopover() {
  const ref = useRef<HTMLDivElement>(null);
  const selection = useUI((s) => s.selection);
  const setSelection = useUI((s) => s.setSelection);
  const startGesture = useStartGesture();

  const nodes = useStore((s) => s.nodes);
  const conceptLensTurns = useStore((s) => s.settings.conceptLensTurns);

  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(
    (rect: { top: number; bottom: number; left: number; right: number }) => {
      const el = ref.current;
      const width = el?.offsetWidth || 250;
      const height = el?.offsetHeight || 40;
      const gap = 8;
      const centre = (rect.left + rect.right) / 2;
      const left = Math.max(
        10,
        Math.min(centre - width / 2, window.innerWidth - width - 10),
      );
      const above = rect.top - height - gap;
      const top = above < 10 ? Math.min(rect.bottom + gap, window.innerHeight - height - 10) : above;
      setPos({ top, left });
    },
    [],
  );

  useLayoutEffect(() => {
    if (!selection) {
      setPos(null);
      return;
    }
    place(selection.rect);
  }, [selection, place]);

  // The toolbar is position: fixed over a scrolling transcript, so it has to
  // follow the text rather than sit where the text used to be. Recomputed from
  // the live selection: if that has gone, so has the reason for the toolbar.
  useEffect(() => {
    if (!selection) return;
    const reposition = () => {
      const live = window.getSelection();
      if (!live || live.rangeCount === 0) return;
      const rect = live.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setSelection(null);
        return;
      }
      place(rect);
    };
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, { capture: true });
      window.removeEventListener("resize", reposition);
    };
  }, [selection, place, setSelection]);

  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, setSelection]);

  const sourceNode = selection ? nodes[selection.nodeId] : undefined;
  const preview = useMemo(
    () => (selection ? selection.anchor.text.replace(/\s+/g, " ").trim() : ""),
    [selection],
  );

  if (!selection || !sourceNode || !pos) return null;

  const anchor = selection.anchor;
  /**
   * Every action leaves through here. Whether it opens an aside or docks into a
   * composer is `useStartGesture()`'s decision, not this toolbar's — the
   * toolbar's job is to say what the user pointed at and what they asked for.
   */
  const start = (gesture: PendingGesture) =>
    startGesture(gesture, selection.asideId ? { asideId: selection.asideId } : {});

  return (
    <div
      ref={ref}
      className="selpop"
      style={{ top: pos.top, left: pos.left }}
      role="toolbar"
      aria-label="Selection actions"
      // Keep mousedown from clearing the very selection these actions act on.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="selpop__preview" title={anchor.text}>
        <span className="selpop__quote">“{truncate(preview, 46)}”</span>
      </div>

      <div className="selpop__actions">
        <Action
          kind="concept-lens"
          label="Explain"
          hint="What does this mean? Asked beside the thread, carrying only the last few turns."
          onClick={() =>
            start({
              kind: "concept",
              sourceNodeId: selection.nodeId,
              anchor,
              turns: conceptLensTurns,
            })
          }
        />
        <Action
          kind="quote-reply"
          label="Reply"
          hint="Reply to this passage, here in the conversation. It is quoted above what you type."
          onClick={() => start({ kind: "quote", sourceNodeId: selection.nodeId, anchor })}
        />
        <Action
          kind="isolated-selection"
          label="Just this"
          hint="Ask about this passage on its own, beside the thread. Nothing else is sent."
          onClick={() =>
            start({ kind: "isolated", sourceNodeId: selection.nodeId, anchor })
          }
        />
      </div>
    </div>
  );
}

function Action({
  kind,
  label,
  hint,
  onClick,
}: {
  kind: keyof typeof BRANCH_META;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  const meta = BRANCH_META[kind];
  return (
    <button
      type="button"
      className="selpop__action"
      title={hint}
      onClick={onClick}
      style={{ ["--kind" as string]: `var(${meta.cssVar})` }}
    >
      <span className="selpop__glyph" aria-hidden>
        {meta.glyph}
      </span>
      {label}
    </button>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
