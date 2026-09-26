import type { ChatMessage, ProviderConfig } from "@/types";
import type { RateLimit, ToolScope, ToolUse, Usage } from "@/lib/bridgeProtocol";

export interface ChatOpts {
  model: string;
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
  /** What the request may reach beyond the assembled text. Adapters without
   *  tools ignore it. */
  toolScope?: ToolScope;
}

export interface Delta {
  /** Incremental text. Empty string is legal (keepalive, or a delta that only
   *  carries one of the fields below). */
  text: string;
  /** A tool the model used while answering. */
  tool?: ToolUse;
  /** The account's usage window, as last reported. */
  rateLimit?: RateLimit;
  /** Token usage for the whole request, reported once at the end. */
  usage?: Usage;
  /** The model that actually answered, when the provider resolves aliases. */
  model?: string;
}

export interface Provider {
  id: string;
  streamChat(messages: ChatMessage[], opts: ChatOpts): AsyncIterable<Delta>;
}

export type ProviderFactory = (config: ProviderConfig) => Provider;

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
