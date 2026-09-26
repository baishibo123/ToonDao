import type { ChatMessage, ProviderConfig } from "@/types";
import { ProviderError, type ChatOpts, type Delta, type Provider } from "./types";
import { readSSE } from "./sse";
import { errorDetail, joinUrl } from "./openai";
import { decodeBridgeFrame, type BridgeRequest } from "@/lib/bridgeProtocol";

/**
 * The Claude Code bridge (bridge/claude-code.ts), as a provider.
 *
 * On the wire it is the OpenAI-compatible adapter plus one request field — the
 * tool scope the message's policy allows — and three named events coming back:
 * the tools the model used, the account's usage window, and the token count.
 * Decoding goes through the same file the bridge encodes with, so the two ends
 * cannot drift.
 */
export function createClaudeCodeProvider(config: ProviderConfig): Provider {
  return {
    id: config.id,
    async *streamChat(messages: ChatMessage[], opts: ChatOpts): AsyncIterable<Delta> {
      const url = joinUrl(config.baseUrl, "chat/completions");
      const body: BridgeRequest = {
        model: opts.model,
        messages,
        stream: true,
        toondao: { toolScope: opts.toolScope ?? "none" },
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      }).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        throw new ProviderError(
          `Could not reach the Claude Code bridge at ${url}. Start it with: npm run bridge`,
        );
      });

      if (!res.ok || !res.body) {
        throw new ProviderError(`${res.status} ${res.statusText}${await errorDetail(res)}`, res.status);
      }

      for await (const { event, data } of readSSE(res.body, opts.signal)) {
        const frame = decodeBridgeFrame(event, data);
        if (!frame) continue;
        switch (frame.kind) {
          case "done":
            return;
          case "error":
            throw new ProviderError(frame.message);
          case "text":
            yield { text: frame.text };
            break;
          case "tool":
            yield { text: "", tool: frame.tool };
            break;
          case "rate":
            yield { text: "", rateLimit: frame.rateLimit };
            break;
          case "usage":
            yield { text: "", usage: frame.usage };
            break;
        }
      }
    },
  };
}

/** What the bridge says about the Claude Code it drives. Asking costs nothing. */
export interface BridgeHealth {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  subscriptionType: string | null;
  orgName: string | null;
}

export async function fetchBridgeHealth(baseUrl: string, signal?: AbortSignal): Promise<BridgeHealth | null> {
  try {
    const res = await fetch(joinUrl(baseUrl, "health"), { ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    return (await res.json()) as BridgeHealth;
  } catch {
    return null;
  }
}
