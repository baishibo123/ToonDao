import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { rangeForAnchor } from "@/lib/selection";

const HIGHLIGHT_NAME = "toondao-later";

/**
 * Marks parked passages where they sit in the text, so a reader coming back to
 * an answer sees what they deferred without opening the list.
 *
 * Uses the CSS Custom Highlight API, like the term hover: the mark is painted
 * over the text without touching the DOM React owns, so there are no wrapper
 * spans to inject and nothing to clean up if a re-render lands mid-paint. Where
 * the API is missing the mark simply does not appear; the list still works.
 *
 * Repainted whenever anything that could move or replace the text changes —
 * the nodes (streaming, deletes), the cursor (a different spine), and the asides
 * (a pane opening, or a frame being shown or hidden).
 */
export function useParkedMarks(): void {
  const later = useStore((s) => s.conversations.find((c) => c.id === s.conversationId)?.later);
  const nodes = useStore((s) => s.nodes);
  const activeNodeId = useStore((s) => s.activeNodeId);
  const asides = useUI((s) => s.asides);

  useEffect(() => {
    const HighlightCtor = (window as { Highlight?: typeof Highlight }).Highlight;
    const registry = (CSS as { highlights?: HighlightRegistry }).highlights;
    if (!HighlightCtor || !registry) return;

    // An effect runs after React has committed the text, which is all a Range
    // needs — no layout involved, so no need to wait for a frame (which a
    // background tab would never deliver).
    const ranges: Range[] = [];
    for (const item of later ?? []) {
      const roots = document.querySelectorAll(
        `[data-node-id="${CSS.escape(item.sourceNodeId)}"] .md`,
      );
      for (const root of roots) {
        const range = rangeForAnchor(root, item.anchor);
        if (range) ranges.push(range);
      }
    }
    if (ranges.length > 0) registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
    else registry.delete(HIGHLIGHT_NAME);
  }, [later, nodes, activeNodeId, asides]);

  useEffect(() => {
    return () => {
      (CSS as { highlights?: HighlightRegistry }).highlights?.delete(HIGHLIGHT_NAME);
    };
  }, []);
}
