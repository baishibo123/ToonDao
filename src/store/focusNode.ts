import type { NodeId } from "@/types";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { buildOutline, spineLeaf, threadOf } from "@/lib/outline";

/**
 * Show me this node. The single answer to "which window does a node belong to".
 *
 * The invariant this enforces is that **a window is one linear spine**. The main
 * chat box is the spine that starts at the root; every departure from it is a
 * spine of its own, shown only in its own window. So navigating — from the
 * sidebar, from the tree, from a branch marker in the transcript, from a sibling
 * switch — can never splice one spine into another. It either moves the main
 * window's cursor or it opens (or fronts) the window that owns the node.
 *
 * Landing rule: go to the *end* of the spine the node sits on, then scroll the
 * node itself into view. The thread stays whole, the composer stays attached
 * where the next message belongs, and you still arrive at what you clicked. One
 * exception falls out for free: landing on one variant of a retried turn ends
 * the spine there, because the turns below hang off the other variant — which is
 * what switching a variant means in any chat client.
 *
 * A plain function rather than a hook, because the global shortcut handler needs
 * it too and it reads nothing it cannot read from `getState()`.
 */
export function focusNode(nodeId: NodeId): void {
  const { nodes, conversationId, preferredChild, setActiveNode } = useStore.getState();
  const { openNodeWindow, requestScrollTo } = useUI.getState();
  if (!nodes[nodeId] || !conversationId) return;

  const outline = buildOutline(nodes, conversationId);
  const thread = threadOf(outline, nodeId);
  const leaf = spineLeaf(nodes, nodeId, preferredChild);

  // The root spine is what the main chat box shows, so it moves its cursor.
  if (!thread || thread.depth === 0) {
    setActiveNode(leaf);
    requestScrollTo(nodeId);
    return;
  }

  const head = nodes[thread.headNodeId];
  if (!head?.parentId) return;
  openNodeWindow({
    conversationId,
    sourceNodeId: head.parentId,
    rootNodeId: thread.headNodeId,
    activeNodeId: leaf,
  });
  requestScrollTo(nodeId);
}
