import type { ConversationNode, NodeStore } from "@/types";
import type { ProjectRef, ToolScope } from "@/lib/bridgeProtocol";
import { contextStart } from "@/lib/assembleContext";

/** What a request may reach beyond the text ToonDao assembled. */
export interface ToolGrant {
  /** The web: `research` lets it search and read pages. */
  scope: ToolScope;
  /** A project snapshot it may read, when the conversation learns from one (P-31). */
  project: ProjectRef | null;
}

/**
 * Whether a request may reach outside the text ToonDao assembled — decided by
 * the message's context policy, in this one place.
 *
 * An outside source is context too: a web search result or a file from the
 * project sits in the prompt as surely as an earlier turn does. So the rule
 * follows what each policy promises:
 *
 *   isolated    "nothing but this passage"          → nothing
 *   truncated   "the conversation, up to the cut"   → nothing; it is about the
 *                                                     conversation's own reasoning
 *   windowed    "what does this term mean"          → the web, and the project
 *                                                     when there is one: a term is
 *                                                     best shown in the reader's own code
 *   full-ancestry, quoted                           → the project when there is
 *                                                     one; the web if the reader
 *                                                     turned it on
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
  project: ProjectRef | null = null,
): ToolGrant {
  const policy = (contextStart(node, store) ?? node).contextPolicy;
  switch (policy.kind) {
    case "isolated":
    case "truncated":
      return { scope: "none", project: null };
    case "windowed":
      return { scope: "research", project };
    case "full-ancestry":
    case "quoted":
      return { scope: chatTools ? "research" : "none", project };
  }
}
