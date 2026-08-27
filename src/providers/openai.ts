import type { ChatMessage, ProviderConfig } from "@/types";
import { ProviderError, type ChatOpts, type Delta, type Provider } from "./types";
import { readSSE } from "./sse";

/**
 * OpenAI-compatible adapter — the lingua franca. POST /chat/completions, SSE.
 *
 * Covers OpenAI, most local runtimes (Ollama, llama.cpp, LM Studio, vLLM) and
 * every relay / 中转 endpoint, because they all speak this shape. Base URL is
 * user-configurable, which is the only reason that is true.
 */
export function createOpenAICompatibleProvider(config: ProviderConfig): Provider {
  return {
    id: config.id,
    async *streamChat(messages: ChatMessage[], opts: ChatOpts): AsyncIterable<Delta> {
      const url = joinUrl(config.baseUrl, "chat/completions");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        stream: true,
      };
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.maxTokens) body.max_tokens = opts.maxTokens;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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
        if (data === "[DONE]") return;
        let parsed: OpenAIChunk;
        try {
          parsed = JSON.parse(data) as OpenAIChunk;
        } catch {
          continue; // a relay sent something non-JSON; ignore rather than die
        }
        if (parsed.error) {
          throw new ProviderError(parsed.error.message ?? "provider error");
        }
        const text = parsed.choices?.[0]?.delta?.content;
        if (typeof text === "string" && text.length > 0) yield { text };
      }
    },
  };
}

interface OpenAIChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  error?: { message?: string };
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

export async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      const message = json.error?.message;
      if (message) return ` — ${message}`;
    } catch {
      /* fall through to raw text */
    }
    return ` — ${text.slice(0, 300)}`;
  } catch {
    return "";
  }
}

export function asProviderError(err: unknown, url: string): ProviderError {
  if (err instanceof DOMException && err.name === "AbortError") throw err;
  const reason = err instanceof Error ? err.message : String(err);
  return new ProviderError(
    `Could not reach ${url} (${reason}). Check the base URL, and that the endpoint sends CORS headers for a browser client.`,
  );
}
