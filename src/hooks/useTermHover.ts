import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { expandToTerm } from "@/lib/anchor";
import { pointInRects, rangeForAnchor } from "@/lib/selection";

const HIGHLIGHT_NAME = "toondao-term";

/**
 * §5.1: "individual noun phrases become lightly affordant (subtle underline on
 * hover only — do not pre-highlight the whole message, it makes the text
 * unreadable)".
 *
 * Uses the CSS Custom Highlight API, so the underline is painted without
 * touching the DOM React owns — no wrapper spans injected under React's feet,
 * and nothing to clean up if a re-render lands mid-hover. Where the API is
 * missing the affordance simply does not appear, which is the correct
 * degradation: the click still works.
 */
export function useTermHover(): void {
  useEffect(() => {
    const HighlightCtor = (window as { Highlight?: typeof Highlight }).Highlight;
    const registry = (CSS as { highlights?: HighlightRegistry }).highlights;
    if (!HighlightCtor || !registry) return;

    let frame = 0;
    let lastKey = "";

    const clear = () => {
      registry.delete(HIGHLIGHT_NAME);
      lastKey = "";
    };

    const onMove = (event: MouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = event.target as Element | null;
        const message = target?.closest?.("[data-node-id]");
        const root = message?.querySelector(".md");
        if (!message || !root || !root.contains(target as Node)) return clear();

        const nodeId = message.getAttribute("data-node-id");
        const node = nodeId ? useStore.getState().nodes[nodeId] : undefined;
        if (!node || node.role !== "assistant") return clear();

        const caret = caretRangeAt(event.clientX, event.clientY);
        if (!caret) return clear();

        const anchor = expandToTerm(caret, root, node.content);
        if (!anchor || anchor.end <= anchor.start) return clear();

        const range = rangeForAnchor(root, anchor);
        if (!range) return clear();
        // The caret snaps to the nearest text, so the pointer over blank space
        // would underline the word at that line's end. Only the word itself does.
        if (!pointInRects([...range.getClientRects()], { x: event.clientX, y: event.clientY })) return clear();

        const key = `${nodeId}:${anchor.start}:${anchor.end}`;
        if (key === lastKey) return;
        lastKey = key;
        registry.set(HIGHLIGHT_NAME, new HighlightCtor(range));
      });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", clear);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", clear);
      registry.delete(HIGHLIGHT_NAME);
    };
  }, []);
}

/** Chromium and WebKit disagree on the name; Firefox has neither. */
function caretRangeAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const range = document.createRange();
  try {
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
  } catch {
    return null;
  }
  return range;
}
