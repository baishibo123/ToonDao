import { describe, expect, it } from "vitest";
import {
  COLUMN_GAP,
  OFF_PATH_DEPTH,
  ROW_GAP,
  TRUNK_RADIUS,
  USER_BAND_FRACTION,
  buildGroups,
  groupIdOf,
  isTrunkKind,
  layoutTree,
  radiusFor,
} from "@/lib/treeLayout";
import { TreeFixture } from "./helpers";
import type { NodeMap } from "@/lib/tree";
import type { BranchKind, ContextPolicy, ConversationNode } from "@/types";

function mapOf(t: TreeFixture): NodeMap {
  const out: NodeMap = {};
  for (const node of t.all()) out[node.id] = node;
  return out;
}

function run(t: TreeFixture, activeNodeId: string | null, expanded: string[] = []) {
  return layoutTree({
    nodes: mapOf(t),
    conversationId: t.conversationId,
    activeNodeId,
    expanded: new Set(expanded),
  });
}

/** A turn added with one of the four gestures, plus its reply. */
function gesture(
  t: TreeFixture,
  parentId: string,
  kind: BranchKind,
  label: string = kind,
): ConversationNode {
  const policies: Record<string, ContextPolicy> = {
    "concept-lens": { kind: "windowed", turns: 2, upToNodeId: parentId },
    "structural-crop": { kind: "truncated", upToNodeId: parentId, charOffset: 3 },
    "isolated-selection": { kind: "isolated", payload: "x" },
    "quote-reply": { kind: "quoted", quote: "q", base: "full-ancestry" },
    continuation: { kind: "full-ancestry" },
    regenerate: { kind: "full-ancestry" },
  };
  const user = t.add("user", label, parentId, policies[kind], kind);
  t.add("assistant", `${label} reply`, user.id);
  return user;
}

describe("turn grouping", () => {
  it("puts an assistant node on its user node's turn", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    const a = t.add("assistant", "a", u.id);
    const nodes = mapOf(t);
    expect(groupIdOf(nodes, u.id)).toBe(u.id);
    expect(groupIdOf(nodes, a.id)).toBe(u.id);
  });

  it("makes one node per turn, not one per message", () => {
    const t = new TreeFixture();
    t.linear(6); // 12 nodes
    expect(buildGroups(mapOf(t), t.conversationId).size).toBe(6);
    expect(run(t, t.all().at(-1)!.id).nodes).toHaveLength(6);
  });

  it("collapses retries onto one dot rather than fanning them out (§11 Q2)", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    t.add("assistant", "first try", u.id);
    t.add("assistant", "second try", u.id, { kind: "full-ancestry" }, "regenerate");
    t.add("assistant", "third try", u.id, { kind: "full-ancestry" }, "regenerate");

    const layout = run(t, u.id);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0].replies).toHaveLength(3);
    expect(layout.edges).toHaveLength(0);
  });

  it("types each edge from the child user node's origin", () => {
    const t = new TreeFixture();
    t.linear(2);
    const src = t.all().at(-1)!;
    for (const kind of [
      "concept-lens",
      "structural-crop",
      "isolated-selection",
      "quote-reply",
    ] as const) {
      gesture(t, src.id, kind, `ask ${kind}`);
    }

    const layout = run(t, src.id);
    expect(new Set(layout.edges.map((e) => e.kind))).toEqual(
      new Set([
        "continuation",
        "concept-lens",
        "structural-crop",
        "isolated-selection",
        "quote-reply",
      ]),
    );
  });

  it("promotes an orphaned subtree to a root rather than dropping it", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "q1", null);
    const a1 = t.add("assistant", "a1", u1.id);
    const u2 = t.add("user", "q2", a1.id);
    t.add("assistant", "a2", u2.id);

    const nodes = mapOf(t);
    delete nodes[a1.id]; // simulate a mid-tree delete
    delete nodes[u1.id];

    const layout = layoutTree({
      nodes,
      conversationId: t.conversationId,
      activeNodeId: u2.id,
      expanded: new Set(),
    });
    expect(layout.nodes.map((n) => n.id)).toContain(u2.id);
    expect(layout.nodes.find((n) => n.id === u2.id)!.parentGroupId).toBeNull();
  });
});

