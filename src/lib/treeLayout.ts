import type { BranchKind, ConversationNode, NodeId, TextAnchor } from "@/types";
import { pathToRoot, type NodeMap } from "@/lib/tree";

/**
 * Layout for the floating tree (§6).
 *
 * DESIGN 1: one laid-out node per *turn*, not per message.
 *
 * A user node and its assistant replies form one node. The reason is that a
 * user→assistant edge is always a `continuation` and always present, so drawing
 * it doubles the depth of the tree while carrying no information. Collapsing
 * the pair means every edge that survives is a *decision* — a continuation, a
 * lens, a crop, an isolation, a quote — which is what §6 asks the edge
 * typography to carry. It also gives §11 Q2 its answer for free: retries are
 * replies to the same user node, so they collapse into a variant ring on one
 * node rather than fanning out as separate thoughts.
 *
 * DESIGN 2: a trunk, and branches off it.
 *
 * The tree is not a generic tidy tree. Two of the six origin kinds *are* the
 * conversation continuing — you replied to what the model said (`continuation`),
 * or you quoted a passage of it and replied (`quote-reply`). Those two run
 * straight down a single vertical spine, because that is what they are: one
 * line of thought, one after another.
 *
 * Everything else — a lens, a crop, an isolation — is a departure from that
 * line, so it leaves sideways as a branch. A branch is itself a spine: it runs
 * downward from where it left, continuations extend it, and a further gesture
 * off it forks again, one column further out. Branches on branches, all the way
 * down.
 *
 * The payoff is that a glance answers "where is the thread, and what came off
 * it" without reading a single label. Depth reads vertically (y is exactly
 * `depth * ROW_GAP`, so equal turns line up across every branch) and departure
 * reads horizontally.
 */

/** Vertical distance between consecutive turns. Also the row quantum. */
export const ROW_GAP = 34;
/** Horizontal distance between one branch column and the next. */
export const COLUMN_GAP = 40;
/** Vertical clearance demanded between two spines sharing a column. */
export const COLUMN_CLEAR = ROW_GAP * 0.9;

export const TRUNK_RADIUS = 6.5;
export const RADIUS_STEP = 1.15;
export const MIN_RADIUS = 3.5;

/**
 * How the two bands of a turn divide its dot: the upper share belongs to the
 * user message, the rest to the reply. An edge anchored to a character offset
 * leaves the rim at the height that offset corresponds to inside its band, so
 * an edge born two thirds of the way through an answer visibly leaves two
 * thirds of the way down. That is the visual payoff of storing offsets.
 */
export const USER_BAND_FRACTION = 0.37;

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

/**
 * The two kinds that *are* the conversation continuing, and so stay on the
 * spine they were born on. Everything else forks.
 */
export const TRUNK_KINDS: readonly BranchKind[] = ["continuation", "quote-reply"];

export function isTrunkKind(kind: BranchKind): boolean {
  return TRUNK_KINDS.includes(kind);
}

/** Branches read as tributaries of the trunk, so they thin out with distance. */
export function radiusFor(branchLevel: number): number {
  return Math.max(MIN_RADIUS, TRUNK_RADIUS - branchLevel * RADIUS_STEP);
}

export type Side = -1 | 0 | 1;

export interface TurnGroup {
  /** The user node's id. Stable across re-layouts. */
  id: string;
  user: ConversationNode;
  replies: ConversationNode[];
  parentGroupId: string | null;
  /** Which node inside the parent this edge leaves from. */
  edgeFromNodeId: NodeId | null;
  edgeKind: BranchKind;
  anchor?: TextAnchor;
}

export interface LaidOutNode extends TurnGroup {
  x: number;
  y: number;
  depth: number;
  turn: number;
  radius: number;
  /** 0 on the trunk, 1 on a branch off it, 2 on a branch off a branch… */
  branchLevel: number;
  /** Which way this node's spine hangs off its parent spine. 0 on the trunk. */
  side: Side;
  /** Shared by every node on one run of trunk-kind edges. */
  spineId: string;
  /** True on the node where a branch leaves the spine that bore it. */
  isBranchRoot: boolean;
  onActivePath: boolean;
  /** The turn holding the node the composer is attached to. */
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
  /** True when both ends sit on one spine — drawn as a straight run. */
  isSpine: boolean;
  /** Which way a fork leaves its parent. 0 on a spine edge. */
  side: Side;
  /** Where inside the parent the edge leaves, as a percentage of the message. */
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

/* ------------------------------------------------------------------ */

interface Placement {
  x: number;
  y: number;
  depth: number;
  branchLevel: number;
  side: Side;
  column: number;
  spineId: string;
  isBranchRoot: boolean;
}

/** A spine waiting to be placed: a head turn plus where it may go. */
interface PendingSpine {
  head: TurnGroup;
  startY: number;
  depth: number;
  branchLevel: number;
  /** Preferred side. Honoured exactly once the branch is off the trunk. */
  side: Side;
  minColumn: number;
  lockSide: boolean;
  order: number;
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

