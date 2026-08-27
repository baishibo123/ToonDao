import type {
  BranchKind,
  ContextPolicy,
  ConversationNode,
  NodeId,
  NodeStore,
} from "@/types";

/** A tiny in-memory tree builder so the policy tests read as scenarios. */
export class TreeFixture implements NodeStore {
  private nodes = new Map<NodeId, ConversationNode>();
  private counter = 0;
  readonly conversationId = "conv-test";

  get(id: NodeId): ConversationNode | undefined {
    return this.nodes.get(id);
  }

  all(): ConversationNode[] {
    return [...this.nodes.values()];
  }

  add(
    role: "user" | "assistant",
    content: string,
    parentId: NodeId | null,
    policy: ContextPolicy = { kind: "full-ancestry" },
    originKind: BranchKind = "continuation",
  ): ConversationNode {
    const id = `n${++this.counter}`;
    const node: ConversationNode = {
      id,
      conversationId: this.conversationId,
      parentId,
      childrenIds: [],
      role,
      content,
      createdAt: this.counter,
      status: "complete",
      origin: parentId ? { kind: originKind, sourceNodeId: parentId } : null,
      contextPolicy: policy,
    };
    this.nodes.set(id, node);
    if (parentId) this.nodes.get(parentId)?.childrenIds.push(id);
    return node;
  }

  /** `turns` alternating user/assistant pairs on one straight path. */
  linear(turns: number, label = "turn"): ConversationNode[] {
    const made: ConversationNode[] = [];
    let parent: NodeId | null = null;
    for (let i = 1; i <= turns; i++) {
      const u = this.add("user", `question ${label} ${i}`, parent);
      const a = this.add("assistant", `answer ${label} ${i}`, u.id);
      made.push(u, a);
      parent = a.id;
    }
    return made;
  }
}

export const TEMPLATES_UNDER_TEST = {
  concept_lens: `This is the context of our conversation:

{{context_turns}}

And this is the concept I'm curious about:

{{concept}}

Please take into account everything I have said throughout this interaction, and precisely address my confusion about this specific concept, for me.`,
  structural_crop: `Here is our conversation up to the exact point where I got lost:

{{truncated_context}}

I stopped reading right here.`,
  isolated_selection: `{{selection}}

---

Treat the text above as the entire context. Answer only about it.`,
  quote_reply: `{{quote}}

{{message}}`,
};
