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

/**
 * A failed `fetch` from a browser is deliberately opaque: the same "Failed to
 * fetch" covers nothing listening on the port, DNS failure, TLS refusal, and a
 * CORS preflight rejection. The browser will not tell us which, so this message
 * does not pretend to know — it names the two or three real possibilities, most
 * likely first, and includes the port so it can be checked directly.
 */
export function asProviderError(err: unknown, url: string): ProviderError {
  if (err instanceof DOMException && err.name === "AbortError") throw err;
  const reason = err instanceof Error ? err.message : String(err);

  let host = "";
  let port = "";
  let isLocal = false;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    /* keep the generic message below */
  }

  const causes = isLocal
    ? [
        `nothing is listening on port ${port}`,
        "the server is running but does not send CORS headers for a browser client",
      ]
    : [
        "the base URL is wrong",
        "the endpoint does not send CORS headers for a browser client",
        "the network or TLS handshake failed",
      ];

  const hint = isLocal
    ? port === "8787"
      ? " To start the bundled dev server: npm run dev:mock"
      : " Check that your local runtime is up and serving an OpenAI-compatible API at this base URL."
    : "";

  return new ProviderError(
    `Could not reach ${url} — ${reason}. A browser cannot tell these apart, so it is one of: ${causes.join("; ")}.${hint}`,
  );
}