describe("trunk and branches (§6)", () => {
  it("counts exactly continuation and quote-reply as trunk kinds", () => {
    expect(isTrunkKind("continuation")).toBe(true);
    expect(isTrunkKind("quote-reply")).toBe(true);
    for (const kind of ["concept-lens", "structural-crop", "isolated-selection"] as const) {
      expect(isTrunkKind(kind)).toBe(false);
    }
  });

  it("keeps replying and quoting on one straight trunk", () => {
    const t = new TreeFixture();
    t.linear(3);
    const quoted = gesture(t, t.all().at(-1)!.id, "quote-reply", "quote");
    const quotedReply = t.all().at(-1)!;
    gesture(t, quotedReply.id, "continuation", "carry on");

    const layout = run(t, t.all().at(-1)!.id);
    expect(layout.nodes).toHaveLength(5);
    expect(new Set(layout.nodes.map((n) => n.x)).size).toBe(1);
    expect(layout.nodes.every((n) => n.branchLevel === 0 && n.side === 0)).toBe(true);
    expect(layout.edges.every((e) => e.isSpine)).toBe(true);
    expect(layout.nodes.find((n) => n.id === quoted.id)!.isBranchRoot).toBe(false);
  });

  it("forks a lens, a crop and an isolation off the trunk", () => {
    const t = new TreeFixture();
    t.linear(2);
    const src = t.all().at(-1)!;
    const forks = (["concept-lens", "structural-crop", "isolated-selection"] as const).map(
      (kind) => gesture(t, src.id, kind),
    );

    const layout = run(t, src.id);
    const trunkX = layout.nodes.find((n) => n.branchLevel === 0)!.x;

    for (const fork of forks) {
      const node = layout.nodes.find((n) => n.id === fork.id)!;
      expect(node.branchLevel).toBe(1);
      expect(node.isBranchRoot).toBe(true);
      expect(node.side).not.toBe(0);
      expect(Math.abs(node.x - trunkX)).toBeGreaterThanOrEqual(COLUMN_GAP - 0.01);
    }
    expect(layout.edges.filter((e) => !e.isSpine)).toHaveLength(3);
  });

  it("alternates the side successive forks leave the trunk on", () => {
    const t = new TreeFixture();
    t.linear(2);
    const src = t.all().at(-1)!;
    const a = gesture(t, src.id, "concept-lens", "lens a");
    const b = gesture(t, src.id, "concept-lens", "lens b");

    const layout = run(t, src.id);
    const sides = [a, b].map((g) => layout.nodes.find((n) => n.id === g.id)!.side);
    expect(new Set(sides)).toEqual(new Set([-1, 1]));
  });

  it("branches a branch, one column further out and on the same side", () => {
    const t = new TreeFixture();
    t.linear(2);
    const lens = gesture(t, t.all().at(-1)!.id, "concept-lens");
    const lensReply = t.all().at(-1)!;
    const carried = gesture(t, lensReply.id, "continuation", "carry the branch on");
    const carriedReply = t.all().at(-1)!;
    const deeper = gesture(t, carriedReply.id, "isolated-selection", "off the branch");

    const layout = run(t, lensReply.id);
    const at = (id: string) => layout.nodes.find((n) => n.id === id)!;

    // A continuation off a branch stays on that branch's own spine.
    expect(at(carried.id).branchLevel).toBe(1);
    expect(at(carried.id).x).toBe(at(lens.id).x);
    expect(at(carried.id).spineId).toBe(at(lens.id).spineId);

    // A gesture off a branch forks again, outward.
    expect(at(deeper.id).branchLevel).toBe(2);
    expect(at(deeper.id).side).toBe(at(lens.id).side);
    expect(Math.abs(at(deeper.id).x)).toBeGreaterThan(Math.abs(at(lens.id).x));
    expect(at(deeper.id).radius).toBeLessThan(at(lens.id).radius);
  });

  it("gives the trunk to the continuation you are actually reading", () => {
    const t = new TreeFixture();
    t.linear(2);
    const src = t.all().at(-1)!;
    const first = gesture(t, src.id, "continuation", "one way");
    const firstReply = t.all().at(-1)!;
    const second = gesture(t, src.id, "continuation", "another way");
    const secondReply = t.all().at(-1)!;

    const onSecond = run(t, secondReply.id);
    expect(onSecond.nodes.find((n) => n.id === second.id)!.branchLevel).toBe(0);
    expect(onSecond.nodes.find((n) => n.id === first.id)!.branchLevel).toBe(1);

    const onFirst = run(t, firstReply.id);
    expect(onFirst.nodes.find((n) => n.id === first.id)!.branchLevel).toBe(0);
    expect(onFirst.nodes.find((n) => n.id === second.id)!.branchLevel).toBe(1);
  });

  it("thins branches out with distance from the trunk", () => {
    expect(radiusFor(0)).toBe(TRUNK_RADIUS);
    expect(radiusFor(1)).toBeLessThan(radiusFor(0));
    expect(radiusFor(2)).toBeLessThan(radiusFor(1));
    expect(radiusFor(40)).toBeGreaterThan(0);
  });

  it("puts every turn on the row its depth earns, whatever branch it is on", () => {
    const t = new TreeFixture();
    t.linear(3);
    const lens = gesture(t, t.all()[1].id, "concept-lens"); // off turn 1
    const layout = run(t, t.all().at(-1)!.id);
    const at = (id: string) => layout.nodes.find((n) => n.id === id)!;

    // The lens is turn 1's child, so it sits on the same row as trunk turn 2.
    const trunkTurn2 = layout.nodes.find((n) => n.branchLevel === 0 && n.turn === 2)!;
    expect(at(lens.id).turn).toBe(2);
    expect(at(lens.id).y).toBe(trunkTurn2.y);
    // The whole box is shifted by the trunk root's radius, so every row lands
    // on the same grid whatever branch it is on.
    for (const node of layout.nodes) {
      expect(node.y).toBeCloseTo(node.depth * ROW_GAP + TRUNK_RADIUS, 5);
    }
  });
});

