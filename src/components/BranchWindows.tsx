import { useEffect } from "react";
import { useUI } from "@/store/useUI";
import { useStore } from "@/store/useStore";
import { BranchWindow } from "@/components/BranchWindow";

/**
 * The layer branch windows live on. One stacking context of its own, so raising
 * a window past its siblings can never raise it past the selection toolbar or a
 * modal — the layer's own z-index decides that once, in CSS.
 *
 * Windows are filtered to the open conversation: switching conversations empties
 * the node map, so a window from the other one would have nothing to show.
 */
export function BranchWindows() {
  const conversationId = useStore((s) => s.conversationId);
  const windows = useUI((s) => s.windows);
  const clamp = useUI((s) => s.clampWindowsToViewport);

  useEffect(() => {
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [clamp]);

  const open = windows.filter((w) => w.conversationId === conversationId);
  if (open.length === 0) return null;

  return (
    <div className="winlayer">
      {open.map((win) => (
        <BranchWindow key={win.id} win={win} />
      ))}
    </div>
  );
}
