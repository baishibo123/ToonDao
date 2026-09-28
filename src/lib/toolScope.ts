import type { ConversationNode, NodeStore } from "@/types";
import type { ToolScope } from "@/lib/bridgeProtocol";
import { contextStart } from "@/lib/assembleContext";

/**
 * Whether a request may reach outside the text ToonDao assembled — decided by
 * the message's context policy, in this one place.
 *
 * An outside source is context too: a web search result sits in the prompt as
 * surely as an earlier turn does. So the rule follows what each policy promises:
 *
 *   isolated    "nothing but this passage"          → never
 *   truncated   "the conversation, up to the cut"   → never; it is about the
 *                                                     conversation's own reasoning
 *   windowed    "what does this term mean"          → always; looking a concept
 *                                                     up is where sources help most
 *   full-ancestry, quoted                           → the reader's choice
 *
 * Inside an aside, every turn is under the promise of the move that opened it
 * (P-27): an Explain aside may keep looking things up, and a Just this or Lost
 * me here aside never can, whatever the setting. The setting decides the thread.
 *
 * Only the Claude Code bridge honours this; other providers have no tools.
 */
export function toolScopeFor(
  node: ConversationNode,
  store: NodeStore,
  chatTools: boolean,
): ToolScope {
  const policy = (contextStart(node, store) ?? node).contextPolicy;
  switch (policy.kind) {
    case "isolated":
    case "truncated":
      return "none";
    case "windowed":
      return "research";
    case "full-ancestry":
    case "quoted":
      return chatTools ? "research" : "none";
  }
}
