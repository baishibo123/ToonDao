import type { BranchKind, ConversationNode, NodeId, TextAnchor } from "@/types";
import { childrenOf, type NodeMap } from "@/lib/tree";
import { plainText } from "@/lib/plainText";

/**
 * The conversation's structure, in one place: what a turn is, what a spine is,
 * and the file-structure view of both that the sidebar draws.
 *
 * A TURN is a user node plus its replies. Retries are second replies to the same
 * user node, so they are variants of one turn, never a turn of their own.
 *
 * A SPINE is a run of turns joined by the two edges that *are* the conversation
 * carrying on: an ordinary reply (`continuation`) and a reply to a quoted
 * passage (`quote-reply`). Everything else — a lens, a crop, an isolation — is a
 * departure, and a departure starts a spine of its own.
 *
 * A SPINE IS WHAT ONE PANE SHOWS. The thread shows the spine that starts at the
 * root; an aside shows one departure. No pane ever shows two spines, which is
 * what keeps the reading column one conversation long.
 *
 * WHAT A ROW IS. The outline has one row per spine, nested under the spine it
 * left. Where a turn has two children that could each carry the line — you came
 * back and asked something else — the *oldest* holds it and the later one
 * becomes a nested row, unless a rewind named the one that holds it (the
 * reply's `line`, P-44). An index that reorders itself as you navigate is
 * unusable, so the choice is stable rather than live: only a rewind, which you
 * make on purpose, moves it.
 */

/* ------------------------------------------------------------------ */
/* Turns                                                               */
/* ------------------------------------------------------------------ */

/** The two origin kinds that continue the spine they were born on. */
export const TRUNK_KINDS: readonly BranchKind[] = ["continuation", "quote-reply"];

export function isTrunkKind(kind: BranchKind): boolean {
  return TRUNK_KINDS.includes(kind);
}

export interface TurnGroup {
  /** The user node's id. Stable across rebuilds. */
  id: string;
  user: ConversationNode;
  replies: ConversationNode[];
  parentGroupId: string | null;
  edgeKind: BranchKind;
  anchor?: TextAnchor;
}

/** Which turn a node lives on. Assistant nodes live on their user's turn. */
export function groupIdOf(nodes: NodeMap, id: NodeId): string | null {
  const node = nodes[id];
  if (!node) return null;
  return node.role === "user" ? node.id : node.parentId;
}

export function buildGroups(nodes: NodeMap, conversationId: string): Map<string, TurnGroup> {
  const groups = new Map<string, TurnGroup>();

  for (const node of Object.values(nodes)) {
    if (node.conversationId !== conversationId) continue;
    if (node.role !== "user") continue;

    const replies = node.childrenIds
      .map((id) => nodes[id])
      .filter((n): n is ConversationNode => Boolean(n) && n.role === "assistant")
      .sort((a, b) => a.createdAt - b.createdAt);

    groups.set(node.id, {
      id: node.id,
      user: node,
      replies,
      parentGroupId: node.parentId ? groupIdOf(nodes, node.parentId) : null,
      edgeKind: node.origin?.kind ?? "continuation",
      anchor: node.origin?.anchor,
    });
  }

  // A turn whose parent is missing (deleted mid-tree) becomes a root rather than
  // vanishing — losing a subtree from the index would be worse than showing it
  // detached.
  for (const group of groups.values()) {
    if (group.parentGroupId && !groups.has(group.parentGroupId)) {
      group.parentGroupId = null;
    }
  }

  return groups;
}

/* ------------------------------------------------------------------ */
/* Threads — the outline                                               */
/* ------------------------------------------------------------------ */

export interface OutlineThread {
  /** The head turn's id — its user node's id. Stable across re-layouts. */
  id: string;
  /** Where this thread starts. Clicking the row navigates here. */
  headNodeId: NodeId;
  /** Deepest node on this thread's own spine, excluding nested threads. */
  leafNodeId: NodeId;
  /** How this thread was born. `continuation` at the root of a conversation. */
  kind: BranchKind;
  label: string;
  /** The passage this thread hangs off, when it hangs off one. */
  anchorText?: string;
  /** Turn (group) ids on this spine, in order. */
  turnIds: string[];
  /** Every node id on this spine, both roles — for "is the cursor in here?". */
  nodeIds: NodeId[];
  turnCount: number;
  /** Turns here plus every turn in every nested thread. */
  totalTurns: number;
  depth: number;
  children: OutlineThread[];
}

