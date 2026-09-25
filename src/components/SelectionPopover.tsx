import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type PendingGesture } from "@/store/useUI";
import { useStartGesture } from "@/hooks/useStartGesture";
import { BRANCH_META } from "@/lib/policyMeta";
import { estimateTokens, formatTokens } from "@/lib/tokens";

/**
 * The one floating toolbar behind §5.1, §5.3 and §5.4.
 *
 * A drag offers the range actions; a click additionally offers the term
 * actions, because a click has been expanded to a term (§5.1). No action sends
 * anything: each one *starts* a gesture, which either opens a window carrying
 * the branch's context or docks into the composer of the surface the passage
 * was read in. Either way the user sees §5.3's `1 message · isolated` chip
 * before committing, and all five interactions still leave through one submit
 * path.
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
   * Every action leaves through here. Whether it opens a window or docks into a
   * composer is `useStartGesture()`'s decision, not this toolbar's — the
   * toolbar's job is to say what the user pointed at and what they asked for.
   */
  const start = (gesture: PendingGesture, seed?: string) =>
    startGesture(gesture, {
      near: selection.rect,
      ...(seed ? { seed } : {}),
      ...(selection.windowId ? { windowId: selection.windowId } : {}),
    });

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
        <span className="selpop__meta">
          {anchor.end - anchor.start} chars · {formatTokens(estimateTokens(anchor.text))}
        </span>
      </div>

      <div className="selpop__actions">
        <Action
          kind="isolated-selection"
          label="Ask about only this"
          hint="§5.3 — zero ancestry. Opens a window; nothing but this text reaches the model."
          onClick={() =>
            start({ kind: "isolated", sourceNodeId: selection.nodeId, anchor })
          }
        />
        <Action
          kind="quote-reply"
          label="Reply to this"
          hint="§5.4 — continues the current path with the passage quoted. Stays in this composer."
          onClick={() => start({ kind: "quote", sourceNodeId: selection.nodeId, anchor })}
        />
        <Action
          kind="concept-lens"
          label="Explain in context"
          hint="§5.1 — opens a window carrying a narrow window of recent turns plus this concept."
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
          kind="concept-lens"
          label="Compare with…"
          hint="Same narrow window, seeded as a comparison."
          onClick={() =>
            start(
              {
                kind: "concept",
                sourceNodeId: selection.nodeId,
                anchor,
                turns: conceptLensTurns,
              },
              `Compare “${preview}” with `,
            )
          }
        />
        <Action
          kind="continuation"
          label="New line from here"
          hint="An ordinary turn off this message, keeping full ancestry up to it. Opens a window, because it is a second line of thought rather than the next thing you said."
          onClick={() => start({ kind: "fork", sourceNodeId: selection.nodeId })}
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
