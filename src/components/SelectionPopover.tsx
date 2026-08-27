import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { BRANCH_META } from "@/lib/policyMeta";
import { estimateTokens, formatTokens } from "@/lib/tokens";

/**
 * The one floating toolbar behind §5.1, §5.3 and §5.4.
 *
 * A drag offers the range actions; a click additionally offers the term
 * actions, because a click has been expanded to a term (§5.1). Every action
 * docks a pending gesture into the composer rather than sending immediately —
 * that is what puts §5.3's `1 message · isolated` chip in front of the user
 * before they commit, and it means all five interactions leave through one
 * submit path.
 */
export function SelectionPopover() {
  const ref = useRef<HTMLDivElement>(null);
  const selection = useUI((s) => s.selection);
  const setSelection = useUI((s) => s.setSelection);
  const setPending = useUI((s) => s.setPending);
  const focusComposer = useUI((s) => s.focusComposer);

  const nodes = useStore((s) => s.nodes);
  const setActiveLeafFrom = useStore((s) => s.setActiveLeafFrom);
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
  const dock = (gesture: Parameters<typeof setPending>[0]) => {
    setPending(gesture);
    focusComposer();
  };

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
          hint="§5.3 — zero ancestry. Nothing but this text reaches the model."
          onClick={() =>
            dock({ kind: "isolated", sourceNodeId: selection.nodeId, anchor })
          }
        />
        <Action
          kind="quote-reply"
          label="Reply to this"
          hint="§5.4 — continues the current path with the passage quoted."
          onClick={() => dock({ kind: "quote", sourceNodeId: selection.nodeId, anchor })}
        />
        <Action
          kind="concept-lens"
          label="Explain in context"
          hint="§5.1 — a narrow window of recent turns plus this concept."
          onClick={() =>
            dock({
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
          onClick={() => {
            useUI.getState().setComposerSeed(`Compare “${preview}” with `);
            dock({
              kind: "concept",
              sourceNodeId: selection.nodeId,
              anchor,
              turns: conceptLensTurns,
            });
          }}
        />
        <Action
          kind="continuation"
          label="Branch from here"
          hint="Fork an ordinary turn off this message, keeping full ancestry."
          onClick={() => {
            setActiveLeafFrom(selection.nodeId);
            useStore.getState().setActiveNode(selection.nodeId);
            setSelection(null);
            focusComposer();
          }}
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