export interface Outline {
  threads: OutlineThread[];
  /** node id → id of the thread it belongs to. */
  threadOfNode: Map<NodeId, string>;
  /** Every thread by id, so a lookup does not walk the tree. */
  byId: Map<string, OutlineThread>;
  totalTurns: number;
}

const EMPTY: Outline = {
  threads: [],
  threadOfNode: new Map(),
  byId: new Map(),
  totalTurns: 0,
};

export function buildOutline(nodes: NodeMap, conversationId: string | null): Outline {
  if (!conversationId) return EMPTY;
  const groups = buildGroups(nodes, conversationId);
  if (groups.size === 0) return EMPTY;

  const childrenByParent = new Map<string | null, TurnGroup[]>();
  for (const group of groups.values()) {
    const list = childrenByParent.get(group.parentGroupId) ?? [];
    list.push(group);
    childrenByParent.set(group.parentGroupId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.user.createdAt - b.user.createdAt);
  }

  const threadOfNode = new Map<NodeId, string>();
  const byId = new Map<string, OutlineThread>();
  const seen = new Set<string>();

  /** The child a rewind named keeps the line, else the oldest trunk-kind one. See the note above. */
  const spineNext = (group: TurnGroup): TurnGroup | null => {
    const carrying = (childrenByParent.get(group.id) ?? []).filter((k) => isTrunkKind(k.edgeKind));
    const named = carrying.find((k) => k.user.parentId !== null && nodes[k.user.parentId]?.line === k.user.id);
    return named ?? carrying[0] ?? null;
  };

  const build = (head: TurnGroup, depth: number): OutlineThread => {
    const turnIds: string[] = [];
    const nodeIds: NodeId[] = [];
    const forks: TurnGroup[] = [];

    let cursor: TurnGroup | null = head;
    let last: TurnGroup = head;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      turnIds.push(cursor.id);
      nodeIds.push(cursor.user.id, ...cursor.replies.map((r) => r.id));
      const keeper = spineNext(cursor);
      for (const kid of childrenByParent.get(cursor.id) ?? []) {
        if (kid.id !== keeper?.id) forks.push(kid);
      }
      last = cursor;
      cursor = keeper;
    }

    const thread: OutlineThread = {
      id: head.id,
      headNodeId: head.user.id,
      leafNodeId: last.replies.at(-1)?.id ?? last.user.id,
      kind: depth === 0 ? "continuation" : head.edgeKind,
      label: depth === 0 ? "Main thread" : threadLabel(head),
      ...(head.anchor?.text ? { anchorText: head.anchor.text } : {}),
      turnIds,
      nodeIds,
      turnCount: turnIds.length,
      totalTurns: turnIds.length,
      depth,
      // Sorted by where they leave, so the outline reads top-to-bottom in the
      // same order the transcript does.
      children: forks
        .sort((a, b) => a.user.createdAt - b.user.createdAt)
        .map((fork) => build(fork, depth + 1)),
    };

    for (const id of nodeIds) threadOfNode.set(id, thread.id);
    byId.set(thread.id, thread);
    thread.totalTurns += thread.children.reduce((sum, c) => sum + c.totalTurns, 0);
    return thread;
  };

  const threads = (childrenByParent.get(null) ?? []).map((root) => build(root, 0));
  return {
    threads,
    threadOfNode,
    byId,
    totalTurns: threads.reduce((sum, t) => sum + t.totalTurns, 0),
  };
}

/** The thread a node is shown in, or null if it is not in this conversation. */
export function threadOf(outline: Outline, nodeId: NodeId | null): OutlineThread | null {
  if (!nodeId) return null;
  const id = outline.threadOfNode.get(nodeId);
  return (id && outline.byId.get(id)) || null;
}

/* ------------------------------------------------------------------ */
/* Walking one spine                                                   */
/* ------------------------------------------------------------------ */

/**
 * The child that carries `node`'s spine onward, or null at the end of it.
 *
 * THE RULE, in one place. A window is one linear spine, so exactly one child of
 * any node continues it:
 *
 *   - From a user node, the spine goes to its reply. Its other replies are
 *     retries of the same question — variants of one turn, switched in place
 *     with `‹ ›`, not separate lines of thought. A *user* child of a user node
 *     is a gesture made against something the user themselves wrote, so it is a
 *     fork like any other.
 *   - From a reply, the spine goes to the continuation or quote reply that came
 *     next, because those two *are* the conversation carrying on. A lens, a crop
 *     or an isolation departs, and departures get their own window.
 *
 * Where a node has two children that could each carry the line, the remembered
 * choice wins, then the one a rewind named (`line`), then the oldest — the same
 * tie-break `buildOutline()` uses after the remembered choice, so the
 * transcript and the sidebar never disagree about which line is which.
 */
