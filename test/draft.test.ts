import { describe, expect, it } from "vitest";
import {
  askAgainSeed,
  draftNode,
  gestureOpensAside,
  planIsSendable,
  planSubmission,
  restartedConversation,
} from "@/lib/draft";
import { assembleContext, isContextRoot } from "@/lib/assembleContext";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { TreeFixture } from "./helpers";
import type { PendingGesture } from "@/store/useUI";
import type { TextAnchor } from "@/types";

const T = DEFAULT_TEMPLATES;
const anchor: TextAnchor = {
  start: 10,
  end: 26,
  text: "Reingold Tilford",
  blockPath: "2",
};

/**
 * planSubmission() is the single gesture → policy mapping. These tests pin the
 * four properties that make the five interactions one system rather than five
 * features: which policy each gesture selects, which node it parents to,
 * whether it forks, and that the resulting node assembles to the right payload.
 */

describe("§5.5 ordinary chat", () => {
  it("is full-ancestry, continuation, on the current leaf", () => {
    const plan = planSubmission({ text: "hello", pending: null, activeLeafId: "leaf" });
    expect(plan).toEqual({
      parentId: "leaf",
      policy: { kind: "full-ancestry" },
      origin: { kind: "continuation", sourceNodeId: "leaf" },
      content: "hello",
      forks: false,
    });
  });

  it("has no origin for the very first message in a conversation", () => {
    const plan = planSubmission({ text: "hello", pending: null, activeLeafId: null });
    expect(plan.origin).toBeNull();
    expect(plan.parentId).toBeNull();
  });

  it("trims the typed text", () => {
    expect(
      planSubmission({ text: "  hi  ", pending: null, activeLeafId: null }).content,
    ).toBe("hi");
  });
});

describe("§5.4 quote reply — extends, does not fork", () => {
  const pending: PendingGesture = { kind: "quote", sourceNodeId: "src", anchor };

  it("parents to the current leaf rather than the source", () => {
    const plan = planSubmission({ text: "why?", pending, activeLeafId: "leaf" });
    expect(plan.parentId).toBe("leaf");
    expect(plan.forks).toBe(false);
  });

  it("carries the quote in the policy and the anchor in the origin", () => {
    const plan = planSubmission({ text: "why?", pending, activeLeafId: "leaf" });
    expect(plan.policy).toEqual({
      kind: "quoted",
      quote: "Reingold Tilford",
      base: "full-ancestry",
    });
    expect(plan.origin).toEqual({
      kind: "quote-reply",
      sourceNodeId: "src",
      anchor,
    });
  });

  it("needs the user's own words", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(planIsSendable(plan, pending)).toBe(false);
  });
});

describe("§5.3 isolated selection — forks, inherits nothing", () => {
  const pending: PendingGesture = { kind: "isolated", sourceNodeId: "src", anchor };

  it("parents to the source node, not the leaf", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(plan.parentId).toBe("src");
    expect(plan.forks).toBe(true);
  });

  it("puts the selection in the policy payload", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(plan.policy).toEqual({ kind: "isolated", payload: "Reingold Tilford" });
  });

  it("is sendable with no typed text — the selection is the question", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(planIsSendable(plan, pending)).toBe(true);
  });
});

describe("§5.1 concept lens — forks, narrow window", () => {
  const pending: PendingGesture = {
    kind: "concept",
    sourceNodeId: "src",
    anchor,
    turns: 3,
  };

  it("windows to the source node with the chosen turn count, carrying the passage (P-59)", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(plan.policy).toEqual({ kind: "windowed", turns: 3, upToNodeId: "src", passage: "Reingold Tilford" });
    expect(plan.parentId).toBe("src");
    expect(plan.forks).toBe(true);
  });

  it("falls back to the anchored text as the concept when nothing is typed", () => {
    expect(planSubmission({ text: "", pending, activeLeafId: "leaf" }).content).toBe(
      "Reingold Tilford",
    );
  });

  it("prefers the user's own words when they typed some", () => {
    expect(
      planSubmission({ text: "how does it place nodes?", pending, activeLeafId: "l" })
        .content,
    ).toBe("how does it place nodes?");
  });
});

describe("§5.2 structural crop — forks, point anchor", () => {
  const pending: PendingGesture = {
    kind: "crop",
    sourceNodeId: "src",
    charOffset: 120,
    blockPath: "1",
    discardedChars: 400,
  };

  it("truncates the source at the cut offset", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(plan.policy).toEqual({
      kind: "truncated",
      upToNodeId: "src",
      charOffset: 120,
    });
    expect(plan.parentId).toBe("src");
    expect(plan.forks).toBe(true);
  });

  it("anchors to a zero-length point at the cut, keeping text === the slice", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(plan.origin?.anchor).toEqual({
      start: 120,
      end: 120,
      text: "",
      blockPath: "1",
    });
    const a = plan.origin!.anchor!;
    expect("any source string".slice(a.start, a.end)).toBe(a.text);
  });
});