  // The active path in Graph A, mapped onto turns.
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
   * A turn's children are drawn when the whole tree is small, when the turn is
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

  /* ---- placement ------------------------------------------------- */

  const visibleIds = new Set(visible.map((g) => g.id));
  const visibleChildren = (id: string): TurnGroup[] =>
    (childrenByParent.get(id) ?? []).filter((g) => visibleIds.has(g.id));

  /**
   * Which child keeps the spine going. A turn can have two continuations —
   * you went back and asked something else in the same register — and only one
   * of them can occupy the line. The one you are reading wins, so the trunk is
   * always the thread you are actually in; the other becomes a branch, still
   * drawn with its own edge style.
   */
  const spineNext = (group: TurnGroup): TurnGroup | null => {
    const trunkKids = visibleChildren(group.id).filter((k) => isTrunkKind(k.edgeKind));
    if (trunkKids.length === 0) return null;
    return trunkKids.find((k) => activeGroupIds.has(k.id)) ?? trunkKids[0];
  };

  const chainOf = (head: TurnGroup): TurnGroup[] => {
    const chain: TurnGroup[] = [];
    const seen = new Set<string>();
    let cursor: TurnGroup | null = head;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = spineNext(cursor);
    }
    return chain;
  };

  /** Lowest y already consumed in each `side:column` lane. */
  const laneBottom = new Map<string, number>();
  const laneKey = (side: Side, column: number) => `${side}:${column}`;

  const firstFreeColumn = (side: Side, minColumn: number, yTop: number): number => {
    let column = minColumn;
    while ((laneBottom.get(laneKey(side, column)) ?? -Infinity) > yTop - COLUMN_CLEAR) {
      column += 1;
    }
    return column;
  };

  const placement = new Map<string, Placement>();
  const queue: PendingSpine[] = [];
  let order = 0;
  const enqueue = (spine: Omit<PendingSpine, "order">) => {
    queue.push({ ...spine, order: order++ });
  };

  // The first root is the trunk. Any others (only possible after a mid-tree
  // delete orphaned a subtree) are laid out beside it rather than dropped.
  (childrenByParent.get(null) ?? []).forEach((root, index) => {
    enqueue({
      head: root,
      startY: 0,
      depth: 0,
      branchLevel: 0,
      side: index === 0 ? 0 : 1,
      minColumn: index === 0 ? 0 : 1,
      lockSide: index === 0,
    });
  });

  // Forks off the trunk alternate sides, which is what makes the shape read as
  // a trunk rather than as a comb. Deeper forks stay on the side they are
  // already on, so a branch fans outward and never crosses back over the trunk.
  let trunkForkParity = 0;

