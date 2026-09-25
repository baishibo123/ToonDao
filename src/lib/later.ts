import type { LaterItem, NodeId, TextAnchor } from "@/types";

/**
 * The Later list: passages the reader chose not to chase yet.
 *
 * Reading a hard answer throws up terms you do not know. Chasing each one the
 * moment it appears is how a reading session turns into a dozen open questions
 * and no finished thought; ignoring them is how they are lost. The middle move
 * is to park it — one click, the passage is marked where it sits, and the list
 * says what is still owed. Asking anything about a parked passage clears it, so
 * the list is a queue that drains, not a pile that only grows.
 *
 * Pure functions over the list; the store persists whatever these return.
 */

/** Adds a passage, unless that exact passage is already parked. */
export function parkPassage(
  items: readonly LaterItem[],
  item: LaterItem,
): LaterItem[] {
  if (findParked(items, item.sourceNodeId, item.anchor)) return [...items];
  return [...items, item];
}

/** The parked item for exactly this passage, if there is one. */
export function findParked(
  items: readonly LaterItem[],
  sourceNodeId: NodeId,
  anchor: Pick<TextAnchor, "start" | "end">,
): LaterItem | undefined {
  return items.find(
    (item) =>
      item.sourceNodeId === sourceNodeId &&
      item.anchor.start === anchor.start &&
      item.anchor.end === anchor.end,
  );
}

/** Drops every item whose message no longer exists. */
export function pruneParked(
  items: readonly LaterItem[],
  gone: ReadonlySet<NodeId>,
): LaterItem[] {
  return items.filter((item) => !gone.has(item.sourceNodeId));
}
