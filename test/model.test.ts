/**
 * Which model a new message uses. A per-branch override is found by walking up
 * the lineage, but a model name belongs to a provider — so an override the
 * active provider does not offer must not be inherited.
 */
import { describe, expect, it } from "vitest";
import { branchModel } from "@/lib/model";
import type { NodeMap } from "@/lib/tree";
import { TreeFixture } from "./helpers";

const CLAUDE_CODE = { model: "opus", knownModels: ["claude-opus-5-5", "claude-opus-5", "opus", "sonnet"] };

function mapOf(t: TreeFixture): NodeMap {
  const out: NodeMap = {};
  for (const node of t.all()) out[node.id] = node;
  return out;
}

describe("the model for a branch", () => {
  it("is the provider's default when nothing in the branch chose one", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    expect(branchModel(mapOf(t), made.at(-1)!.id, CLAUDE_CODE)).toBe("opus");
  });

  it("inherits an override the active provider offers", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    made[2].model = "claude-opus-5-5"; // the second question chose it
    expect(branchModel(mapOf(t), made.at(-1)!.id, CLAUDE_CODE)).toBe("claude-opus-5-5");
  });

  it("does not carry another provider's model name across a provider switch", () => {
    const t = new TreeFixture();
    const made = t.linear(2);
    made[2].model = "anthropic/claude-opus-5"; // chosen while OpenRouter was active
    expect(branchModel(mapOf(t), made.at(-1)!.id, CLAUDE_CODE)).toBe("opus");
  });

  it("skips a foreign override but still finds an earlier one that applies", () => {
    const t = new TreeFixture();
    const made = t.linear(3);
    made[0].model = "sonnet";
    made[4].model = "anthropic/claude-opus-5";
    expect(branchModel(mapOf(t), made.at(-1)!.id, CLAUDE_CODE)).toBe("sonnet");
  });

  it("takes an override that is the provider's own default", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    made[0].model = "opus";
    expect(branchModel(mapOf(t), made[1].id, { model: "opus", knownModels: [] })).toBe("opus");
  });

  it("with no active provider, still reports the override rather than nothing", () => {
    const t = new TreeFixture();
    const made = t.linear(1);
    made[0].model = "claude-opus-5";
    expect(branchModel(mapOf(t), made[1].id, undefined)).toBe("claude-opus-5");
  });
});
