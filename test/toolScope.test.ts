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
    expect(toolScopeFor(root, t, true)).toBe("none");
  });

  it("never lets Lost me here reach outside — it explains the conversation's own reasoning", () => {
    const { t, answer, open } = thread();
    const { root } = open(CROP(answer), "structural-crop");
    expect(toolScopeFor(root, t, true)).toBe("none");
  });

  it("always lets Explain look things up", () => {
    const { t, answer, open } = thread();
    const { root } = open(EXPLAIN(answer), "concept-lens");
    expect(toolScopeFor(root, t, false)).toBe("research");
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
      expect(toolScopeFor(node, t, false)).toBe("none");
      expect(toolScopeFor(node, t, true)).toBe("research");
    }
  });
});

describe("inside an aside, the opening move decides (P-27)", () => {
  it("lets a follow-up in an Explain aside keep looking things up with the setting off", () => {
    const { t, answer, open } = thread();
    const { followUp } = open(EXPLAIN(answer), "concept-lens");
    expect(toolScopeFor(followUp, t, false)).toBe("research");
  });

  it("keeps a follow-up in a Just this or Lost me here aside offline with the setting on", () => {
    const { t, answer, open } = thread();
    expect(toolScopeFor(open(JUST_THIS, "isolated-selection").followUp, t, true)).toBe("none");
    expect(toolScopeFor(open(CROP(answer), "structural-crop").followUp, t, true)).toBe("none");
  });

  it("gives an aside inside an aside its own opening move's scope", () => {
    const { t, open } = thread();
    const { followUp } = open(JUST_THIS, "isolated-selection");
    const nested = t.add("user", "term", followUp.id, EXPLAIN(followUp), "concept-lens");
    expect(toolScopeFor(nested, t, false)).toBe("research");
  });
});
