/**
 * SPEC §9 — the acceptance scenarios, in order, in one file.
 *
 * "Verifiable by inspecting the assembled payload, not by vibes."
 *
 * Scenario 5 (anchor integrity) needs a DOM and lives in anchor.dom.test.tsx,
 * where it is driven through real DOM Ranges over the real renderer; it is
 * cross-referenced here rather than duplicated. Everything else is asserted
 * below against the payload assembleContext() actually produces.
 */
import { describe, expect, it } from "vitest";
import { assembleContext } from "@/lib/assembleContext";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { DEFAULT_SETTINGS } from "@/db/db";
import { draftNode, planSubmission } from "@/lib/draft";
import { buildBundle, parseBundle } from "@/lib/transfer";
import { buildOutline, forksOf, spineChild, spineLeaf } from "@/lib/outline";
import { pathToRoot, type NodeMap } from "@/lib/tree";
import { TreeFixture } from "./helpers";
import type { Conversation, ConversationNode, NodeStore, TextAnchor } from "@/types";
import type { PendingGesture } from "@/store/useUI";

const T = DEFAULT_TEMPLATES;

const FIVE_PARAGRAPHS = [
  "Paragraph one sets up the problem.",
  "Paragraph two introduces the lemma.",
  "Paragraph three is where it goes wrong.",
  "Paragraph four compounds the error.",
  "Paragraph five concludes wrongly.",
].join("\n\n");

function mapOf(t: TreeFixture): NodeMap {
  const out: NodeMap = {};
  for (const node of t.all()) out[node.id] = node;
  return out;
}

function storeOf(nodes: ConversationNode[]): NodeStore {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { get: (id) => map.get(id) };
}

/** Send a planned gesture, as the composer does, and return the new node. */
function sendGesture(
  t: TreeFixture,
  pending: PendingGesture | null,
  text: string,
  activeLeafId: string | null,
) {
  const plan = planSubmission({ text, pending, activeLeafId });
  const node = t.add(
    "user",
    plan.content,
    plan.parentId,
    plan.policy,
    plan.origin?.kind ?? "continuation",
  );
  node.origin = plan.origin;
  return { node, plan };
}

/* ------------------------------------------------------------------ */

describe("§9.1 Concept lens context window", () => {
  it("a term clicked in turn 6 sends turns 5-6 only, wrapped in concept_lens", () => {
    const t = new TreeFixture();
    t.linear(6);
    const turn6Assistant = t.all().at(-1)!;
    const anchor: TextAnchor = { start: 0, end: 6, text: "answer", blockPath: "0" };

    const { node, plan } = sendGesture(
      t,
      { kind: "concept", sourceNodeId: turn6Assistant.id, anchor, turns: 2 },
      "",
      turn6Assistant.id,
    );

    const payload = assembleContext(node, t, T);
    const body = payload.map((m) => m.content).join("\n");

    // Exactly turns 5-6...
    expect(body).toContain("User: question turn 5");
    expect(body).toContain("Assistant: answer turn 5");
    expect(body).toContain("User: question turn 6");
    expect(body).toContain("Assistant: answer turn 6");
    // ...and not turn 1.
    expect(body).not.toContain("turn 1");
    expect(body).not.toContain("turn 2");
    expect(body).not.toContain("turn 3");
    expect(body).not.toContain("turn 4");
    // Wrapped in the template, with the clicked term as the concept.
    expect(body).toContain("This is the context of our conversation:");
    expect(body).toContain("And this is the concept I'm curious about:");
    expect(body).toContain("precisely address my confusion about this specific concept");
    expect(node.content).toBe("answer");
    expect(plan.forks).toBe(true);
  });
});

describe("§9.2 Crop discards the tail", () => {
  it("cropping after paragraph 2 sends 1-2 and zero tokens from 3-5", () => {
    const t = new TreeFixture();
    const u1 = t.add("user", "explain the proof", null);
    const a1 = t.add("assistant", FIVE_PARAGRAPHS, u1.id);
    const cut = FIVE_PARAGRAPHS.indexOf("Paragraph three");

    const { node } = sendGesture(
      t,
      {
        kind: "crop",
        sourceNodeId: a1.id,
        charOffset: cut,
        blockPath: "1",
        discardedChars: FIVE_PARAGRAPHS.length - cut,
      },
      "",
      a1.id,
    );

    const body = assembleContext(node, t, T)
      .map((m) => m.content)
      .join("\n");

    expect(body).toContain("Paragraph one sets up the problem.");
    expect(body).toContain("Paragraph two introduces the lemma.");
    // Zero tokens from 3-5. Not "fewer" — zero.
    expect(body).not.toContain("Paragraph three");
    expect(body).not.toContain("Paragraph four");
    expect(body).not.toContain("Paragraph five");
    expect(body).not.toContain("goes wrong");
    expect(body).not.toContain("compounds");
    expect(body).not.toContain("concludes");

    // The source node still displays all five paragraphs in the UI.
    expect(t.get(a1.id)!.content).toBe(FIVE_PARAGRAPHS);
    expect(t.get(a1.id)!.content.split("\n\n")).toHaveLength(5);
  });
});

