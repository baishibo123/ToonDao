import type { NodeId, ProviderConfig } from "@/types";
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