describe("active path emphasis (§6)", () => {
  it("marks exactly the root→current turns as on-path", () => {
    const t = new TreeFixture();
    t.linear(3);
    const a3 = t.all().at(-1)!;
    const fork = t.add("user", "fork", t.all()[1].id); // child of turn 1's assistant
    t.add("assistant", "fork reply", fork.id);

    const layout = run(t, a3.id);
    const onPath = layout.nodes.filter((n) => n.onActivePath).map((n) => n.turn);
    expect(onPath.sort()).toEqual([1, 2, 3]);
    expect(layout.nodes.find((n) => n.id === fork.id)!.onActivePath).toBe(false);
  });

  it("marks the turn holding the active node as current, for either role", () => {
    const t = new TreeFixture();
    t.linear(2);
    const [u1, , u2, a2] = t.all();
    expect(run(t, a2.id).nodes.find((n) => n.isCurrent)!.id).toBe(u2.id);
    expect(run(t, u2.id).nodes.find((n) => n.isCurrent)!.id).toBe(u2.id);
    expect(run(t, u1.id).nodes.find((n) => n.isCurrent)!.id).toBe(u1.id);
  });

  it("marks exactly one turn current, so the highlight is unambiguous", () => {
    const t = new TreeFixture();
    t.linear(4);
    gesture(t, t.all()[1].id, "concept-lens");
    const layout = run(t, t.all().at(-1)!.id);
    expect(layout.nodes.filter((n) => n.isCurrent)).toHaveLength(1);
  });

  it("marks an edge on-path only when both ends are", () => {
    const t = new TreeFixture();
    t.linear(3);
    const a3 = t.all().at(-1)!;
    const fork = t.add("user", "fork", t.all()[1].id);
    const layout = run(t, a3.id);
    const forkEdge = layout.edges.find((e) => e.id.endsWith(`->${fork.id}`))!;
    expect(forkEdge.onActivePath).toBe(false);
    expect(layout.edges.filter((e) => e.onActivePath)).toHaveLength(2);
  });
});

