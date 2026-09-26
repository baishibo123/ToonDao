import Dexie, { type EntityTable } from "dexie";
import type {
  Conversation,
  ConversationNode,
  PromptTemplate,
  ProviderConfig,
  Settings,
  TemplateId,
  TemplateSet,
} from "@/types";
import { DEFAULT_TEMPLATES } from "@/lib/templates";

/**
 * IndexedDB via Dexie. Message data never touches localStorage (§7).
 *
 * `nodes` is indexed on [conversationId+parentId] so the tree can be loaded by
 * conversation and children fetched by parent without a full scan.
 */
class ToonDaoDB extends Dexie {
  conversations!: EntityTable<Conversation, "id">;
  nodes!: EntityTable<ConversationNode, "id">;
  templates!: EntityTable<PromptTemplate, "id">;
  settings!: EntityTable<Settings, "id">;

  constructor() {
    super("toondao");
    this.version(1).stores({
      conversations: "id, updatedAt, createdAt",
      nodes: "id, conversationId, [conversationId+parentId], parentId, createdAt",
      templates: "id",
      settings: "id",
    });
  }
}

export const db = new ToonDaoDB();

export const DEFAULT_SETTINGS: Settings = {
  id: "singleton",
  providers: [
    {
      id: "openai",
      kind: "openai-compatible",
      label: "OpenAI-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      knownModels: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o4-mini"],
    },
    {
      id: "anthropic",
      kind: "anthropic",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "",
      model: "claude-sonnet-5",
      knownModels: [
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-haiku-4-5-20251001",
      ],
    },
    {
      id: "local",
      kind: "openai-compatible",
      label: "Local / relay (中转)",
      // Ollama's default. llama.cpp is :8080, LM Studio :1234, vLLM :8000 —
      // all OpenAI-compatible, so only the base URL changes.
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "llama3.1",
      knownModels: [],
    },
    {
      // OpenRouter speaks the OpenAI wire format and returns
      // `access-control-allow-origin: *` with `Authorization` in its allowed
      // headers, so a browser client reaches it directly with no proxy. Model
      // ids are namespaced by vendor, which is why `model` looks unlike the
      // other presets. Verified against openrouter.ai/api/v1/models.
      id: "openrouter",
      kind: "openai-compatible",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      model: "anthropic/claude-haiku-4.5",
      knownModels: [
        "anthropic/claude-haiku-4.5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5",
        "anthropic/claude-fable-5",
        "openai/gpt-5",
        "google/gemini-3.5-flash",
        "deepseek/deepseek-chat",
      ],
    },
    {
      // A Claude subscription instead of an API key: `npm run bridge` runs the
      // user's own signed-in Claude Code behind this URL (bridge/claude-code.ts).
      // No key, by design — the bridge never handles a credential. Model names
      // are Claude Code's aliases, so they follow whatever it currently maps
      // them to.
      id: "claude-code",
      kind: "claude-code",
      label: "Claude Code (local bridge)",
      baseUrl: "http://127.0.0.1:8788/v1",
      apiKey: "",
      model: "opus",
      knownModels: ["opus", "sonnet", "haiku", "fable"],
    },
    {
      // Pre-wired for `npm run dev:mock`. Present so that trying the app
      // without a key is "pick this provider" and nothing else — telling
      // someone to select a preset and *also* retype its base URL is one
      // un-obvious step away from a bare "failed to fetch".
      id: "mock",
      kind: "openai-compatible",
      label: "Mock server (dev, no key)",
      baseUrl: "http://localhost:8787/v1",
      apiKey: "",
      model: "mock-1",
      knownModels: ["mock-1"],
    },
  ],
  activeProviderId: "openai",
  systemPrompt: "",
  // On by default, and merged into existing profiles by ensureSeeded(): the
  // point is that answers arrive at a readable size without anyone having to
  // know the setting exists. One checkbox turns it off.
  pacing: true,
  chatTools: false,
  conceptLensTurns: 2,
  temperature: 0.7,
  maxTokens: null,
};

/** Seed templates and settings on first run. Idempotent. */
export async function ensureSeeded(): Promise<void> {
  await db.transaction("rw", db.templates, db.settings, async () => {
    const existing = await db.templates.count();
    if (existing === 0) {
      const now = Date.now();
      await db.templates.bulkAdd(
        (Object.keys(DEFAULT_TEMPLATES) as TemplateId[]).map((id) => ({
          id,
          body: DEFAULT_TEMPLATES[id],
          updatedAt: now,
        })),
      );
    }
    const settings = await db.settings.get("singleton");
    if (!settings) {
      await db.settings.put(DEFAULT_SETTINGS);
    } else {
      // Fill in fields added by a later version without clobbering user edits.
      // `providers` needs a per-id merge rather than the shallow spread: the
      // stored array would otherwise replace the defaults wholesale, so a
      // preset added in a later version could never reach an existing profile.
      await db.settings.put({
        ...DEFAULT_SETTINGS,
        ...settings,
        providers: mergeProviders(settings.providers ?? []),
      });
    }
  });
}

/**
 * Keep every provider the user has (with their edited URLs, keys and models),
 * add any default preset they do not have yet, and preserve the default
 * ordering so the list does not reshuffle between versions.
 */
export function mergeProviders(stored: ProviderConfig[]): ProviderConfig[] {
  const byId = new Map(stored.map((provider) => [provider.id, provider]));
  const merged: ProviderConfig[] = [];
  for (const preset of DEFAULT_SETTINGS.providers) {
    const existing = byId.get(preset.id);
    merged.push(
      existing
        ? // Adopt new knownModels, but never overwrite what the user typed.
          { ...preset, ...existing, knownModels: existing.knownModels?.length ? existing.knownModels : preset.knownModels }
        : preset,
    );
    byId.delete(preset.id);
  }
  // Anything the user added themselves keeps its place at the end.
  for (const custom of byId.values()) merged.push(custom);
  return merged;
}

export async function loadTemplateSet(): Promise<TemplateSet> {
  const rows = await db.templates.toArray();
  const set = { ...DEFAULT_TEMPLATES };
  for (const row of rows) {
    if (row.id in set) set[row.id] = row.body;
  }
  return set;
}
