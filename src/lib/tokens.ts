import type { ChatMessage } from "@/types";

/**
 * §11 Q3 — cheap heuristic, always labelled with a `~`.
 *
 * An exact per-provider tokenizer costs a large WASM download and buys nothing:
 * the inspector's job is to show the user *which messages* are in the payload,
 * not to bill them. Revisit if a hard context-limit UI is ever added.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: ChatMessage[]): number {
  // +4 per message is the usual rough allowance for role framing.
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + 4,
    0,
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return `~${n} tok`;
  return `~${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k tok`;
}
