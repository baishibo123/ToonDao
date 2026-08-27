import { create } from "zustand";
import type {
  BranchOrigin,
  ChatMessage,
  Conversation,
  ConversationNode,
  ContextPolicy,
  NodeId,
  NodeStore,
  Settings,
  TemplateId,
  TemplateSet,
} from "@/types";
import { DEFAULT_SETTINGS, db, ensureSeeded, loadTemplateSet } from "@/db/db";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { assembleContext, formatPayload } from "@/lib/assembleContext";
import { createProvider } from "@/providers";
import { newId } from "@/lib/id";
import { deepestLeaf, rootsOf, subtreeIds, type NodeMap } from "@/lib/tree";

export interface SubmitRequest {
  /** The human-readable ask. Becomes node.content. */
  text: string;
  parentId: NodeId | null;
  policy: ContextPolicy;
  origin: BranchOrigin | null;
}

interface AppState {
  ready: boolean;
  bootError: string | null;

  conversations: Conversation[];
  conversationId: string | null;
  nodes: NodeMap;
  /** Leaf of the active path. The transcript is pathToRoot(nodes, this). */
  activeNodeId: NodeId | null;
  /** Sticky sibling choices, so switching a variant does not snap back. */
  preferredChild: Record<NodeId, NodeId>;

  templates: TemplateSet;
  settings: Settings;

  streamingNodeId: NodeId | null;
  abort: AbortController | null;

  init: () => Promise<void>;
  newConversation: () => Promise<string>;
  selectConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;

  setActiveNode: (id: NodeId) => void;
  setActiveLeafFrom: (id: NodeId) => void;

  submit: (request: SubmitRequest) => Promise<void>;
  regenerate: (assistantNodeId: NodeId) => Promise<void>;
  stop: () => void;
  deleteSubtree: (id: NodeId) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateTemplate: (id: TemplateId, body: string) => Promise<void>;
  resetTemplate: (id: TemplateId) => Promise<void>;

  nodeStore: () => NodeStore;
  assemble: (node: ConversationNode) => ChatMessage[];
}