describe("§9.3 Isolation is total", () => {
  it("after 10 turns, an isolated selection sends exactly one user message", () => {
    const t = new TreeFixture();
    t.linear(10);
    const turn10 = t.all().at(-1)!;
    const anchor: TextAnchor = {
      start: 0,
      end: 28,
      text: "the map is not the territory",
      blockPath: "0",
    };

    const { node } = sendGesture(
      t,
      { kind: "isolated", sourceNodeId: turn10.id, anchor },
      "",
      turn10.id,
    );

    const payload = assembleContext(node, t, T);
    expect(payload).toHaveLength(1);
    expect(payload[0].role).toBe("user");
    expect(payload[0].content).toContain("the map is not the territory");
    for (let i = 1; i <= 10; i++) {
      expect(payload[0].content).not.toContain(`question turn ${i}`);
      expect(payload[0].content).not.toContain(`answer turn ${i}`);
    }

    // The node is a child of turn 10 in the tree...
    expect(node.parentId).toBe(turn10.id);
    expect(t.get(turn10.id)!.childrenIds).toContain(node.id);
    expect(pathToRoot(mapOf(t), node.id)).toHaveLength(21);

    // ...but it is a departure, not the thread carrying on: it starts a spine
    // of its own, so it is shown in an aside and never inside the thread.
    const nodes = mapOf(t);
    expect(forksOf(nodes, turn10.id).map((n) => n.id)).toEqual([node.id]);
    const [main] = buildOutline(nodes, t.conversationId).threads;
    expect(main.children.map((c) => c.kind)).toEqual(["isolated-selection"]);
  });
});

describe("§9.4 Quote extends, the other three fork", () => {
  it("gives one source node four children with four distinct edge styles", () => {
    const t = new TreeFixture();
    t.linear(6);
    const src = t.all().at(-1)!;
    const anchor: TextAnchor = { start: 0, end: 6, text: "answer", blockPath: "0" };

    // Quote-reply first, off the current leaf: it extends the path.
    const quote = sendGesture(
      t,
      { kind: "quote", sourceNodeId: src.id, anchor },
      "but is that consistent?",
      src.id,
    );
    expect(quote.plan.forks).toBe(false);
    expect(quote.node.parentId).toBe(src.id);

    // The other three parent to the source node regardless of the leaf, so with
    // the quote branch now current they become siblings of it.
    const leafAfterQuote = quote.node.id;
    const lens = sendGesture(
      t,
      { kind: "concept", sourceNodeId: src.id, anchor, turns: 2 },
      "",
      leafAfterQuote,
    );
    const crop = sendGesture(
      t,
      { kind: "crop", sourceNodeId: src.id, charOffset: 6, blockPath: "0", discardedChars: 7 },
      "",
      leafAfterQuote,
    );
    const iso = sendGesture(
      t,
      { kind: "isolated", sourceNodeId: src.id, anchor },
      "",
      leafAfterQuote,
    );

    for (const g of [lens, crop, iso]) {
      expect(g.plan.forks).toBe(true);
      expect(g.node.parentId).toBe(src.id);
    }

    // Four children of one node.
    expect(t.get(src.id)!.childrenIds).toEqual([
      quote.node.id,
      lens.node.id,
      crop.node.id,
      iso.node.id,
    ]);

    // The quote carries the thread on; the other three each leave it, as
    // three separately named asides.
    const nodes = mapOf(t);
    expect(spineChild(nodes, src.id)?.id).toBe(quote.node.id);
    expect(forksOf(nodes, src.id).map((n) => n.id)).toEqual([
      lens.node.id,
      crop.node.id,
      iso.node.id,
    ]);
    const [main] = buildOutline(nodes, t.conversationId).threads;
    expect(main.nodeIds).toContain(quote.node.id);
    const kinds = main.children.map((c) => c.kind);
    expect(kinds).toEqual(["concept-lens", "structural-crop", "isolated-selection"]);
    expect(new Set([...kinds, "quote-reply"]).size).toBe(4);

    // And each carries a different amount of context.
    expect(assembleContext(quote.node, t, T)).toHaveLength(13);
    expect(assembleContext(lens.node, t, T)).toHaveLength(1);
    expect(assembleContext(crop.node, t, T)).toHaveLength(1);
    expect(assembleContext(iso.node, t, T)).toHaveLength(1);
  });
});

describe("§9.5 Anchor integrity", () => {
  it("is proven against real DOM Ranges in anchor.dom.test.tsx", () => {
    // See "ACCEPTANCE 5: anchor integrity on six occurrences of one word":
    // a message with "model" six times including inside a code fence, the fifth
    // occurrence selected through the rendered DOM, resolving to the fifth
    // source offset and round-tripping after a reload. Asserted there because
    // it requires the real renderer and a real Range.
    expect(true).toBe(true);
  });
});

