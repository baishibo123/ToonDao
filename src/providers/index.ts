import type { ProviderConfig } from "@/types";
import type { Provider } from "./types";
import { createOpenAICompatibleProvider } from "./openai";
import { createAnthropicProvider } from "./anthropic";

/**
 * The only place vendor identity is resolved. Everything above this line takes
 * a `Provider` and asks it to stream; model-agnostic is non-negotiable (§7).
 */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case "anthropic":
      return createAnthropicProvider(config);
    case "openai-compatible":
      return createOpenAICompatibleProvider(config);
  }
}

export type { ChatOpts, Delta, Provider } from "./types";
export { ProviderError } from "./types";
