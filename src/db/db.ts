import Dexie, { type EntityTable } from "dexie";
import type {
  Conversation,
  ConversationNode,
  PromptTemplate,
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
      baseUrl: "http://localhost:11434/v1",
      apiKey: "",
      model: "llama3.1",
      knownModels: [],
    },
  ],
  activeProviderId: "openai",
  systemPrompt: "",
  conceptLensTurns: 2,
  temperature: 0.7,
  maxTokens: null,
  treePanel: { x: 0, y: 0, width: 460, height: 520, collapsed: false },
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
      await db.settings.put({ ...DEFAULT_SETTINGS, ...settings });
    }
  });
}

export async function loadTemplateSet(): Promise<TemplateSet> {
  const rows = await db.templates.toArray();
  const set = { ...DEFAULT_TEMPLATES };
  for (const row of rows) {
    if (row.id in set) set[row.id] = row.body;
  }
  return set;
}