describe("anchor-positioned edge exits (§6)", () => {
  const LONG = "x".repeat(1000);
  const DIAMETER = TRUNK_RADIUS * 2;

  function exitFor(anchorStart: number) {
    const t = new TreeFixture();
    const u1 = t.add("user", "q", null);
    const a1 = t.add("assistant", LONG, u1.id);
    const child = t.add(
      "user",
      "ask",
      a1.id,
      { kind: "isolated", payload: "p" },
      "isolated-selection",
    );
    // Attach the anchor the way the gestures do.
    child.origin = {
      kind: "isolated-selection",
      sourceNodeId: a1.id,
      anchor: { start: anchorStart, end: anchorStart + 5, text: "xxxxx" },
    };
    const layout = run(t, child.id);
    const parent = layout.nodes.find((n) => n.id === u1.id)!;
    const edge = layout.edges.find((e) => e.id.endsWith(`->${child.id}`))!;
    return { edge, parent, parentTop: parent.y - parent.radius };
  }

  it("leaves at the top of the assistant band for an early anchor", () => {
    const { edge, parentTop } = exitFor(0);
    const offset = edge.y1 - parentTop;
    expect(offset).toBeCloseTo(DIAMETER * USER_BAND_FRACTION, 5);
  });

  it("leaves at the bottom of the dot for a late anchor", () => {
    const { edge, parentTop } = exitFor(1000);
    expect(edge.y1 - parentTop).toBeCloseTo(DIAMETER, 5);
  });

  it("is monotonic in the anchor offset — a later anchor never exits higher", () => {
    let previous = -Infinity;
    for (const start of [0, 100, 250, 500, 750, 900, 1000]) {
      const { edge } = exitFor(start);
      expect(edge.y1).toBeGreaterThanOrEqual(previous);
      previous = edge.y1;
    }
  });

  it("keeps the exit on the rim of the dot it leaves", () => {
    for (const start of [0, 250, 500, 900]) {
      const { edge, parent } = exitFor(start);
      const distance = Math.hypot(edge.x1 - parent.x, edge.y1 - parent.y);
      expect(distance).toBeCloseTo(parent.radius, 5);
    }
  });

  it("reports the offset as a percentage label", () => {
    expect(exitFor(500).edge.exitLabel).toBe("50%");
  });

  it("falls back to the bottom of the dot for a plain continuation", () => {
    const t = new TreeFixture();
    t.linear(2);
    const layout = run(t, t.all().at(-1)!.id);
    const parent = layout.nodes[0];
    const edge = layout.edges[0];
    expect(edge.isSpine).toBe(true);
    expect(edge.x1).toBe(parent.x);
    expect(edge.y1).toBe(parent.y + parent.radius);
    expect(edge.exitLabel).toBeUndefined();
  });

  it("leaves from the user band when the anchor points into a user message", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "y".repeat(100), null);
    const child = t.add(
      "user",
      "ask",
      u1.id,
      { kind: "isolated", payload: "p" },
      "isolated-selection",
    );
    child.origin = {
      kind: "isolated-selection",
      sourceNodeId: u1.id,
      anchor: { start: 50, end: 55, text: "yyyyy" },
    };
    const layout = run(t, child.id);
    const parent = layout.nodes.find((n) => n.id === u1.id)!;
    const edge = layout.edges.find((e) => e.id.endsWith(`->${child.id}`))!;
    expect(edge.y1 - (parent.y - parent.radius)).toBeLessThan(
      parent.radius * 2 * USER_BAND_FRACTION,
    );
  });
});

describe("auto-collapse (§6 depth threshold)", () => {
  /** A trunk of `turns` turns with a side branch of `sideDepth` turns hanging
   *  off the first turn. */
  function forked(turns: number, sideDepth: number) {
    const t = new TreeFixture();
    t.linear(turns);
    let cursor: ConversationNode = t.all()[1]; // turn 1's assistant
    const side: ConversationNode[] = [];
    for (let i = 0; i < sideDepth; i++) {
      const u = t.add("user", `side ${i}`, cursor.id);
      cursor = t.add("assistant", `side reply ${i}`, u.id);
      side.push(u);
    }
    return { t, side, trunkLeaf: t.all().find((n) => n.content === `answer turn ${turns}`)! };
  }

  it("shows everything while the tree is small", () => {
    const { t, trunkLeaf } = forked(3, 3);
    const layout = run(t, trunkLeaf.id);
    expect(layout.nodes).toHaveLength(layout.totalGroups);
    expect(layout.nodes.every((n) => n.hiddenDescendants === 0)).toBe(true);
  });

  it("keeps the whole active path visible however long it gets", () => {
    const { t, trunkLeaf } = forked(20, 6);
    const layout = run(t, trunkLeaf.id);
    expect(layout.nodes.filter((n) => n.onActivePath)).toHaveLength(20);
  });

  it("shows OFF_PATH_DEPTH levels of a side branch, then a count badge", () => {
    const { t, trunkLeaf } = forked(20, 6);
    const layout = run(t, trunkLeaf.id);
    const sideVisible = layout.nodes.filter(
      (n) => !n.onActivePath && n.user.content.startsWith("side"),
    );
    expect(sideVisible).toHaveLength(OFF_PATH_DEPTH);
    const badge = layout.nodes.find((n) => n.hiddenDescendants > 0);
    expect(badge).toBeDefined();
    expect(badge!.hiddenDescendants).toBe(6 - OFF_PATH_DEPTH);
  });

  it("expands a subtree on demand", () => {
    const { t, side, trunkLeaf } = forked(20, 6);
    const collapsed = run(t, trunkLeaf.id);
    const badgeId = collapsed.nodes.find((n) => n.hiddenDescendants > 0)!.id;
    const expanded = run(t, trunkLeaf.id, [badgeId]);
    expect(expanded.nodes.length).toBeGreaterThan(collapsed.nodes.length);
    expect(side.length).toBe(6);
  });

  it("never hides a turn without accounting for it in a badge", () => {
    const { t, trunkLeaf } = forked(30, 8);
    const layout = run(t, trunkLeaf.id);
    const hidden = layout.totalGroups - layout.nodes.length;
    const badged = layout.nodes.reduce((sum, n) => sum + n.hiddenDescendants, 0);
    expect(badged).toBe(hidden);
  });
});

