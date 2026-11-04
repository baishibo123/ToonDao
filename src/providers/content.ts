import type { ChatMessage } from "@/types";
import type { WireBlock, WireImageType } from "@/lib/bridgeProtocol";

/**
 * A message's files placed beside its text, in each vendor's shape (P-43).
 * This only reshapes what `assembleContext()` assembled: the files a message
 * carries were decided there. Files come first and the text after them, the
 * order Anthropic recommends; a message without files stays a plain string,
 * byte for byte what it was before attachments existed, so prompt caching
 * still matches on it.
 */

/** Anthropic's Messages API, and Claude Code's stdin through the bridge. */
export function claudeContent(m: ChatMessage): string | WireBlock[] {
  if (!m.attachments?.length) return m.content;
  const blocks: WireBlock[] = m.attachments.map((a) =>
    a.kind === "pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data }, title: a.name }
      : { type: "image", source: { type: "base64", media_type: a.mediaType as WireImageType, data: a.data } },
  );
  // An empty text block is refused by the API; a question may be a file alone.
  if (m.content.trim()) blocks.push({ type: "text", text: m.content });
  return blocks;
}

export type OpenAIPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** OpenAI's Chat Completions content parts; endpoints that take no files will say so in their error. */
export function openAIContent(m: ChatMessage): string | OpenAIPart[] {
  if (!m.attachments?.length) return m.content;
  const parts: OpenAIPart[] = m.attachments.map((a) =>
    a.kind === "pdf"
      ? { type: "file", file: { filename: a.name, file_data: `data:application/pdf;base64,${a.data}` } }
      : { type: "image_url", image_url: { url: `data:${a.mediaType};base64,${a.data}` } },
  );
  if (m.content.trim()) parts.push({ type: "text", text: m.content });
  return parts;
}
