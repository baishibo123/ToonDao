import { describe, expect, it } from "vitest";
import { draftNode, planIsSendable, planSubmission } from "@/lib/draft";
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

  it("windows to the source node with the chosen turn count", () => {
    const plan = planSubmission({ text: "", pending, activeLeafId: "leaf" });
    expect(plan.policy).toEqual({ kind: "windowed", turns: 3, upToNodeId: "src" });
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
