import { useCallback } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type PendingGesture, type Rect } from "@/store/useUI";
import { gestureOpensWindow } from "@/lib/draft";

export interface StartGestureOptions {
  /** Rect of the passage the gesture came from, so a window lands beside it. */
  near?: Rect;
  /** Seed text for the composer that receives the gesture. */
  seed?: string;
  /** Set when the gesture was started inside a branch window. */
  windowId?: string;
}

/**
 * Where a started gesture goes. The single routing point.
 *
 * A gesture that forks opens a window of its own; a gesture that continues the
 * path you are reading docks into the composer of the surface you read it in.
 * `gestureOpensWindow()` decides, and it decides from `plan.forks` — so the
 * question "does this open a window" has exactly one answer, derived from the
 * same mapping that decides what gets sent. The selection toolbar and the crop
 * rail both come through here and neither knows the rule.
 */
export function useStartGesture(): (
  gesture: PendingGesture,
  opts?: StartGestureOptions,
) => void {
  const conversationId = useStore((s) => s.conversationId);
  const openBranchWindow = useUI((s) => s.openBranchWindow);
  const setBranchWindowPending = useUI((s) => s.setBranchWindowPending);
  const setPending = useUI((s) => s.setPending);
  const setSelection = useUI((s) => s.setSelection);
  const focusComposer = useUI((s) => s.focusComposer);

  return useCallback(
    (gesture, opts = {}) => {
      if (gestureOpensWindow(gesture)) {
        if (!conversationId) return;
        openBranchWindow({
          gesture,
          conversationId,
          ...(opts.near ? { near: opts.near } : {}),
          ...(opts.seed ? { seed: opts.seed } : {}),
        });
        return;
      }
      if (opts.windowId) {
        setBranchWindowPending(opts.windowId, gesture);
        return;
      }
      setPending(gesture);
      setSelection(null);
      focusComposer();
    },
    [
      conversationId,
      openBranchWindow,
      setBranchWindowPending,
      setPending,
      setSelection,
      focusComposer,
    ],
  );
}
