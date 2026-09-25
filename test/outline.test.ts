/**
 * The sidebar outline (requirement 1): the conversation as a file structure.
 *
 * The rows are asserted here rather than in the DOM because the shape is the
 * claim — which branches get a row of their own, what nests under what, and
 * what never appears at all. The component only indents what this produces.
 */
import { describe, expect, it } from "vitest";
import {
  ancestorThreadIds,
  branchLabel,
  buildGroups,
  buildOutline,
  flattenOutline,
  forksOf,
  groupIdOf,
  isTrunkKind,
  spineChild,
  spineLeaf,
  threadOf,
  type OutlineThread,
} from "@/lib/outline";
import { gestureOpensAside, planSubmission } from "@/lib/draft";
import type { BranchKind, ConversationNode, NodeId } from "@/types";
import type { NodeMap } from "@/lib/tree";
import { TreeFixture } from "./helpers";

function mapOf(t: TreeFixture): NodeMap {
  const out: NodeMap = {};
  for (const node of t.all()) out[node.id] = node;
  return out;
}

/** A user turn that departs from `parent`, the way a gesture would make it. */
function fork(
  t: TreeFixture,
  parent: ConversationNode,
  kind: BranchKind,
  ask: string,
  anchorText?: string,
): { user: ConversationNode; assistant: ConversationNode } {
  const user = t.add("user", ask, parent.id, { kind: "full-ancestry" }, kind);
  if (anchorText) {
    user.origin = {
      kind,
      sourceNodeId: parent.id,
      anchor: { start: 0, end: anchorText.length, text: anchorText },
    };
  }
  const assistant = t.add("assistant", `reply to ${ask}`, user.id);
  return { user, assistant };
}

/** Rows in display order, indented relative to the first one passed in. */
function labels(threads: OutlineThread[]): string[] {
  const rows = flattenOutline(threads, () => true);
  const base = rows[0]?.depth ?? 0;
  return rows.map((t) => `${"  ".repeat(t.depth - base)}${t.label}`);
}

function only(t: TreeFixture): OutlineThread {
  const outline = buildOutline(mapOf(t), t.conversationId);
  expect(outline.threads).toHaveLength(1);
  return outline.threads[0];
}

/* ------------------------------------------------------------------ */

describe("one row per thread, not per turn", () => {
  it("a straight conversation is a single row", () => {
    const t = new TreeFixture();
    t.linear(6);
    const main = only(t);

    expect(main.label).toBe("Main thread");
    expect(main.children).toHaveLength(0);
    expect(main.turnCount).toBe(6);
    expect(main.totalTurns).toBe(6);
    expect(main.depth).toBe(0);
  });

  it("a quote reply stays on the row it was made in", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    fork(t, made.at(-1)!, "quote-reply", "about that bit", "that bit");

    const main = only(t);
    expect(main.children).toHaveLength(0);
    expect(main.turnCount).toBe(3);
  });

  it("a retry never gets a row of its own", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    const lastUser = made.at(-2)!;
    // A second reply to the same user node is what a retry is.
    t.add("assistant", "another attempt", lastUser.id, undefined, "regenerate");

    const main = only(t);
    expect(main.children).toHaveLength(0);
    expect(main.turnCount).toBe(2);
    // Both replies still belong to the row.
    expect(main.nodeIds).toHaveLength(5);
  });
});

describe("a departure gets its own row", () => {
  it("a lens off turn 3 nests under the main thread, labelled by its passage", () => {
    const t = new TreeFixture();
    const made = t.linear(4);
    const turn3Assistant = made[5];
    fork(t, turn3Assistant, "concept-lens", "monad", "monad");

    const main = only(t);
    expect(main.turnCount).toBe(4);
    expect(main.children).toHaveLength(1);

    const branch = main.children[0];
    expect(branch.kind).toBe("concept-lens");
    expect(branch.label).toBe("monad");
    expect(branch.anchorText).toBe("monad");
    expect(branch.depth).toBe(1);
    expect(main.totalTurns).toBe(5);
  });

  it("continuations extend a branch's row; a further gesture nests again", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    const lens = fork(t, made.at(-1)!, "concept-lens", "sheaf", "sheaf");
    // Carrying on inside the branch.
    const on = fork(t, lens.assistant, "continuation", "and then?");
    // Departing from the branch.
    fork(t, on.assistant, "isolated-selection", "just this", "just this");

    expect(labels(only(t).children)).toEqual(["sheaf", "  just this"]);
    const branch = only(t).children[0];
    expect(branch.turnCount).toBe(2);
    expect(branch.totalTurns).toBe(3);
  });

  it("crops are labelled by the ask, since a cut has no passage to quote", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    fork(t, made.at(-1)!, "structural-crop", "carry on from here");
    expect(only(t).children[0].label).toBe("carry on from here");

    const u = new TreeFixture();
    const first = u.linear(1);
    fork(u, first.at(-1)!, "structural-crop", "");
    expect(only(u).children[0].label).toBe("Picked up from the cut");
  });
});