let initStarted = false;

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  conversations: [],
  conversationId: null,
  nodes: {},
  activeNodeId: null,
  preferredChild: {},
  templates: DEFAULT_TEMPLATES,
  settings: DEFAULT_SETTINGS,
  streamingNodeId: null,
  abort: null,

  nodeStore: () => {
    const nodes = get().nodes;
    return { get: (id: NodeId) => nodes[id] };
  },

  /** Every prompt in the app comes through here, and this is the only caller
   *  of assembleContext(). No component builds a message array. */
  assemble: (node) =>
    assembleContext(node, get().nodeStore(), get().templates, {
      systemPrompt: get().settings.systemPrompt,
    }),

  init: async () => {
    // StrictMode invokes mount effects twice in development. Without this
    // guard the second pass sees an empty conversation list and seeds a second
    // conversation.
    if (initStarted) return;
    initStarted = true;
    try {
      await ensureSeeded();
      const [conversations, templates, storedSettings] = await Promise.all([
        db.conversations.orderBy("updatedAt").reverse().toArray(),
        loadTemplateSet(),
        db.settings.get("singleton"),
      ]);
      const settings = { ...DEFAULT_SETTINGS, ...(storedSettings ?? {}) };
      set({ conversations, templates, settings, ready: true });

      if (conversations.length > 0) {
        await get().selectConversation(conversations[0].id);
      } else {
        await get().newConversation();
      }
    } catch (err) {
      initStarted = false;
      set({
        ready: true,
        bootError:
          err instanceof Error
            ? err.message
            : "Could not open IndexedDB. Private-browsing windows sometimes block it.",
      });
    }
  },

  newConversation: async () => {
    const conversation: Conversation = {
      id: newId("c"),
      title: "New conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rootId: null,
      activeNodeId: null,
    };
    await db.conversations.put(conversation);
    set((s) => ({
      conversations: [conversation, ...s.conversations],
      conversationId: conversation.id,
      nodes: {},
      activeNodeId: null,
      preferredChild: {},
    }));
    return conversation.id;
  },

  selectConversation: async (id) => {
    get().stop();
    const rows = await db.nodes.where("conversationId").equals(id).toArray();
    const nodes: NodeMap = {};
    for (const row of rows) nodes[row.id] = row;
    const conversation = await db.conversations.get(id);
    const stored = conversation?.activeNodeId;
    const fallback = rootsOf(nodes, id)[0]?.id ?? null;
    const activeNodeId =
      stored && nodes[stored]
        ? stored
        : fallback
          ? deepestLeaf(nodes, fallback)
          : null;
    set({ conversationId: id, nodes, activeNodeId, preferredChild: {} });
  },

  deleteConversation: async (id) => {
    await db.transaction("rw", db.conversations, db.nodes, async () => {
      await db.nodes.where("conversationId").equals(id).delete();
      await db.conversations.delete(id);
    });
    const remaining = get().conversations.filter((c) => c.id !== id);
    set({ conversations: remaining });
    if (get().conversationId === id) {
      if (remaining.length > 0) await get().selectConversation(remaining[0].id);
      else await get().newConversation();
    }
  },

  renameConversation: async (id, title) => {
    const trimmed = title.trim() || "Untitled";
    await db.conversations.update(id, { title: trimmed, updatedAt: Date.now() });
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title: trimmed } : c,
      ),
    }));
  },

  setActiveNode: (id) => {
    const { nodes } = get();
    if (!nodes[id]) return;
    set((s) => ({
      activeNodeId: id,
      preferredChild: withPreferredPath(s.nodes, id, s.preferredChild),
    }));
    void persistActive(get().conversationId, id);
  },

  /** Navigate to a node and continue down to a leaf, so the transcript has a
   *  full path to show. Used by tree clicks and sibling switches. */
  setActiveLeafFrom: (id) => {
    const { nodes, preferredChild } = get();
    if (!nodes[id]) return;
    const next = withPreferredPath(nodes, id, preferredChild);
    const leaf = deepestLeaf(nodes, id, next);
    set({ activeNodeId: leaf, preferredChild: next });
    void persistActive(get().conversationId, leaf);
  },

  submit: async (request) => {
    const conversationId = get().conversationId ?? (await get().newConversation());
    const now = Date.now();

    const userNode: ConversationNode = {
      id: newId("u"),
      conversationId,
      parentId: request.parentId,
      childrenIds: [],
      role: "user",
      content: request.text,
      createdAt: now,
      status: "complete",
      origin: request.origin,
      contextPolicy: request.policy,
    };

    await commitNode(set, get, userNode);

    // Assemble once, here. The payload is recorded on the node before the
    // request goes out, so the inspector shows what was actually sent even if
    // the stream fails (§11 Q4: the preview is historical, never recomputed).
    const messages = get().assemble(userNode);
    const preview = formatPayload(messages);
    await patchNode(set, userNode.id, { assembledPreview: preview });

    await runStream(set, get, {
      conversationId,
      parentId: userNode.id,
      messages,
      preview,
      origin: { kind: "continuation", sourceNodeId: userNode.id },
      policy: request.policy,
    });

    await touchConversation(set, get, conversationId, request.text);
  },

  regenerate: async (assistantNodeId) => {
    const { nodes } = get();
    const target = nodes[assistantNodeId];
    if (!target || target.role !== "assistant" || !target.parentId) return;
    const parent = nodes[target.parentId];
    if (!parent) return;

    const messages = get().assemble(parent);
    await runStream(set, get, {
      conversationId: parent.conversationId,
      parentId: parent.id,
      messages,
      preview: parent.assembledPreview ?? formatPayload(messages),
      origin: { kind: "regenerate", sourceNodeId: assistantNodeId },
      policy: parent.contextPolicy,
    });
  },

  stop: () => {
    const { abort } = get();
    if (abort) abort.abort();
    set({ abort: null, streamingNodeId: null });
  },

  deleteSubtree: async (id) => {
    const { nodes, activeNodeId } = get();
    const node = nodes[id];
    if (!node) return;
    const ids = subtreeIds(nodes, id);
    const idSet = new Set(ids);

    await db.nodes.bulkDelete(ids);
    if (node.parentId && nodes[node.parentId]) {
      const remaining = nodes[node.parentId].childrenIds.filter((c) => c !== id);
      await db.nodes.update(node.parentId, { childrenIds: remaining });
    }

    set((s) => {
      const next: NodeMap = {};
      for (const [key, value] of Object.entries(s.nodes)) {
        if (idSet.has(key)) continue;
        next[key] =
          value.id === node.parentId
            ? { ...value, childrenIds: value.childrenIds.filter((c) => c !== id) }
            : value;
      }
      const stillValid = activeNodeId && !idSet.has(activeNodeId);
      const fallback = node.parentId ?? rootsOf(next, node.conversationId)[0]?.id ?? null;
      return {
        nodes: next,
        activeNodeId: stillValid
          ? activeNodeId
          : fallback
            ? deepestLeaf(next, fallback)
            : null,
      };
    });
  },

  updateSettings: async (patch) => {
    const next = { ...get().settings, ...patch, id: "singleton" as const };
    set({ settings: next });
    await db.settings.put(next);
  },

  updateTemplate: async (id, body) => {
    set((s) => ({ templates: { ...s.templates, [id]: body } }));
    await db.templates.put({ id, body, updatedAt: Date.now() });
  },

  resetTemplate: async (id) => {
    await get().updateTemplate(id, DEFAULT_TEMPLATES[id]);
  },
}));

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

type Setter = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;
type Getter = () => AppState;

interface StreamRequest {
  conversationId: string;
  parentId: NodeId;
  messages: ChatMessage[];
  preview: string;
  origin: BranchOrigin;
  policy: ContextPolicy;
}

/** Persist mid-stream at most this often, so a crash loses at most this much. */
const STREAM_PERSIST_MS = 800;

