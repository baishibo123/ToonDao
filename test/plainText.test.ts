/**
 * A passage as a label reads it. The cases are the sidebar rows that showed
 * their source (2026-11-15).
 */
import { describe, expect, it } from "vitest";
import { plainText } from "@/lib/plainText";
import { branchLabel } from "@/lib/outline";
import type { ConversationNode } from "@/types";

describe("a passage as a label", () => {
  it("drops emphasis, list markers and math delimiters", () => {
    expect(plainText("**im2col**")).toBe("im2col");
    expect(plainText("- 一层里通常有很多 kernel")).toBe("一层里通常有很多 kernel");
    expect(plainText("输入 $X$ 有 $C$ 个通道")).toBe("输入 X 有 C 个通道");
    expect(plainText("**1. Input layer 不是一层**")).toBe("1. Input layer 不是一层");
  });

  it("reads a formula the way it is shown", () => {
    expect(plainText("$$ \\text{FLOPs} = 2 \\times C_{in} \\cdot K^2 $$").trim()).toBe("FLOPs = 2 × C_in · K^2");
    expect(plainText("$\\alpha \\le \\mathbf{w}$")).toBe("α ≤ w");
  });

  it("keeps what only looks like Markdown", () => {
    expect(plainText("a * b")).toBe("a * b");
    expect(plainText("__init__ and x_i")).toBe("__init__ and x_i");
    expect(plainText("costs \\$5 and \\*not\\* bold")).toBe("costs $5 and *not* bold");
  });

  it("keeps a link's words and a code span's text", () => {
    expect(plainText("see [the paper](https://arxiv.org/abs/1) and `torch.nn`")).toBe("see the paper and torch.nn");
    expect(plainText("## Heading\n> quoted")).toBe("Heading\nquoted");
  });

  it("names a branch in the sidebar", () => {
    const node = {
      id: "u", conversationId: "c", parentId: "a", childrenIds: [], role: "user", content: "what is it?",
      createdAt: 0, status: "complete", contextPolicy: { kind: "isolated", payload: "" },
      origin: { kind: "isolated-selection", sourceNodeId: "a", anchor: { start: 0, end: 10, text: "**im2col**" } },
    } as unknown as ConversationNode;
    expect(branchLabel(node)).toBe("im2col");
  });
});