describe("stability: the oldest continuation holds the line", () => {
  /**
   * The tree canvas gives the spine to whichever continuation you are reading,
   * because the map should show the thread you are in. The outline cannot: a row
   * that reorders itself as you navigate is unusable as an index. So the second
   * continuation off a turn becomes a nested row, and stays one.
   */
  it("a second continuation off one turn becomes a nested row", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    const turn2Assistant = made.at(-1)!;
    fork(t, turn2Assistant, "continuation", "first follow-up");
    fork(t, turn2Assistant, "continuation", "second follow-up");

    const main = only(t);
    // The first extends the main row...
    expect(main.turnCount).toBe(3);
    // ...the second hangs off it.
    expect(labels(main.children)).toEqual(["second follow-up"]);
  });
});

describe("bookkeeping the sidebar needs", () => {
  it("every node maps to the row that shows it", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    const lens = fork(t, made.at(-1)!, "concept-lens", "topos", "topos");
    const outline = buildOutline(mapOf(t), t.conversationId);

    const main = outline.threads[0];
    for (const node of made) {
      expect(outline.threadOfNode.get(node.id)).toBe(main.id);
    }
    expect(outline.threadOfNode.get(lens.user.id)).toBe(main.children[0].id);
    expect(outline.threadOfNode.get(lens.assistant.id)).toBe(main.children[0].id);
    expect(outline.totalTurns).toBe(3);
  });

  it("ancestorThreadIds gives the rows that must be open to see a branch", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    const a = fork(t, made.at(-1)!, "concept-lens", "one", "one");
    const b = fork(t, a.assistant, "isolated-selection", "two", "two");
    const outline = buildOutline(mapOf(t), t.conversationId);

    const deep = outline.threads[0].children[0].children[0];
    expect(deep.label).toBe("two");
    expect(ancestorThreadIds(outline.threads, deep.id)).toEqual([
      outline.threads[0].id,
      outline.threads[0].children[0].id,
    ]);
    expect(b.user.id).toBe(deep.headNodeId);
  });

  it("flattenOutline hides the children of a collapsed row", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    const lens = fork(t, made.at(-1)!, "concept-lens", "one", "one");
    fork(t, lens.assistant, "isolated-selection", "two", "two");
    const outline = buildOutline(mapOf(t), t.conversationId);
    const collapsed = new Set<NodeId>([outline.threads[0].children[0].id]);

    expect(flattenOutline(outline.threads, (row) => !collapsed.has(row.id)).map((r) => r.label))
      .toEqual(["Main thread", "one"]);
  });

  it("an empty or unknown conversation is an empty outline", () => {
    const t = new TreeFixture();
    t.linear(2);
    expect(buildOutline(mapOf(t), null).threads).toEqual([]);
    expect(buildOutline(mapOf(t), "no-such-conversation").threads).toEqual([]);
    expect(buildOutline({}, t.conversationId).threads).toEqual([]);
  });
});