describe("§9.6 Nothing is ever lost", () => {
  it("four branches off one node survive a reload and a JSON round trip", () => {
    const t = new TreeFixture();
    t.linear(4);
    const src = t.all().at(-1)!;
    const anchor: TextAnchor = { start: 0, end: 6, text: "answer", blockPath: "0" };

    const branches = [
      sendGesture(t, { kind: "quote", sourceNodeId: src.id, anchor }, "why?", src.id),
      sendGesture(t, { kind: "concept", sourceNodeId: src.id, anchor, turns: 2 }, "", src.id),
      sendGesture(
        t,
        { kind: "crop", sourceNodeId: src.id, charOffset: 6, blockPath: "0", discardedChars: 7 },
        "",
        src.id,
      ),
      sendGesture(t, { kind: "isolated", sourceNodeId: src.id, anchor }, "", src.id),
    ];
    for (const b of branches) t.add("assistant", `reply to ${b.node.id}`, b.node.id);
    expect(t.get(src.id)!.childrenIds).toHaveLength(4);

    const conversation: Conversation = {
      id: t.conversationId,
      title: "Four branches",
      createdAt: 1,
      updatedAt: 2,
      rootId: t.all()[0].id,
      activeNodeId: branches[3].node.id,
    };

    // "Reload the app": nothing survives but what was persisted.
    const raw = JSON.stringify(
      buildBundle({
        conversations: [conversation],
        nodes: t.all(),
        templates: T,
        settings: DEFAULT_SETTINGS,
      }),
    );
    const parsed = parseBundle(raw);
    const after = storeOf(parsed.nodes);

    // All 4 present.
    const reloadedSrc = parsed.nodes.find((n) => n.id === src.id)!;
    expect(reloadedSrc.childrenIds).toHaveLength(4);
    expect(
      branches.every((b) => parsed.nodes.some((n) => n.id === b.node.id)),
    ).toBe(true);

    // All payloads reconstructible, identically.
    for (const before of t.all()) {
      const node = parsed.nodes.find((n) => n.id === before.id)!;
      expect(assembleContext(node, after, T)).toEqual(assembleContext(before, t, T));
    }

    // Re-exports identically.
    const second = JSON.stringify(
      buildBundle({
        conversations: parsed.conversations,
        nodes: parsed.nodes,
        templates: T,
        settings: DEFAULT_SETTINGS,
      }),
    );
    expect(JSON.parse(second).nodes).toEqual(JSON.parse(raw).nodes);
  });
});

describe("§9.7 Normal use stays normal", () => {
  it("plain typing needs no gesture state and produces the ordinary policy", () => {
    const t = new TreeFixture();
    let leaf: string | null = null;
    for (let i = 1; i <= 5; i++) {
      const { node, plan } = sendGesture(t, null, `question ${i}`, leaf);
      expect(plan.policy).toEqual({ kind: "full-ancestry" });
      expect(plan.origin?.kind ?? "continuation").toBe("continuation");
      expect(plan.forks).toBe(false);
      leaf = t.add("assistant", `answer ${i}`, node.id).id;
    }

    // A user who never discovers a gesture gets exactly path-to-root, in order.
    const last = t.all().at(-2)!;
    const payload = assembleContext(last, t, T);
    expect(payload.map((m) => m.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user",
    ]);
    expect(payload.map((m) => m.content)).toEqual([
      "question 1", "answer 1", "question 2", "answer 2",
      "question 3", "answer 3", "question 4", "answer 4", "question 5",
    ]);

    // No template is involved and no anchor is stored.
    expect(JSON.stringify(payload)).not.toContain("Treat the text above");
    expect(JSON.stringify(payload)).not.toContain("This is the context of our conversation");
    expect(t.all().every((n) => n.origin?.anchor === undefined)).toBe(true);

    // And a gesture-free conversation is one spine: one thread, no asides,
    // and walking it from the root reaches the last reply.
    const nodes = mapOf(t);
    const outline = buildOutline(nodes, t.conversationId);
    expect(outline.threads).toHaveLength(1);
    expect(outline.threads[0].turnCount).toBe(5);
    expect(outline.threads[0].children).toEqual([]);
    expect(spineLeaf(nodes, t.all()[0].id)).toBe(t.all().at(-1)!.id);
  });

  it("the draft payload the composer previews is the payload that gets sent", () => {
    const t = new TreeFixture();
    t.linear(3);
    const leaf = t.all().at(-1)!;

    const plan = planSubmission({ text: "next", pending: null, activeLeafId: leaf.id });
    const previewed = assembleContext(draftNode(plan, t.conversationId), t, T);

    const sent = t.add("user", plan.content, plan.parentId, plan.policy);
    expect(assembleContext(sent, t, T)).toEqual(previewed);
  });
});