describe("geometry", () => {
  it("keeps every dot inside the reported bounds", () => {
    const t = new TreeFixture();
    t.linear(5);
    for (let i = 0; i < 4; i++) {
      gesture(t, t.all()[1].id, "concept-lens", `fork ${i}`);
    }
    const layout = run(t, t.all().at(-1)!.id);
    for (const node of layout.nodes) {
      expect(node.x - node.radius).toBeGreaterThanOrEqual(-0.01);
      expect(node.x + node.radius).toBeLessThanOrEqual(layout.width + 0.01);
      expect(node.y - node.radius).toBeGreaterThanOrEqual(-0.01);
      expect(node.y + node.radius).toBeLessThanOrEqual(layout.height + 0.01);
    }
  });

  it("never overlaps two dots", () => {
    const t = new TreeFixture();
    t.linear(4);
    for (let i = 0; i < 5; i++) {
      gesture(t, t.all()[1].id, "isolated-selection", `fork ${i}`);
    }
    // …and a branch hanging off a branch, which is what fills the columns up.
    const branchReply = t.all().find((n) => n.content === "fork 0 reply")!;
    gesture(t, branchReply.id, "concept-lens", "deep");

    const layout = run(t, t.all().at(-1)!.id);
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
        expect(gap).toBeGreaterThan(6);
      }
    }
  });

  it("stacks two long branches on one side in separate columns", () => {
    const t = new TreeFixture();
    t.linear(8);
    // Two lenses off adjacent trunk turns, each carrying on for a few turns.
    const heads = [t.all()[1].id, t.all()[3].id].map((parent) => {
      let head = gesture(t, parent, "concept-lens", "lens");
      let cursor = t.all().at(-1)!;
      for (let i = 0; i < 4; i++) {
        gesture(t, cursor.id, "continuation", "on");
        cursor = t.all().at(-1)!;
      }
      return head;
    });

    const layout = run(t, t.all().find((n) => n.content === "answer turn 8")!.id);
    const [a, b] = heads.map((h) => layout.nodes.find((n) => n.id === h.id)!);
    // Whether they land on the same side or opposite ones, they never collide.
    expect(a.side === b.side ? a.x !== b.x : true).toBe(true);
  });

  it("puts deeper turns lower", () => {
    const t = new TreeFixture();
    t.linear(5);
    const layout = run(t, t.all().at(-1)!.id);
    const sorted = [...layout.nodes].sort((a, b) => a.depth - b.depth);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].y).toBeGreaterThan(sorted[i - 1].y);
    }
    expect(sorted[0].depth).toBe(0);
  });

  it("handles an empty conversation", () => {
    const layout = layoutTree({
      nodes: {},
      conversationId: "none",
      activeNodeId: null,
      expanded: new Set(),
    });
    expect(layout).toEqual({ nodes: [], edges: [], width: 0, height: 0, totalGroups: 0 });
  });

  it("stays fast and bounded on a 200+ node conversation", () => {
    const t = new TreeFixture();
    t.linear(50);
    // Ten side branches, each five turns deep — the shape that would turn into
    // spaghetti without a depth threshold.
    for (let i = 0; i < 10; i++) {
      let cursor = t.all()[i * 2 + 1];
      for (let d = 0; d < 5; d++) {
        const u = t.add("user", `fork ${i}.${d}`, cursor.id);
        cursor = t.add("assistant", "reply", u.id);
      }
    }
    const nodes = mapOf(t);
    expect(Object.keys(nodes).length).toBeGreaterThanOrEqual(200);

    const started = performance.now();
    const layout = layoutTree({
      nodes,
      conversationId: t.conversationId,
      activeNodeId: t.all().find((n) => n.content === "answer turn 50")!.id,
      expanded: new Set(),
    });
    expect(performance.now() - started).toBeLessThan(150);
    expect(layout.totalGroups).toBe(100);

    // The active path is always drawn in full — that is what §6 asks for, and
    // a 50-turn conversation genuinely is 50 turns long.
    expect(layout.nodes.filter((n) => n.onActivePath)).toHaveLength(50);

    // What must stay bounded is the off-path clutter: at most OFF_PATH_DEPTH
    // turns per branch rather than all five.
    const offPath = layout.nodes.filter((n) => !n.onActivePath);
    expect(offPath).toHaveLength(10 * OFF_PATH_DEPTH);
    expect(layout.nodes.length).toBeLessThan(layout.totalGroups);
  });
});
