import { describe, expect, it } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  OFF_PATH_DEPTH,
  USER_BAND_HEIGHT,
  buildGroups,
  groupIdOf,
  layoutTree,
} from "@/lib/treeLayout";
import { TreeFixture } from "./helpers";
import type { NodeMap } from "@/lib/tree";
import type { ConversationNode } from "@/types";

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

describe("turn grouping", () => {
  it("puts an assistant node on its user node's card", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    const a = t.add("assistant", "a", u.id);
    const nodes = mapOf(t);
    expect(groupIdOf(nodes, u.id)).toBe(u.id);
    expect(groupIdOf(nodes, a.id)).toBe(u.id);
  });

  it("makes one card per turn, not one per message", () => {
    const t = new TreeFixture();
    t.linear(6); // 12 nodes
    expect(buildGroups(mapOf(t), t.conversationId).size).toBe(6);
    expect(run(t, t.all().at(-1)!.id).nodes).toHaveLength(6);
  });

  it("collapses retries onto one card rather than fanning them out (§11 Q2)", () => {
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
    const kinds = [
      ["concept-lens", { kind: "windowed" as const, turns: 2, upToNodeId: src.id }],
      ["structural-crop", { kind: "truncated" as const, upToNodeId: src.id, charOffset: 3 }],
      ["isolated-selection", { kind: "isolated" as const, payload: "x" }],
      [
        "quote-reply",
        { kind: "quoted" as const, quote: "q", base: "full-ancestry" as const },
      ],
    ] as const;

    for (const [kind, policy] of kinds) {
      const node = t.add("user", `ask ${kind}`, src.id, policy, kind);
      t.add("assistant", "reply", node.id);
    }

    const layout = run(t, src.id);
    const fromSource = layout.edges.filter((e) => e.id.startsWith(`${t.all()[2].id}->`));
    expect(new Set(layout.edges.map((e) => e.kind))).toEqual(
      new Set([
        "continuation",
        "concept-lens",
        "structural-crop",
        "isolated-selection",
        "quote-reply",
      ]),
    );
    expect(fromSource.length).toBeGreaterThan(0);
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

describe("active path emphasis (§6)", () => {
  it("marks exactly the root→current cards as on-path", () => {
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

  it("marks the card holding the active node as current, for either role", () => {
    const t = new TreeFixture();
    t.linear(2);
    const [u1, , u2, a2] = t.all();
    expect(run(t, a2.id).nodes.find((n) => n.isCurrent)!.id).toBe(u2.id);
    expect(run(t, u2.id).nodes.find((n) => n.isCurrent)!.id).toBe(u2.id);
    expect(run(t, u1.id).nodes.find((n) => n.isCurrent)!.id).toBe(u1.id);
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
    return { edge, parentTop: parent.y - CARD_HEIGHT / 2 };
  }

  it("leaves near the top of the assistant band for an early anchor", () => {
    const { edge, parentTop } = exitFor(0);
    const offset = edge.y1 - parentTop;
    expect(offset).toBeGreaterThanOrEqual(USER_BAND_HEIGHT);
    expect(offset).toBeLessThan(USER_BAND_HEIGHT + 5);
  });

  it("leaves near the bottom for a late anchor", () => {
    const { edge, parentTop } = exitFor(1000);
    expect(edge.y1 - parentTop).toBeGreaterThan(CARD_HEIGHT - 5);
    expect(edge.y1 - parentTop).toBeLessThanOrEqual(CARD_HEIGHT);
  });

  it("is monotonic in the anchor offset — a later anchor never exits higher", () => {
    let previous = -Infinity;
    for (const start of [0, 100, 250, 500, 750, 900, 1000]) {
      const { edge } = exitFor(start);
      expect(edge.y1).toBeGreaterThanOrEqual(previous);
      previous = edge.y1;
    }
  });

  it("reports the offset as a percentage label", () => {
    expect(exitFor(500).edge.exitLabel).toBe("50%");
  });

  it("falls back to the bottom centre for a plain continuation", () => {
    const t = new TreeFixture();
    t.linear(2);
    const layout = run(t, t.all().at(-1)!.id);
    const parent = layout.nodes[0];
    const edge = layout.edges[0];
    expect(edge.x1).toBe(parent.x);
    expect(edge.y1).toBe(parent.y + CARD_HEIGHT / 2);
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
    expect(edge.y1 - (parent.y - CARD_HEIGHT / 2)).toBeLessThan(USER_BAND_HEIGHT);
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

  it("never hides a card without accounting for it in a badge", () => {
    const { t, trunkLeaf } = forked(30, 8);
    const layout = run(t, trunkLeaf.id);
    const hidden = layout.totalGroups - layout.nodes.length;
    const badged = layout.nodes.reduce((sum, n) => sum + n.hiddenDescendants, 0);
    expect(badged).toBe(hidden);
  });
});

describe("geometry", () => {
  it("keeps every card inside the reported bounds", () => {
    const t = new TreeFixture();
    t.linear(5);
    for (let i = 0; i < 4; i++) {
      const fork = t.add("user", `fork ${i}`, t.all()[1].id);
      t.add("assistant", "reply", fork.id);
    }
    const layout = run(t, t.all().at(-1)!.id);
    for (const node of layout.nodes) {
      expect(node.x - CARD_WIDTH / 2).toBeGreaterThanOrEqual(-0.01);
      expect(node.x + CARD_WIDTH / 2).toBeLessThanOrEqual(layout.width + 0.01);
      expect(node.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("never overlaps two cards", () => {
    const t = new TreeFixture();
    t.linear(4);
    for (let i = 0; i < 5; i++) {
      const fork = t.add("user", `fork ${i}`, t.all()[1].id);
      t.add("assistant", "reply", fork.id);
    }
    const layout = run(t, t.all().at(-1)!.id);
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const overlaps =
          Math.abs(a.x - b.x) < CARD_WIDTH && Math.abs(a.y - b.y) < CARD_HEIGHT;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("puts deeper cards lower", () => {
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
    // cards per branch rather than all five.
    const offPath = layout.nodes.filter((n) => !n.onActivePath);
    expect(offPath).toHaveLength(10 * OFF_PATH_DEPTH);
    expect(layout.nodes.length).toBeLessThan(layout.totalGroups);
  });
});
