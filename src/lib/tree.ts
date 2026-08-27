import type { ConversationNode, NodeId } from "@/types";

export type NodeMap = Record<NodeId, ConversationNode>;

/** Root → node, following parentId. Graph A, always complete — this is what
 *  the transcript renders, and it never consults contextPolicy. */
export function pathToRoot(nodes: NodeMap, id: NodeId | null): ConversationNode[] {
  const out: ConversationNode[] = [];
  const seen = new Set<NodeId>();
  let cursor = id;
  while (cursor) {
    const node = nodes[cursor];
    if (!node || seen.has(cursor)) break;
    seen.add(cursor);
    out.push(node);
    cursor = node.parentId;
  }
  return out.reverse();
}

export function childrenOf(nodes: NodeMap, id: NodeId): ConversationNode[] {
  const node = nodes[id];
  if (!node) return [];
  return node.childrenIds
    .map((childId) => nodes[childId])
    .filter((n): n is ConversationNode => Boolean(n))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function siblingsOf(nodes: NodeMap, id: NodeId): ConversationNode[] {
  const node = nodes[id];
  if (!node) return [];
  if (!node.parentId) {
    return Object.values(nodes)
      .filter((n) => n.parentId === null && n.conversationId === node.conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  return childrenOf(nodes, node.parentId);
}

export function rootsOf(nodes: NodeMap, conversationId: string): ConversationNode[] {
  return Object.values(nodes)
    .filter((n) => n.conversationId === conversationId && n.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Walk down to a leaf, taking the preferred child where one is remembered and
 * the most recent otherwise. Used whenever navigation lands on an interior node
 * and the transcript needs a full path to show.
 */
export function deepestLeaf(
  nodes: NodeMap,
  id: NodeId,
  preferred: Record<NodeId, NodeId> = {},
): NodeId {
  let cursor = id;
  const seen = new Set<NodeId>();
  for (;;) {
    if (seen.has(cursor)) return cursor;
    seen.add(cursor);
    const kids = childrenOf(nodes, cursor);
    if (kids.length === 0) return cursor;
    const want = preferred[cursor];
    const next = kids.find((k) => k.id === want) ?? kids[kids.length - 1];
    cursor = next.id;
  }
}

/** Every node reachable below `id`, inclusive. */
export function subtreeIds(nodes: NodeMap, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = [id];
  const seen = new Set<NodeId>();
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!nodes[current]) continue;
    out.push(current);
    stack.push(...nodes[current].childrenIds);
  }
  return out;
}

export function descendantCount(nodes: NodeMap, id: NodeId): number {
  return Math.max(0, subtreeIds(nodes, id).length - 1);
}

/** Turn number for display: 1-based index of user messages along the path. */
export function turnNumbers(path: ConversationNode[]): Map<NodeId, number> {
  const map = new Map<NodeId, number>();
  let turn = 0;
  for (const node of path) {
    if (node.role === "user") turn += 1;
    map.set(node.id, turn);
  }
  return map;
}
