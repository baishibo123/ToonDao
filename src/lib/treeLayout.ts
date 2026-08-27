import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { BranchKind, ConversationNode, NodeId, TextAnchor } from "@/types";
import { pathToRoot, type NodeMap } from "@/lib/tree";

/**
 * Layout for the floating tree (§6).
 *
 * DESIGN: one laid-out node per *turn*, not per message.
 *
 * A user node and its assistant replies form one card. The reason is that a
 * user→assistant edge is always a `continuation` and always present, so drawing
 * it doubles the depth of the tree while carrying no information. Collapsing
 * the pair means every edge that survives is a *decision* — a continuation, a
 * lens, a crop, an isolation, a quote — which is what §6 asks the edge
 * typography to carry. It also gives §11 Q2 its answer for free: retries are
 * replies to the same user node, so they collapse into a variant stack on one
 * card rather than fanning out as separate thoughts.
 *
 * The card has two bands, user above and assistant below, so an edge anchored
 * to a character offset inside a reply can leave from the vertical position that
 * offset corresponds to. That is the visual payoff of storing offsets: an edge
 * visibly leaves from the middle of a message.
 */

export const CARD_WIDTH = 132;
export const CARD_HEIGHT = 46;
export const USER_BAND_HEIGHT = 17;
export const COLUMN_GAP = 30;
export const ROW_GAP = 42;
/** Below this many turns the whole tree is shown regardless of depth. */
export const AUTO_EXPAND_LIMIT = 12;
/**
 * How many levels of an off-path branch stay visible before the rest collapses
 * into a count badge (§6: "auto-collapse subtrees below a depth threshold").
 *
 * Measured from the active path, not from the root: what the map needs to show
 * is where the current line of thought sits and what was tried around it.
 * Collapsing every off-path branch at its first level would hide the whole rest
 * of the conversation behind one badge; not collapsing at all turns a long
 * conversation into spaghetti.
 */
export const OFF_PATH_DEPTH = 2;

export interface TurnGroup {
  /** The user node's id. Stable across re-layouts. */
  id: string;
  user: ConversationNode;
  replies: ConversationNode[];
  parentGroupId: string | null;
  /** Which node inside the parent card this edge leaves from. */
  edgeFromNodeId: NodeId | null;
  edgeKind: BranchKind;
  anchor?: TextAnchor;
}

export interface LaidOutNode extends TurnGroup {
  x: number;
  y: number;
  depth: number;
  turn: number;
  onActivePath: boolean;
  /** The card holding the node the composer is attached to. */
  isCurrent: boolean;
  hiddenDescendants: number;
  childCount: number;
}

export interface LaidOutEdge {
  id: string;
  kind: BranchKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  onActivePath: boolean;
  /** Where inside the parent card the edge leaves, 0 at the top. */
  exitLabel?: string;
}

export interface TreeLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  /** Total turns in the conversation, including collapsed ones. */
  totalGroups: number;
}

/* ------------------------------------------------------------------ */

/** Which card a node lives on. Assistant nodes live on their user's card. */
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

    const parentGroupId = node.parentId ? groupIdOf(nodes, node.parentId) : null;

    groups.set(node.id, {
      id: node.id,
      user: node,
      replies,
      parentGroupId,
      edgeFromNodeId: node.parentId ?? null,
      edgeKind: node.origin?.kind ?? "continuation",
      anchor: node.origin?.anchor,
    });
  }

  // A group whose parent is missing (deleted mid-tree) becomes a root rather
  // than vanishing — losing a subtree from the map would be worse than showing
  // it detached.
  for (const group of groups.values()) {
    if (group.parentGroupId && !groups.has(group.parentGroupId)) {
      group.parentGroupId = null;
    }
  }

  return groups;
}

