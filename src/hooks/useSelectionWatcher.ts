import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { readSelection } from "@/lib/selection";

/**
 * One document-level listener that turns user selections into gesture
 * candidates. Lives at the app root rather than per message: a single listener
 * scales to a 200-node transcript, and the selection API is global anyway.
 *
 * A click inside an *assistant* message expands to a term (§5.1). A drag in any
 * message resolves to its range (§5.3, §5.4). Clicks in user messages do not
 * open the popover — a click there is almost always someone placing a caret to
 * read, and popping a toolbar over it is noise.
 */
export function useSelectionWatcher(): void {
  const setSelection = useUI((s) => s.setSelection);

  useEffect(() => {
    let frame = 0;

    const evaluate = (event: Event) => {
      cancelAnimationFrame(frame);
      // Let the browser settle the selection before reading it.
      frame = requestAnimationFrame(() => {
        const target = event.target as Element | null;
        if (target?.closest?.(".selpop, .composer, .modal, .treepanel")) return;

        const { nodes } = useStore.getState();
        const found = readSelection(nodes);
        if (!found) {
          setSelection(null);
          return;
        }
        if (found.fromClick && nodes[found.nodeId]?.role !== "assistant") {
          setSelection(null);
          return;
        }
        setSelection({ nodeId: found.nodeId, anchor: found.anchor, rect: found.rect });
      });
    };

    const onKeyUp = (event: KeyboardEvent) => {
      // Shift+arrow selection, and nothing else.
      if (!event.shiftKey) return;
      evaluate(event);
    };

    document.addEventListener("mouseup", evaluate);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mouseup", evaluate);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [setSelection]);
}
