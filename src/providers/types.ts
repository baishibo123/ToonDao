import type { ChatMessage, ProviderConfig } from "@/types";

export interface ChatOpts {
  model: string;
  temperature?: number;
  maxTokens?: number | null;
  signal?: AbortSignal;
}

export interface Delta {
  /** Incremental text. Empty string is legal (keepalive). */
  text: string;
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
