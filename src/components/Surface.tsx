import { createContext, useContext } from "react";

/**
 * Which surface a message, composer or gesture belongs to.
 *
 * The same node can be on screen twice — once in the main thread and once in a
 * branch window — and the two must behave differently: a retry inside a window
 * must not move the main thread's cursor, and a quote reply started inside a
 * window must dock into that window's composer. Rather than thread a `windowId`
 * prop through the transcript into every message, the window provides it once
 * and the components that care ask for it.
 *
 * Absent means the main thread. That is the default on purpose: a component
 * rendered outside any window behaves exactly as it did before windows existed.
 */
export interface Surface {
  /** Set inside a branch window. */
  windowId?: string;
}

const SurfaceContext = createContext<Surface>({});

export const SurfaceProvider = SurfaceContext.Provider;

export function useSurface(): Surface {
  return useContext(SurfaceContext);
}

/** DOM id for a message, scoped so two surfaces showing one node do not clash. */
export function messageDomId(nodeId: string, windowId?: string): string {
  return windowId ? `msg-${windowId}-${nodeId}` : `msg-${nodeId}`;
}
