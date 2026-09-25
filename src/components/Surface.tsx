import { createContext, useContext } from "react";

/**
 * Which surface a message, composer or gesture belongs to: the thread, or one
 * aside.
 *
 * The two must behave differently: a retry inside an aside must not move the
 * thread's cursor, and a quote reply started inside an aside must dock into that
 * aside's composer. Rather than thread an `asideId` prop through the transcript
 * into every message, the aside provides it once and the components that care
 * ask for it.
 *
 * Absent means the thread. That is the default on purpose: a component rendered
 * outside any aside behaves exactly as the ordinary chat does.
 */
export interface Surface {
  /** Set inside an aside. */
  asideId?: string;
}

const SurfaceContext = createContext<Surface>({});

export const SurfaceProvider = SurfaceContext.Provider;

export function useSurface(): Surface {
  return useContext(SurfaceContext);
}

/** DOM id for a message, scoped so two surfaces showing one node do not clash. */
export function messageDomId(nodeId: string, asideId?: string): string {
  return asideId ? `msg-${asideId}-${nodeId}` : `msg-${nodeId}`;
}
