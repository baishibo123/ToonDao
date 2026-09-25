import { useCallback } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type PendingGesture } from "@/store/useUI";
import { gestureOpensAside } from "@/lib/draft";

export interface StartGestureOptions {
  /** Set when the gesture was started inside an aside. */
  asideId?: string;
}

/**
 * Where a started gesture goes. The single routing point.
 *
 * A gesture that forks opens an aside; a gesture that continues the path you are
 * reading docks into the composer of the surface you read it in.
 * `gestureOpensAside()` decides, and it decides from `plan.forks` — so the
 * question "does this open an aside" has exactly one answer, derived from the
 * same mapping that decides what gets sent. The selection toolbar and the crop
 * rail both come through here and neither knows the rule.
 *
 * A fork started inside an aside opens a deeper one, keeping the aside it came
 * from as the breadcrumb back; a fork started in the thread starts a fresh stack.
 */
export function useStartGesture(): (
  gesture: PendingGesture,
  opts?: StartGestureOptions,
) => void {
  const conversationId = useStore((s) => s.conversationId);
  const openAside = useUI((s) => s.openAside);
  const setAsidePending = useUI((s) => s.setAsidePending);
  const setPending = useUI((s) => s.setPending);
  const setSelection = useUI((s) => s.setSelection);
  const focusComposer = useUI((s) => s.focusComposer);

  return useCallback(
    (gesture, opts = {}) => {
      if (gestureOpensAside(gesture)) {
        if (!conversationId) return;
        openAside({
          gesture,
          conversationId,
          ...(opts.asideId ? { from: opts.asideId } : {}),
        });
        return;
      }
      if (opts.asideId) {
        setAsidePending(opts.asideId, gesture);
        return;
      }
      setPending(gesture);
      setSelection(null);
      focusComposer();
    },
    [conversationId, openAside, setAsidePending, setPending, setSelection, focusComposer],
  );
}