export function layoutTree(args: {
  nodes: NodeMap;
  conversationId: string;
  activeNodeId: NodeId | null;
  expanded: Set<string>;
}): TreeLayout {
  const { nodes, conversationId, activeNodeId, expanded } = args;
  const groups = buildGroups(nodes, conversationId);
  if (groups.size === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, totalGroups: 0 };
  }

  // The active path in Graph A, mapped onto cards.
  const activeGroupIds = new Set<string>();
  for (const node of pathToRoot(nodes, activeNodeId)) {
    const id = groupIdOf(nodes, node.id);
    if (id) activeGroupIds.add(id);
  }
  const currentGroupId = activeNodeId ? groupIdOf(nodes, activeNodeId) : null;

  const childrenByParent = new Map<string | null, TurnGroup[]>();
  for (const group of groups.values()) {
    const list = childrenByParent.get(group.parentGroupId) ?? [];
    list.push(group);
    childrenByParent.set(group.parentGroupId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.user.createdAt - b.user.createdAt);
  }

  const autoExpandAll = groups.size <= AUTO_EXPAND_LIMIT;

  /**
   * A card's children are drawn when the whole tree is small, when the card is
   * on the active path (so every fork off it is always visible), when the user
   * has expanded it, or when it is still within OFF_PATH_DEPTH levels of the
   * active path. Everything beyond that becomes a count badge.
   */
  const showsChildren = (group: TurnGroup, offPathDepth: number): boolean =>
    autoExpandAll ||
    activeGroupIds.has(group.id) ||
    expanded.has(group.id) ||
    offPathDepth < OFF_PATH_DEPTH;

  const visible: TurnGroup[] = [];
  const hiddenCount = new Map<string, number>();

  const walk = (group: TurnGroup, offPathDepth: number): void => {
    visible.push(group);
    const kids = childrenByParent.get(group.id) ?? [];
    if (kids.length === 0) return;
    if (showsChildren(group, offPathDepth)) {
      for (const kid of kids) {
        walk(kid, activeGroupIds.has(kid.id) ? 0 : offPathDepth + 1);
      }
    } else {
      hiddenCount.set(group.id, countSubtree(childrenByParent, kids));
    }
  };
  for (const root of childrenByParent.get(null) ?? []) {
    walk(root, activeGroupIds.has(root.id) ? 0 : 1);
  }

  // d3-hierarchy needs a single root; a synthetic one keeps multiple roots
  // (possible after a mid-tree delete) laid out side by side.
  const visibleIds = new Set(visible.map((g) => g.id));
  const rootStub: LayoutDatum = { id: "__root__", parentId: null, group: null };
  const data: LayoutDatum[] = [
    rootStub,
    ...visible.map((group) => ({
      id: group.id,
      parentId:
        group.parentGroupId && visibleIds.has(group.parentGroupId)
          ? group.parentGroupId
          : "__root__",
      group,
    })),
  ];

  const root = hierarchy<NestedDatum>(buildNested(data), (d) => d.children);
  const layout = tree<NestedDatum>()
    .nodeSize([CARD_WIDTH + COLUMN_GAP, CARD_HEIGHT + ROW_GAP])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.25));
  const positioned = layout(root);

  const placed = new Map<string, HierarchyPointNode<NestedDatum>>();
  positioned.each((point) => {
    if (point.data.id !== "__root__") placed.set(point.data.id, point);
  });

  // d3 reports card *centres*. Shifting by minX alone leaves the leftmost card
  // extending half a width past x=0, where the SVG clips it — so the offset
  // includes half a card in each axis and the reported size does too.
  const xs = [...placed.values()].map((p) => p.x);
  const minX = (xs.length ? Math.min(...xs) : 0) - CARD_WIDTH / 2;
  // The stub occupies depth 0, so real roots sit at depth 1; lift them back,
  // less half a card so the top row is not clipped either.
  const shiftY = CARD_HEIGHT + ROW_GAP - CARD_HEIGHT / 2;

  const laidOut: LaidOutNode[] = [];
  const turnNumbers = computeTurnNumbers(groups, childrenByParent);

  for (const group of visible) {
    const point = placed.get(group.id);
    if (!point) continue;
    laidOut.push({
      ...group,
      x: point.x - minX,
      y: point.y - shiftY,
      depth: point.depth - 1,
      turn: turnNumbers.get(group.id) ?? 0,
      onActivePath: activeGroupIds.has(group.id),
      isCurrent: group.id === currentGroupId,
      hiddenDescendants: hiddenCount.get(group.id) ?? 0,
      childCount: (childrenByParent.get(group.id) ?? []).length,
    });
  }

  const byId = new Map(laidOut.map((n) => [n.id, n]));
  const edges: LaidOutEdge[] = [];
  for (const node of laidOut) {
    if (!node.parentGroupId) continue;
    const parent = byId.get(node.parentGroupId);
    if (!parent) continue;
    const exit = exitPoint(parent, node, nodes);
    edges.push({
      id: `${parent.id}->${node.id}`,
      kind: node.edgeKind,
      x1: exit.x,
      y1: exit.y,
      x2: node.x,
      y2: node.y - CARD_HEIGHT / 2,
      onActivePath: parent.onActivePath && node.onActivePath,
      exitLabel: exit.label,
    });
  }

  const width = laidOut.length
    ? Math.max(...laidOut.map((n) => n.x)) + CARD_WIDTH / 2
    : 0;
  const height = laidOut.length
    ? Math.max(...laidOut.map((n) => n.y)) + CARD_HEIGHT / 2
    : 0;

  return { nodes: laidOut, edges, width, height, totalGroups: groups.size };
}

