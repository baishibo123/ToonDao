import type { LaterItem, NodeId } from "@/types";
import { useStore } from "@/store/useStore";
import { useUI, type AsideTarget } from "@/store/useUI";
import { ancestorThreadIds, buildOutline, spineLeaf, threadOf } from "@/lib/outline";

/**
 * Show me this node. The single answer to "which pane does a node belong to".
 *
 * The invariant this enforces is that **a pane is one linear spine**. The thread
 * is the spine that starts at the root; every departure from it is a spine of
 * its own, shown only in the aside pane. So navigating — from the sidebar, from
 * a branch mark in the transcript, from a sibling switch — can never splice one
 * spine into another. It either moves the thread's cursor or it opens the aside
 * that owns the node, with the asides above it as the breadcrumb home.
 *
 * Landing rule: go to the *end* of the spine the node sits on, then scroll the
 * node itself into view. The conversation stays whole, the composer stays
 * attached where the next message belongs, and you still arrive at what you
 * clicked. One exception falls out for free: landing on one variant of a retried
 * turn ends the spine there, because the turns below hang off the other
 * variant — which is what switching a variant means in any chat client.
 *
 * A plain function rather than a hook, because the global shortcut handler needs
 * it too and it reads nothing it cannot read from `getState()`.
 */
export function focusNode(nodeId: NodeId): void {
  const { nodes, conversationId, preferredChild, setActiveNode } = useStore.getState();
  const { showAsides, requestScrollTo } = useUI.getState();
  if (!nodes[nodeId] || !conversationId) return;

  const outline = buildOutline(nodes, conversationId);
  const thread = threadOf(outline, nodeId);

  // The root spine is what the thread shows, so it moves the thread's cursor.
  if (!thread || thread.depth === 0) {
    setActiveNode(spineLeaf(nodes, nodeId, preferredChild));
    requestScrollTo(nodeId);
    return;
  }

  // Every aside between the thread and this one, outermost first, so the
  // breadcrumb reads as the way back.
  const chain: AsideTarget[] = [];
  for (const id of [...ancestorThreadIds(outline.threads, thread.id), thread.id]) {
    const t = outline.byId.get(id);
    const head = t ? nodes[t.headNodeId] : undefined;
    if (!t || t.depth === 0 || !head?.parentId) continue;
    chain.push({
      conversationId,
      sourceNodeId: head.parentId,
      rootNodeId: t.headNodeId,
      activeNodeId: spineLeaf(nodes, id === thread.id ? nodeId : t.headNodeId, preferredChild),
    });
  }
  if (chain.length === 0) return;
  showAsides(chain);
  requestScrollTo(nodeId);
}

/**
 * Explain a parked passage now: scroll to it where it sits, then open its lens
 * beside it. If the passage is inside an aside, the lens opens nested under
 * that aside, so the breadcrumb still leads home the way it came.
 *
 * The item stays on the list until something is actually sent about it —
 * opening it and changing your mind is not the same as having asked.
 */
export function explainParked(item: LaterItem): void {
  const { nodes, conversationId, settings } = useStore.getState();
  if (!conversationId || !nodes[item.sourceNodeId]) return;

  focusNode(item.sourceNodeId);
  const inAside =
    (threadOf(buildOutline(nodes, conversationId), item.sourceNodeId)?.depth ?? 0) > 0;
  const { asides, openAside } = useUI.getState();
  const host = inAside ? asides.at(-1)?.id : undefined;
  openAside({
    gesture: {
      kind: "concept",
      sourceNodeId: item.sourceNodeId,
      anchor: item.anchor,
      turns: settings.conceptLensTurns,
    },
    conversationId,
    ...(host ? { from: host } : {}),
  });
}
