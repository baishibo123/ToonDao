/**
 * Which requests may reach outside the text ToonDao assembled. An outside
 * source is context too, so the rule is each policy's own promise, restated —
 * and inside an aside, the promise of the move that opened it (P-27).
 */
import { describe, expect, it } from "vitest";
import { toolScopeFor } from "@/lib/toolScope";
import { TreeFixture } from "./helpers";
import type { BranchKind, ContextPolicy, ConversationNode } from "@/types";

/** A thread of two turns, and a way to open an aside from its last answer. */
function thread() {
  const t = new TreeFixture();
  t.linear(2);
  const answer = t.all().at(-1)!;
  const open = (policy: ContextPolicy, kind: BranchKind) => {
    const root = t.add("user", "ask", answer.id, policy, kind);
    const reply = t.add("assistant", "reply", root.id);
    const followUp = t.add("user", "and then?", reply.id);
    return { root, followUp };
  };
  return { t, answer, open };
}

const EXPLAIN = (upTo: ConversationNode): ContextPolicy => ({
  kind: "windowed",
  turns: 2,
  upToNodeId: upTo.id,
});
const JUST_THIS: ContextPolicy = { kind: "isolated", payload: "x" };
const CROP = (upTo: ConversationNode): ContextPolicy => ({
  kind: "truncated",
  upToNodeId: upTo.id,
  charOffset: 3,
});

describe("tool scope follows the policy", () => {
  it("never lets Just this reach outside — its promise is nothing but the passage", () => {
    const { t, open } = thread();
    const { root } = open(JUST_THIS, "isolated-selection");
    expect(toolScopeFor(root, t, true).scope).toBe("none");
  });

  it("never lets Lost me here reach outside — it explains the conversation's own reasoning", () => {
    const { t, answer, open } = thread();
    const { root } = open(CROP(answer), "structural-crop");
    expect(toolScopeFor(root, t, true).scope).toBe("none");
  });

  it("always lets Explain look things up", () => {
    const { t, answer, open } = thread();
    const { root } = open(EXPLAIN(answer), "concept-lens");
    expect(toolScopeFor(root, t, false).scope).toBe("research");
  });

  it("leaves the thread's replies and quotes to the reader's setting", () => {
    const { t, answer } = thread();
    const reply = t.add("user", "next", answer.id);
    const quote = t.add("user", "why?", answer.id, {
      kind: "quoted",
      quote: "q",
      base: "full-ancestry",
    });
    for (const node of [reply, quote]) {
      expect(toolScopeFor(node, t, false).scope).toBe("none");
      expect(toolScopeFor(node, t, true).scope).toBe("research");
    }
  });
});

describe("inside an aside, the opening move decides (P-27)", () => {
  it("lets a follow-up in an Explain aside keep looking things up with the setting off", () => {
    const { t, answer, open } = thread();
    const { followUp } = open(EXPLAIN(answer), "concept-lens");
    expect(toolScopeFor(followUp, t, false).scope).toBe("research");
  });

  it("keeps a follow-up in a Just this or Lost me here aside offline with the setting on", () => {
    const { t, answer, open } = thread();
    expect(toolScopeFor(open(JUST_THIS, "isolated-selection").followUp, t, true).scope).toBe("none");
    expect(toolScopeFor(open(CROP(answer), "structural-crop").followUp, t, true).scope).toBe("none");
  });

  it("gives an aside inside an aside its own opening move's scope", () => {
    const { t, open } = thread();
    const { followUp } = open(JUST_THIS, "isolated-selection");
    const nested = t.add("user", "term", followUp.id, EXPLAIN(followUp), "concept-lens");
    expect(toolScopeFor(nested, t, false).scope).toBe("research");
  });
});

describe("a conversation that learns from a project (P-31)", () => {
  const PROJECT = { slug: "osmo-dock", snapshot: "2026-10-07T22-44-00Z" };

  it("lets the thread read the snapshot, with the web still the reader's choice", () => {
    const { t, answer } = thread();
    const reply = t.add("user", "next", answer.id);
    expect(toolScopeFor(reply, t, false, PROJECT)).toEqual({ scope: "none", project: PROJECT });
    expect(toolScopeFor(reply, t, true, PROJECT)).toEqual({ scope: "research", project: PROJECT });
  });

  it("lets Explain use the web and the snapshot, and decide which it needs", () => {
    const { t, answer, open } = thread();
    const { root, followUp } = open(EXPLAIN(answer), "concept-lens");
    for (const node of [root, followUp]) {
      expect(toolScopeFor(node, t, false, PROJECT)).toEqual({ scope: "research", project: PROJECT });
    }
  });

  it("keeps Just this and Lost me here away from the snapshot too", () => {
    const { t, answer, open } = thread();
    for (const { root, followUp } of [open(JUST_THIS, "isolated-selection"), open(CROP(answer), "structural-crop")]) {
      expect(toolScopeFor(root, t, true, PROJECT)).toEqual({ scope: "none", project: null });
      expect(toolScopeFor(followUp, t, true, PROJECT)).toEqual({ scope: "none", project: null });
    }
  });

  it("grants no snapshot when the conversation has none", () => {
    const { t, answer } = thread();
    expect(toolScopeFor(t.add("user", "next", answer.id), t, true).project).toBeNull();
  });
});