/* ------------------------------------------------------------------ */

/**
 * Where an edge leaves its parent card.
 *
 * With an anchor, the exit slides down the band belonging to the node the
 * anchor points into, proportionally to the character offset — so an edge born
 * two thirds of the way through a long answer visibly leaves two thirds of the
 * way down. Without one (a plain continuation) it leaves the bottom centre.
 */
function exitPoint(
  parent: LaidOutNode,
  child: LaidOutNode,
  nodes: NodeMap,
): { x: number; y: number; label?: string } {
  const anchor = child.anchor;
  const sourceId = child.edgeFromNodeId;
  const source = sourceId ? nodes[sourceId] : undefined;

  if (!anchor || !source || source.content.length === 0) {
    return { x: parent.x, y: parent.y + CARD_HEIGHT / 2 };
  }

  const fraction = clamp01(anchor.start / source.content.length);
  const top = parent.y - CARD_HEIGHT / 2;
  const band =
    source.role === "user"
      ? { top, height: USER_BAND_HEIGHT }
      : { top: top + USER_BAND_HEIGHT, height: CARD_HEIGHT - USER_BAND_HEIGHT };

  return {
    x: parent.x + CARD_WIDTH / 2,
    // Inset by 2px at each end so an exit at 0% or 100% still reads as being
    // on the card rather than on its border.
    y: band.top + 2 + (band.height - 4) * fraction,
    label: `${Math.round(fraction * 100)}%`,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function countSubtree(
  childrenByParent: Map<string | null, TurnGroup[]>,
  roots: TurnGroup[],
): number {
  let total = 0;
  const stack = [...roots];
  while (stack.length) {
    const group = stack.pop()!;
    total += 1;
    stack.push(...(childrenByParent.get(group.id) ?? []));
  }
  return total;
}

/** 1-based turn number down each branch, so a fork restarts from its parent. */
function computeTurnNumbers(
  groups: Map<string, TurnGroup>,
  childrenByParent: Map<string | null, TurnGroup[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  const stack: Array<{ group: TurnGroup; turn: number }> = (
    childrenByParent.get(null) ?? []
  ).map((group) => ({ group, turn: 1 }));

  while (stack.length) {
    const { group, turn } = stack.pop()!;
    out.set(group.id, turn);
    for (const child of childrenByParent.get(group.id) ?? []) {
      stack.push({ group: child, turn: turn + 1 });
    }
  }
  void groups;
  return out;
}

/* ------------------------------------------------------------------ */
/* Flat parent pointers → the nested shape d3-hierarchy wants                  */
/* ------------------------------------------------------------------ */

interface LayoutDatum {
  id: string;
  parentId: string | null;
  group: TurnGroup | null;
}

interface NestedDatum extends LayoutDatum {
  children?: NestedDatum[];
}

function buildNested(data: LayoutDatum[]): NestedDatum {
  const byId = new Map<string, NestedDatum>();
  for (const datum of data) byId.set(datum.id, { ...datum });
  let root: NestedDatum | undefined;
  for (const datum of data) {
    const node = byId.get(datum.id)!;
    if (datum.parentId === null) {
      root = node;
      continue;
    }
    const parent = byId.get(datum.parentId);
    if (!parent) {
      root ??= node;
      continue;
    }
    (parent.children ??= []).push(node);
  }
  return root ?? byId.get(data[0]!.id)!;
}