describe("which gestures open a window (requirement 2)", () => {
  const anchor = { start: 0, end: 3, text: "bit" };

  it("the three that fork open one", () => {
    expect(gestureOpensAside({ kind: "isolated", sourceNodeId: "n1", anchor })).toBe(true);
    expect(gestureOpensAside({ kind: "concept", sourceNodeId: "n1", anchor, turns: 2 })).toBe(
      true,
    );
    expect(
      gestureOpensAside({
        kind: "crop",
        sourceNodeId: "n1",
        charOffset: 10,
        blockPath: "1",
        discardedChars: 40,
      }),
    ).toBe(true);
  });

  it("a quote reply and an ordinary turn do not", () => {
    expect(gestureOpensAside({ kind: "quote", sourceNodeId: "n1", anchor })).toBe(false);
    expect(gestureOpensAside(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("turns", () => {
  // Ported from the removed treeLayout tests: the grouping they covered is
  // still what every row and every spine is built from.
  it("puts an assistant node on its user node's turn", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    const a = t.add("assistant", "a", u.id);
    const nodes = mapOf(t);
    expect(groupIdOf(nodes, u.id)).toBe(u.id);
    expect(groupIdOf(nodes, a.id)).toBe(u.id);
  });

  it("makes one turn per exchange, not one per message", () => {
    const t = new TreeFixture();
    t.linear(6); // 12 nodes
    expect(buildGroups(mapOf(t), t.conversationId).size).toBe(6);
  });

  it("collapses retries into the turn they retry (§11 Q2)", () => {
    const t = new TreeFixture();
    const u = t.add("user", "q", null);
    t.add("assistant", "first try", u.id);
    t.add("assistant", "second try", u.id, { kind: "full-ancestry" }, "regenerate");
    t.add("assistant", "third try", u.id, { kind: "full-ancestry" }, "regenerate");
    const groups = buildGroups(mapOf(t), t.conversationId);
    expect(groups.size).toBe(1);
    expect(groups.get(u.id)!.replies).toHaveLength(3);
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
    const groups = buildGroups(nodes, t.conversationId);
    expect(groups.get(u2.id)!.parentGroupId).toBeNull();
    expect(buildOutline(nodes, t.conversationId).threads.map((th) => th.id)).toEqual([u2.id]);
  });

  it("counts exactly continuation and quote-reply as carrying the line", () => {
    expect(isTrunkKind("continuation")).toBe(true);
    expect(isTrunkKind("quote-reply")).toBe(true);
    for (const kind of ["concept-lens", "structural-crop", "isolated-selection"] as const) {
      expect(isTrunkKind(kind)).toBe(false);
    }
  });
});

describe("a window is one linear spine", () => {
  /**
   * The invariant behind the whole layout: a surface shows one spine and never
   * splices another into itself. `spineLeaf()` is what every navigation lands
   * on, so if it can walk into a fork, a branch can appear in the main chat box.
   */
  it("walks continuations and quote replies, and stops at a fork", () => {
    const t = new TreeFixture();
    const made = t.linear(3);
    const quoted = fork(t, made.at(-1)!, "quote-reply", "about that", "that");
    const lens = fork(t, quoted.assistant, "concept-lens", "monad", "monad");
    const nodes = mapOf(t);

    // Down the trunk, through the quote reply, and no further.
    expect(spineLeaf(nodes, made[0].id)).toBe(quoted.assistant.id);
    // The lens is a spine of its own: it starts where it starts and ends there.
    expect(spineLeaf(nodes, lens.user.id)).toBe(lens.assistant.id);
    // And it is not on the trunk's spine.
    expect(spineLeaf(nodes, made[0].id)).not.toBe(lens.assistant.id);
  });

  it("stays on the trunk when a lens hangs off a middle turn", () => {
    const t = new TreeFixture();
    const made = t.linear(4);
    fork(t, made[3], "concept-lens", "aside", "aside");
    const nodes = mapOf(t);
    expect(spineLeaf(nodes, made[0].id)).toBe(made.at(-1)!.id);
  });

  it("treats a retry as the same turn, and prefers the remembered variant", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    const user = made[0];
    const retry = t.add("assistant", "second attempt", user.id, undefined, "regenerate");
    const nodes = mapOf(t);

    // Newest reply by default — the one a retry just produced.
    expect(spineLeaf(nodes, user.id)).toBe(retry.id);
    // The remembered choice wins, and neither reply is a fork.
    expect(spineLeaf(nodes, user.id, { [user.id]: made[1].id })).toBe(made[1].id);
    expect(forksOf(nodes, user.id)).toEqual([]);
  });

  it("a gesture made against a user message forks rather than continuing it", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    const user = made[0];
    const iso = fork(t, user, "isolated-selection", "only this", "only this");
    const nodes = mapOf(t);

    expect(spineLeaf(nodes, user.id)).toBe(made[1].id);
    expect(forksOf(nodes, user.id).map((n) => n.id)).toEqual([iso.user.id]);
  });

  it("forksOf is exactly the complement of spineChild", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    const reply = made.at(-1)!;
    const on = fork(t, reply, "continuation", "carry on");
    const lens = fork(t, reply, "concept-lens", "term", "term");
    const crop = fork(t, reply, "structural-crop", "");
    const nodes = mapOf(t);

    // The oldest continuation holds the line...
    expect(spineChild(nodes, reply.id)?.id).toBe(on.user.id);
    // ...and everything else off that message is a window of its own.
    expect(forksOf(nodes, reply.id).map((n) => n.id)).toEqual([lens.user.id, crop.user.id]);
    // A second ordinary continuation is a fork too: two lines, two panes.
    const second = fork(t, reply, "continuation", "and another thing");
    const after = mapOf(t);
    expect(spineChild(after, reply.id)?.id).toBe(on.user.id);
    expect(forksOf(after, reply.id).map((n) => n.id)).toContain(second.user.id);
  });

  it("threadOf finds which window a node belongs to", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    const lens = fork(t, made.at(-1)!, "concept-lens", "term", "term");
    const outline = buildOutline(mapOf(t), t.conversationId);

    expect(threadOf(outline, made[0].id)?.depth).toBe(0);
    expect(threadOf(outline, lens.assistant.id)?.depth).toBe(1);
    expect(threadOf(outline, "nope")).toBeNull();
    expect(threadOf(outline, null)).toBeNull();
  });
});

describe("the fork gesture", () => {
  /**
   * An ordinary turn taken off an earlier message. Same payload as ordinary
   * chat; the only difference is where it attaches — and that it forks, so it
   * opens a window instead of moving the thread.
   */
  it("is a full-ancestry continuation that forks", () => {
    const plan = planSubmission({
      text: "what about the other case?",
      pending: { kind: "fork", sourceNodeId: "n4" },
      activeLeafId: "n10",
    });
    expect(plan.parentId).toBe("n4");
    expect(plan.policy).toEqual({ kind: "full-ancestry" });
    expect(plan.origin).toEqual({ kind: "continuation", sourceNodeId: "n4" });
    expect(plan.forks).toBe(true);
    expect(gestureOpensAside({ kind: "fork", sourceNodeId: "n4" })).toBe(true);
  });

  it("is named by its ask, since it points at no passage", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    const forked = fork(t, made.at(-1)!, "continuation", "what about the other case?");
    expect(branchLabel(forked.user)).toBe("what about the other case?");
  });
});
