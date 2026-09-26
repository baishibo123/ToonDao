import type { ContextPolicy } from "@/types";
import type { ToolScope } from "@/lib/bridgeProtocol";

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
 * Only the Claude Code bridge honours this; other providers have no tools.
 */
export function toolScopeFor(policy: ContextPolicy, chatTools: boolean): ToolScope {
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