export function spineChild(
  nodes: NodeMap,
  id: NodeId,
  preferred: Record<NodeId, NodeId> = {},
): ConversationNode | null {
  const node = nodes[id];
  if (!node) return null;
  const kids = childrenOf(nodes, id);
  const want = preferred[id];

  if (node.role === "user") {
    const replies = kids.filter((kid) => kid.role === "assistant");
    if (replies.length === 0) return null;
    // The newest reply, because that is the one a retry just produced.
    return replies.find((kid) => kid.id === want) ?? replies[replies.length - 1];
  }

  const carrying = kids.filter(
    (kid) => kid.role === "user" && isTrunkKind(kid.origin?.kind ?? "continuation"),
  );
  if (carrying.length === 0) return null;
  return carrying.find((kid) => kid.id === want) ?? carrying.find((kid) => kid.id === node.line) ?? carrying[0];
}

/** Down one spine to its end. Never crosses into a fork. */
export function spineLeaf(
  nodes: NodeMap,
  id: NodeId,
  preferred: Record<NodeId, NodeId> = {},
): NodeId {
  let cursor = id;
  const seen = new Set<NodeId>();
  for (;;) {
    if (seen.has(cursor)) return cursor;
    seen.add(cursor);
    const next = spineChild(nodes, cursor, preferred);
    if (!next) return cursor;
    cursor = next.id;
  }
}

/**
 * The children of `id` that start a spine of their own — one window each.
 *
 * This is the exact complement of `spineChild()`: every child that is not the
 * one carrying the line, and is not a retry of the same turn. The transcript
 * uses it to mark where a branch left without splicing the branch into itself.
 */
export function forksOf(
  nodes: NodeMap,
  id: NodeId,
  preferred: Record<NodeId, NodeId> = {},
): ConversationNode[] {
  const node = nodes[id];
  if (!node) return [];
  const keeper = spineChild(nodes, id, preferred);
  return childrenOf(nodes, id).filter(
    (kid) => kid.role === "user" && kid.id !== keeper?.id,
  );
}

/**
 * What to call a branch. The passage it hangs off is the most recognisable thing
 * about it — it is what the user pointed at — so that wins over the ask they
 * typed afterwards. A crop points at a cut line rather than a passage, and a
 * fork at a whole message, so neither has a passage and both fall through.
 *
 * One function, because the sidebar row, the window title and the marker in the
 * transcript are three views of one branch and must not name it three ways.
 */
export function branchLabel(node: ConversationNode): string {
  // Named as read, not as written: no `**` or `$` in a label.
  const anchor = flatten(plainText(node.origin?.anchor?.text ?? ""));
  const ask = flatten(plainText(node.content));
  if (node.origin?.kind === "structural-crop") {
    return truncate(ask || "Picked up from the cut", 64);
  }
  return truncate(anchor || ask || "Untitled branch", 64);
}

export function threadLabel(group: TurnGroup): string {
  return branchLabel(group.user);
}

/** Depth-first walk in display order, so the sidebar can flatten for keyboard nav. */
export function flattenOutline(
  threads: OutlineThread[],
  isExpanded: (thread: OutlineThread) => boolean,
): OutlineThread[] {
  const out: OutlineThread[] = [];
  const walk = (list: OutlineThread[]): void => {
    for (const thread of list) {
      out.push(thread);
      if (thread.children.length > 0 && isExpanded(thread)) walk(thread.children);
    }
  };
  walk(threads);
  return out;
}

/** Every ancestor row of `id`, root first — the rows that must be open to see it. */
export function ancestorThreadIds(threads: OutlineThread[], id: string | null): string[] {
  const trail: string[] = [];
  const walk = (list: OutlineThread[], path: string[]): boolean => {
    for (const thread of list) {
      if (thread.id === id) {
        trail.push(...path);
        return true;
      }
      if (walk(thread.children, [...path, thread.id])) return true;
    }
    return false;
  };
  walk(threads, []);
  return trail;
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
