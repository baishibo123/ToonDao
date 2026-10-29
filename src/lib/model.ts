import type { NodeId, ProviderConfig } from "@/types";
import type { Effort } from "@/lib/bridgeProtocol";
import type { NodeMap } from "@/lib/tree";

/**
 * The model a new message in this branch should use (§8 P3).
 *
 * A per-branch override is recorded on the user node that chose it, and found by
 * walking up the lineage — that is what makes it per-*branch*. But a model name
 * belongs to a provider: `anthropic/claude-opus-5` is an OpenRouter id, and
 * handed to another provider it is at best an error. So an override is inherited
 * only if the active provider offers it — in its model list, or as its default —
 * and one it does not offer is skipped, so an earlier override that does still
 * applies. With none, the provider's own default is the answer.
 */
export function branchModel(
  nodes: NodeMap,
  nodeId: NodeId | null,
  provider: Pick<ProviderConfig, "model" | "knownModels"> | undefined,
): string | undefined {
  const offers = (model: string) =>
    !provider || model === provider.model || provider.knownModels.includes(model);
  let cursor = nodeId;
  const seen = new Set<NodeId>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = nodes[cursor];
    if (!node) break;
    if (node.role === "user" && node.model && offers(node.model)) return node.model;
    cursor = node.parentId;
  }
  return provider?.model;
}

/**
 * The thinking effort a new message in this branch should use (P-36): the
 * nearest choice recorded on a user node up the lineage, exactly as a model
 * override is found. Undefined means none was chosen, and Claude Code uses its
 * own default.
 */
export function branchEffort(nodes: NodeMap, nodeId: NodeId | null): Effort | undefined {
  let cursor = nodeId;
  const seen = new Set<NodeId>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = nodes[cursor];
    if (!node) break;
    if (node.role === "user" && node.effort) return node.effort;
    cursor = node.parentId;
  }
  return undefined;
}

/**
 * Whether Pace answers applies at this point of a branch (P-37): the nearest
 * question up the lineage that switched it, else the conversation's own value,
 * else the app's default. Walking lineage, not context, so an aside inherits
 * the switch of the thread it left — and can switch it for itself, because a
 * simple side question does not need a lesson.
 */
export function branchPacing(
  nodes: NodeMap,
  nodeId: NodeId | null,
  conversationPacing: boolean | undefined,
  appDefault: boolean,
): boolean {
  let cursor = nodeId;
  const seen = new Set<NodeId>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node = nodes[cursor];
    if (!node) break;
    if (node.role === "user" && typeof node.pacing === "boolean") return node.pacing;
    cursor = node.parentId;
  }
  return conversationPacing ?? appDefault;
}
