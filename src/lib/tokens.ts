import type { Attachment, ChatMessage } from "@/types";

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
    (sum, m) =>
      sum + estimateTokens(m.content) + 4 + (m.attachments ?? []).reduce((n, a) => n + attachmentTokens(a), 0),
    0,
  );
}

/** What the model is likely to count for it; an estimate, like every count in the app. */
export function attachmentTokens(a: Attachment): number {
  switch (a.kind) {
    case "image":
      // Anthropic's rule of thumb: width × height / 750, for an image within its size limits.
      return Math.ceil(Math.min((a.width ?? 1000) * (a.height ?? 1000), 1_150_000) / 750);
    case "pdf":
      // Each page is read as text and as a picture of the page.
      return (a.pages ?? Math.max(1, Math.round(a.bytes / 100_000))) * 2000;
    case "text":
      return estimateTokens(a.data);
  }
}

export function formatTokens(n: number): string {
  if (n < 1000) return `~${n} tok`;
  return `~${(n / 1000).toFixed(n < 10_000 ? 2 : 1)}k tok`;
}