async function runStream(set: Setter, get: Getter, req: StreamRequest): Promise<void> {
  const settings = get().settings;
  const config = settings.providers.find((p) => p.id === settings.activeProviderId);

  const assistantNode: ConversationNode = {
    id: newId("a"),
    conversationId: req.conversationId,
    parentId: req.parentId,
    childrenIds: [],
    role: "assistant",
    content: "",
    model: config?.model,
    createdAt: Date.now(),
    status: "streaming",
    origin: req.origin,
    // An assistant node does not choose a policy; it records the one that
    // produced it, so the inspector reads the same on both halves of a turn.
    contextPolicy: req.policy,
    assembledPreview: req.preview,
  };

  await commitNode(set, get, assistantNode);

  if (!config) {
    await patchNode(set, assistantNode.id, {
      status: "error",
      error: "No provider configured. Open Settings and add a base URL and key.",
    });
    return;
  }
  if (!config.apiKey && config.kind === "anthropic") {
    await patchNode(set, assistantNode.id, {
      status: "error",
      error: "Anthropic requires an API key. Add one in Settings.",
    });
    return;
  }

  const controller = new AbortController();
  set({ abort: controller, streamingNodeId: assistantNode.id });

  let text = "";
  let lastPersist = Date.now();

  try {
    const provider = createProvider(config);
    for await (const delta of provider.streamChat(req.messages, {
      model: config.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
    })) {
      text += delta.text;
      set((s) => ({
        nodes: { ...s.nodes, [assistantNode.id]: { ...s.nodes[assistantNode.id], content: text } },
      }));
      if (Date.now() - lastPersist > STREAM_PERSIST_MS) {
        lastPersist = Date.now();
        void db.nodes.update(assistantNode.id, { content: text });
      }
    }
    await patchNode(set, assistantNode.id, { content: text, status: "complete" });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    await patchNode(set, assistantNode.id, {
      content: text,
      // A stopped stream keeps whatever arrived; it is a real partial answer,
      // not an error, and the user may well want to branch off it.
      status: aborted ? "complete" : "error",
      ...(aborted ? {} : { error: err instanceof Error ? err.message : String(err) }),
    });
  } finally {
    if (get().streamingNodeId === assistantNode.id) {
      set({ abort: null, streamingNodeId: null });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

async function commitNode(
  set: Setter,
  get: Getter,
  node: ConversationNode,
): Promise<void> {
  const parent = node.parentId ? get().nodes[node.parentId] : undefined;
  const parentChildren = parent ? [...parent.childrenIds, node.id] : null;

  set((s) => {
    const nodes = { ...s.nodes, [node.id]: node };
    if (parent && parentChildren) {
      nodes[parent.id] = { ...parent, childrenIds: parentChildren };
    }
    return {
      nodes,
      activeNodeId: node.id,
      preferredChild: parent
        ? { ...s.preferredChild, [parent.id]: node.id }
        : s.preferredChild,
    };
  });

  await db.transaction("rw", db.nodes, async () => {
    await db.nodes.put(node);
    if (parent && parentChildren) {
      await db.nodes.update(parent.id, { childrenIds: parentChildren });
    }
  });
  void persistActive(node.conversationId, node.id);
}

async function patchNode(
  set: Setter,
  id: NodeId,
  patch: Partial<ConversationNode>,
): Promise<void> {
  set((s) =>
    s.nodes[id] ? { nodes: { ...s.nodes, [id]: { ...s.nodes[id], ...patch } } } : {},
  );
  await db.nodes.update(id, patch);
}

async function persistActive(conversationId: string | null, nodeId: NodeId): Promise<void> {
  if (!conversationId) return;
  await db.conversations.update(conversationId, { activeNodeId: nodeId });
}

async function touchConversation(
  set: Setter,
  get: Getter,
  conversationId: string,
  firstText: string,
): Promise<void> {
  const conversation = get().conversations.find((c) => c.id === conversationId);
  if (!conversation) return;
  const isFirst = conversation.title === "New conversation" && firstText.trim().length > 0;
  const patch: Partial<Conversation> = { updatedAt: Date.now() };
  if (isFirst) patch.title = titleFrom(firstText);
  await db.conversations.update(conversationId, patch);
  set((s) => ({
    conversations: s.conversations
      .map((c) => (c.id === conversationId ? { ...c, ...patch } : c))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/^#+\s*/, "");
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "Untitled";
}

/** Record the choice at every fork on the way to `id`, so navigating into a
 *  branch and back out again lands where the user left off. */
function withPreferredPath(
  nodes: NodeMap,
  id: NodeId,
  current: Record<NodeId, NodeId>,
): Record<NodeId, NodeId> {
  const next = { ...current };
  let cursor: NodeId | null = id;
  const seen = new Set<NodeId>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const node: ConversationNode | undefined = nodes[cursor];
    if (!node?.parentId) break;
    next[node.parentId] = cursor;
    cursor = node.parentId;
  }
  return next;
}