describe("plan → payload, end to end", () => {
  it("every gesture's plan assembles to the payload its section promises", () => {
    const t = new TreeFixture();
    t.linear(6);
    const src = t.all().at(-1)!;
    const leaf = src.id;

    const cases: Array<[PendingGesture | null, number]> = [
      [null, 13], // full ancestry: 12 nodes + this one
      [{ kind: "quote", sourceNodeId: src.id, anchor }, 13], // extends, full path
      [{ kind: "isolated", sourceNodeId: src.id, anchor }, 1],
      [{ kind: "concept", sourceNodeId: src.id, anchor, turns: 2 }, 1],
      [
        {
          kind: "crop",
          sourceNodeId: src.id,
          charOffset: 6,
          blockPath: "0",
          discardedChars: 7,
        },
        1,
      ],
    ];

    for (const [pending, expected] of cases) {
      const plan = planSubmission({ text: "ask", pending, activeLeafId: leaf });
      const node = draftNode(plan, t.conversationId);
      expect(assembleContext(node, t, T)).toHaveLength(expected);
    }
  });

  it("a gesture opens an aside exactly when its node starts a context of its own", () => {
    // P-27: the aside's promise is kept by the context walk stopping at its
    // root, so the two lists — what forks, what is a root — must never drift.
    const gestures: Array<PendingGesture | null> = [
      null,
      { kind: "quote", sourceNodeId: "src", anchor },
      { kind: "isolated", sourceNodeId: "src", anchor },
      { kind: "concept", sourceNodeId: "src", anchor, turns: 2 },
      { kind: "crop", sourceNodeId: "src", charOffset: 6, blockPath: "0", discardedChars: 7 },
      { kind: "rewind", nodeId: "q", parentId: "src" },
      { kind: "rewind", nodeId: "q", parentId: "src", quote: { sourceNodeId: "src", anchor } },
    ];
    for (const pending of gestures) {
      const plan = planSubmission({ text: "ask", pending, activeLeafId: "leaf" });
      expect(isContextRoot(draftNode(plan, "conv"))).toBe(plan.forks);
    }
  });

  it("the draft node is never persisted-shaped — it has a reserved id", () => {
    const plan = planSubmission({ text: "x", pending: null, activeLeafId: null });
    expect(draftNode(plan, "conv").id).toBe("__draft__");
  });
});

describe("P-44 rewind — asks an earlier question again, under the same reply", () => {
  it("continues the thread from that reply with the whole ancestry, whatever the cursor", () => {
    const t = new TreeFixture();
    const [, a1, q2, , , a3] = t.linear(3);
    const plan = planSubmission({
      text: "  asked differently  ",
      pending: { kind: "rewind", nodeId: q2!.id, parentId: a1!.id },
      activeLeafId: a3!.id,
    });
    expect(plan).toEqual({
      parentId: a1!.id,
      policy: { kind: "full-ancestry" },
      origin: { kind: "continuation", sourceNodeId: a1!.id },
      content: "asked differently",
      forks: false,
    });
    expect(assembleContext(draftNode(plan, t.conversationId), t, T)).toHaveLength(3);
  });

  it("keeps the quote of a quote reply it asks again", () => {
    const plan = planSubmission({
      text: "why?",
      pending: { kind: "rewind", nodeId: "q", parentId: "a", quote: { sourceNodeId: "a", anchor } },
      activeLeafId: null,
    });
    expect(plan.policy).toEqual({ kind: "quoted", quote: anchor.text, base: "full-ancestry" });
    expect(plan.origin).toEqual({ kind: "quote-reply", sourceNodeId: "a", anchor });
    expect(gestureOpensAside({ kind: "rewind", nodeId: "q", parentId: "a" })).toBe(false);
  });
});

describe("P-44 asking again — what goes back into the box", () => {
  it("is the question as it was asked: words, files, and only the choices it set itself", () => {
    const t = new TreeFixture();
    const q = t.add("user", "What is this?", null);
    expect(askAgainSeed(q)).toEqual({ text: "What is this?", attachments: [], model: null, effort: null, pacing: null });
    const file = { id: "f", kind: "text" as const, name: "a.md", mediaType: "text/plain", bytes: 1, data: "x" };
    Object.assign(q, { attachments: [file], model: "opus", effort: "high", pacing: false });
    expect(askAgainSeed(q)).toEqual({ text: "What is this?", attachments: [file], model: "opus", effort: "high", pacing: false });
  });

  it("a first question asked again gets a new conversation set up like the old one", () => {
    const base = { id: "c", title: "Old", createdAt: 1, updatedAt: 1, rootId: null, activeNodeId: null };
    expect(restartedConversation(undefined)).toEqual({});
    expect(restartedConversation({ ...base, titleSource: "set" })).toEqual({});
    expect(restartedConversation({ ...base, pacing: false })).toEqual({ pacing: false });
    const project = { slug: "osmo", snapshot: "s1", name: "osmo dock" };
    expect(restartedConversation({ ...base, project })).toEqual({
      project,
      title: "Learning: osmo dock",
      titleSource: "set",
    });
  });
});