  while (queue.length > 0) {
    let pick = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i];
      const b = queue[pick];
      if (a.startY < b.startY || (a.startY === b.startY && a.order < b.order)) pick = i;
    }
    const spine = queue.splice(pick, 1)[0];
    const chain = chainOf(spine.head);
    const yTop = spine.startY;
    const yBottom = spine.startY + (chain.length - 1) * ROW_GAP;

    let side: Side = spine.side;
    let column = spine.minColumn;
    if (side !== 0 || spine.minColumn !== 0) {
      const preferred = (side === 0 ? 1 : side) as -1 | 1;
      const here = firstFreeColumn(preferred, spine.minColumn, yTop);
      if (spine.lockSide) {
        side = preferred;
        column = here;
      } else {
        const other = (preferred * -1) as -1 | 1;
        const there = firstFreeColumn(other, spine.minColumn, yTop);
        side = there < here ? other : preferred;
        column = Math.min(here, there);
      }
      laneBottom.set(laneKey(side, column), yBottom);
    }

    const x = side * column * COLUMN_GAP;
    chain.forEach((group, index) => {
      placement.set(group.id, {
        x,
        y: spine.startY + index * ROW_GAP,
        depth: spine.depth + index,
        branchLevel: spine.branchLevel,
        side,
        column,
        spineId: spine.head.id,
        isBranchRoot: index === 0 && spine.branchLevel > 0,
      });
    });

    for (const group of chain) {
      const at = placement.get(group.id)!;
      const keeper = spineNext(group);
      for (const kid of visibleChildren(group.id)) {
        if (keeper && kid.id === keeper.id) continue;
        const onTrunk = spine.branchLevel === 0;
        enqueue({
          head: kid,
          startY: at.y + ROW_GAP,
          depth: at.depth + 1,
          branchLevel: spine.branchLevel + 1,
          side: onTrunk ? (trunkForkParity++ % 2 === 0 ? 1 : -1) : side,
          minColumn: column + 1,
          lockSide: !onTrunk,
        });
      }
    }
  }

  /* ---- normalise to a positive box ------------------------------- */

  const raw = visible
    .map((group) => ({ group, at: placement.get(group.id) }))
    .filter((entry): entry is { group: TurnGroup; at: Placement } => Boolean(entry.at));

  if (raw.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, totalGroups: groups.size };
  }

  const radiusOf = (at: Placement) => radiusFor(at.branchLevel);
  const minX = Math.min(...raw.map(({ at }) => at.x - radiusOf(at)));
  const minY = Math.min(...raw.map(({ at }) => at.y - radiusOf(at)));

  const laidOut: LaidOutNode[] = raw.map(({ group, at }) => ({
    ...group,
    x: at.x - minX,
    y: at.y - minY,
    depth: at.depth,
    turn: at.depth + 1,
    radius: radiusOf(at),
    branchLevel: at.branchLevel,
    side: at.side,
    spineId: at.spineId,
    isBranchRoot: at.isBranchRoot,
    onActivePath: activeGroupIds.has(group.id),
    isCurrent: group.id === currentGroupId,
    hiddenDescendants: hiddenCount.get(group.id) ?? 0,
    childCount: (childrenByParent.get(group.id) ?? []).length,
  }));

  const byId = new Map(laidOut.map((n) => [n.id, n]));
  const edges: LaidOutEdge[] = [];
  for (const node of laidOut) {
    if (!node.parentGroupId) continue;
    const parent = byId.get(node.parentGroupId);
    if (!parent) continue;
    const isSpine = parent.spineId === node.spineId;
    const exit = exitPoint(parent, node, nodes, isSpine);
    edges.push({
      id: `${parent.id}->${node.id}`,
      kind: node.edgeKind,
      x1: exit.x,
      y1: exit.y,
      x2: node.x,
      y2: node.y - node.radius,
      onActivePath: parent.onActivePath && node.onActivePath,
      isSpine,
      side: isSpine ? 0 : node.x >= parent.x ? 1 : -1,
      exitLabel: exit.label,
    });
  }

  const width = Math.max(...laidOut.map((n) => n.x + n.radius));
  const height = Math.max(...laidOut.map((n) => n.y + n.radius));

  return { nodes: laidOut, edges, width, height, totalGroups: groups.size };
}

/* ------------------------------------------------------------------ */

/**
 * Where an edge leaves its parent.
 *
 * A spine edge is a straight vertical run between two turns of one thread, so
 * it always leaves the bottom of the dot — bending it would say something the
 * thread is not doing.
 *
 * A fork leaves the rim. With an anchor the exit slides down the band belonging
 * to the node the anchor points into, proportionally to the character offset;
 * without one it leaves the lower flank at 45°.
 */
function exitPoint(
  parent: LaidOutNode,
  child: LaidOutNode,
  nodes: NodeMap,
  isSpine: boolean,
): { x: number; y: number; label?: string } {
  const anchor = child.anchor;
  const sourceId = child.edgeFromNodeId;
  const source = sourceId ? nodes[sourceId] : undefined;
  const radius = parent.radius;

  const anchored = Boolean(anchor && source && source.content.length > 0);
  const fraction = anchored ? clamp01(anchor!.start / source!.content.length) : 0;
  const label = anchored ? `${Math.round(fraction * 100)}%` : undefined;

  if (isSpine) {
    return { x: parent.x, y: parent.y + radius, label };
  }

  const direction = child.x >= parent.x ? 1 : -1;
  if (!anchored) {
    return {
      x: parent.x + direction * radius * Math.SQRT1_2,
      y: parent.y + radius * Math.SQRT1_2,
    };
  }

  const top = parent.y - radius;
  const band =
    source!.role === "user"
      ? { top, height: 2 * radius * USER_BAND_FRACTION }
      : {
          top: top + 2 * radius * USER_BAND_FRACTION,
          height: 2 * radius * (1 - USER_BAND_FRACTION),
        };

  const y = band.top + band.height * fraction;
  const dy = y - parent.y;
  return {
    x: parent.x + direction * Math.sqrt(Math.max(0, radius * radius - dy * dy)),
    y,
    label,
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
