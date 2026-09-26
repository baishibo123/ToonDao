/**
 * Which requests may reach outside the text ToonDao assembled. An outside
 * source is context too, so the rule is each policy's own promise, restated.
 */
import { describe, expect, it } from "vitest";
import { toolScopeFor } from "@/lib/toolScope";
import type { ContextPolicy } from "@/types";

const POLICIES: Record<ContextPolicy["kind"], ContextPolicy> = {
  "full-ancestry": { kind: "full-ancestry" },
  quoted: { kind: "quoted", quote: "q", base: "full-ancestry" },
  windowed: { kind: "windowed", turns: 2, upToNodeId: "n1" },
  truncated: { kind: "truncated", upToNodeId: "n1", charOffset: 3 },
  isolated: { kind: "isolated", payload: "x" },
};

describe("tool scope follows the policy", () => {
  it("never lets Just this reach outside — its promise is nothing but the passage", () => {
    expect(toolScopeFor(POLICIES.isolated, true)).toBe("none");
  });

  it("never lets Lost me here reach outside — it explains the conversation's own reasoning", () => {
    expect(toolScopeFor(POLICIES.truncated, true)).toBe("none");
  });

  it("always lets Explain look things up", () => {
    expect(toolScopeFor(POLICIES.windowed, false)).toBe("research");
  });

  it("leaves ordinary replies and quotes to the reader's setting", () => {
    for (const kind of ["full-ancestry", "quoted"] as const) {
      expect(toolScopeFor(POLICIES[kind], false)).toBe("none");
      expect(toolScopeFor(POLICIES[kind], true)).toBe("research");
    }
  });
});
