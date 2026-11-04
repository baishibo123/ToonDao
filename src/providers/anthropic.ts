import type { ChatMessage, ProviderConfig } from "@/types";
import { ProviderError, type ChatOpts, type Delta, type Provider } from "./types";
import { readSSE } from "./sse";
import { asProviderError, errorDetail, joinUrl } from "./openai";
import { claudeContent } from "./content";
import type { WireBlock } from "@/lib/bridgeProtocol";

/**
 * Native Anthropic adapter — POST /v1/messages, SSE.
 *
 * The wire format differs from OpenAI's in two ways that matter here: the
 * system prompt is a top-level field rather than a message, and deltas arrive
 * as typed events rather than choice deltas. Both are contained inside this
 * file; nothing above the Provider interface knows which vendor is answering.
 */
export function createAnthropicProvider(config: ProviderConfig): Provider {
  return {
    id: config.id,
    async *streamChat(messages: ChatMessage[], opts: ChatOpts): AsyncIterable<Delta> {
      const url = joinUrl(config.baseUrl, "v1/messages");
      const { system, turns } = splitSystem(messages);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          // Required for browser-originated requests.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: opts.model,
          messages: turns,
          ...(system ? { system } : {}),
          max_tokens: opts.maxTokens ?? 4096,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          stream: true,
        }),
        signal: opts.signal,
      }).catch((err: unknown) => {
        throw asProviderError(err, url);
      });

      if (!res.ok || !res.body) {
        throw new ProviderError(
          `${res.status} ${res.statusText}${await errorDetail(res)}`,
          res.status,
        );
      }

      for await (const { data } of readSSE(res.body, opts.signal)) {
        let parsed: AnthropicEvent;
        try {
          parsed = JSON.parse(data) as AnthropicEvent;
        } catch {
          continue;
        }
        if (parsed.type === "error") {
          throw new ProviderError(parsed.error?.message ?? "provider error");
        }
        if (parsed.type === "message_stop") return;
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          const text = parsed.delta.text;
          if (text) yield { text };
        }
      }
    },
  };
}

interface AnthropicEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { message?: string };
}

/**
 * Anthropic takes the system prompt out of band. Multiple system messages are
 * joined rather than dropped — assembleContext() only ever emits one, but a
 * user-edited template could in principle produce more.
 */
export function splitSystem(messages: ChatMessage[]): {
  system: string;
  turns: Array<{ role: "user" | "assistant"; content: string | WireBlock[] }>;
} {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages
    .filter((m): m is ChatMessage & { role: "user" | "assistant" } => m.role !== "system")
    .map((m) => ({ role: m.role, content: claudeContent(m) }));
  return { system, turns };
}
