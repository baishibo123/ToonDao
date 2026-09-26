import { create } from "zustand";
import type {
  BranchOrigin,
  ChatMessage,
  Conversation,
  ConversationNode,
  ContextPolicy,
  LaterItem,
  NodeId,
  NodeStore,
  Settings,
  TemplateId,
  TemplateSet,
  TextAnchor,
} from "@/types";
import { DEFAULT_SETTINGS, db, ensureSeeded, loadTemplateSet } from "@/db/db";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { assembleContext, formatPayload } from "@/lib/assembleContext";
import { createProvider } from "@/providers";
import { newId } from "@/lib/id";
import { buildBundle, parseBundle } from "@/lib/transfer";
import { rootsOf, subtreeIds, type NodeMap } from "@/lib/tree";
import { buildOutline, spineLeaf, threadOf } from "@/lib/outline";
import { parkPassage, pruneParked } from "@/lib/later";
import { toolScopeFor } from "@/lib/toolScope";
import { branchModel } from "@/lib/model";
import type { RateLimit, ToolUse, Usage } from "@/lib/bridgeProtocol";

export interface SubmitRequest {
  /** The human-readable ask. Becomes node.content. */
  text: string;
  parentId: NodeId | null;
  policy: ContextPolicy;
  origin: BranchOrigin | null;
  /** Per-branch model override. Absent means inherit from the branch. */
  model?: string;
  /**
   * Send without moving the app's cursor.
   *
   * A branch sent from its own window must not drag the main transcript into
   * itself — the whole point of the window is that the thread you were reading
   * stays where it was. So a detached submit writes the nodes and streams into
   * them, but leaves `activeNodeId` and the remembered fork choices alone; the
   * window tracks its own leaf from the ids it gets back.
   */
  detached?: boolean;
  /**
   * Called once both nodes exist, *before* the stream finishes.
   *
   * The awaited result carries the same ids, but it does not arrive until the
   * reply is complete — a window that waited for it would sit empty for the
   * whole generation and then fill in all at once. This fires as soon as there
   * is something to point a view at.
   */
  onCommitted?: (result: SubmitResult) => void;
}

export interface SubmitResult {
  userNodeId: NodeId;
  /** The reply node. Exists even when the request failed — it carries the error. */
  assistantNodeId: NodeId;
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
  /** The subscription's usage window, as the Claude Code bridge last reported
   *  it. Null until a bridge request has run. Not persisted: it is live state. */
  rateLimit: RateLimit | null;

  init: () => Promise<void>;
  newConversation: () => Promise<string>;
  selectConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;

  /** Park a passage on the open conversation's Later list. */
  park: (sourceNodeId: NodeId, anchor: TextAnchor) => Promise<void>;
  /** Take a passage off the Later list — asked about, or let go. */
  unpark: (itemId: string) => Promise<void>;

  setActiveNode: (id: NodeId) => void;

  submit: (request: SubmitRequest) => Promise<SubmitResult>;
  regenerate: (
    assistantNodeId: NodeId,
    opts?: { detached?: boolean; onCommitted?: (nodeId: NodeId) => void },
  ) => Promise<NodeId | null>;
  stop: () => void;
  deleteSubtree: (id: NodeId) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateTemplate: (id: TemplateId, body: string) => Promise<void>;
  resetTemplate: (id: TemplateId) => Promise<void>;

  exportAll: () => Promise<string>;
  exportConversation: (id: string) => Promise<string>;
  importBundle: (raw: string) => Promise<{ conversations: number; nodes: number; remapped: boolean }>;

  /** Model for the next send, inherited down the branch (§8 P3). */
  modelForBranch: (nodeId: NodeId | null) => string | undefined;

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
  rateLimit: null,

  nodeStore: () => {
    const nodes = get().nodes;
    return { get: (id: NodeId) => nodes[id] };
  },

  /** Every prompt in the app comes through here, and this is the only caller
   *  of assembleContext(). No component builds a message array. */
  assemble: (node) =>
    assembleContext(node, get().nodeStore(), get().templates, {
      systemPrompt: get().settings.systemPrompt,
      pacing: get().settings.pacing,
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
    set({
      conversationId: id,
      nodes,
      activeNodeId: mainSpineCursor(nodes, id, conversation?.activeNodeId ?? null),
      preferredChild: {},
    });
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

  park: async (sourceNodeId, anchor) => {
    const conversation = openConversation(get);
    if (!conversation) return;
    const later = parkPassage(conversation.later ?? [], {
      id: newId("l"),
      sourceNodeId,
      anchor,
      createdAt: Date.now(),
    });
    await saveLater(set, conversation.id, later);
  },

  unpark: async (itemId) => {
    const conversation = openConversation(get);
    if (!conversation?.later?.some((item) => item.id === itemId)) return;
    await saveLater(
      set,
      conversation.id,
      conversation.later.filter((item) => item.id !== itemId),
    );
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
      // The override is recorded on the user node, which is what makes it
      // per-*branch* rather than global: descendants inherit it by walking up.
      ...(request.model ? { model: request.model } : {}),
    };

    const detached = request.detached === true;
    await commitNode(set, get, userNode, detached);

    // Assemble once, here. The payload is recorded on the node before the
    // request goes out, so the inspector shows what was actually sent even if
    // the stream fails (§11 Q4: the preview is historical, never recomputed).
    const messages = get().assemble(userNode);
    const preview = formatPayload(messages);
    await patchNode(set, userNode.id, { assembledPreview: preview });

    const assistantNodeId = await runStream(set, get, {
      conversationId,
      parentId: userNode.id,
      messages,
      preview,
      origin: { kind: "continuation", sourceNodeId: userNode.id },
      policy: request.policy,
      model: request.model ?? get().modelForBranch(request.parentId),
      detached,
      ...(request.onCommitted
        ? {
            onCommitted: (assistantNodeId: NodeId) =>
              request.onCommitted?.({ userNodeId: userNode.id, assistantNodeId }),
          }
        : {}),
    });

    await touchConversation(set, get, conversationId, request.text);
    return { userNodeId: userNode.id, assistantNodeId };
  },

  regenerate: async (assistantNodeId, opts) => {
    const { nodes } = get();
    const target = nodes[assistantNodeId];
    if (!target || target.role !== "assistant" || !target.parentId) return null;
    const parent = nodes[target.parentId];
    if (!parent) return null;

    const messages = get().assemble(parent);
    return runStream(set, get, {
      detached: opts?.detached === true,
      ...(opts?.onCommitted ? { onCommitted: opts.onCommitted } : {}),
      conversationId: parent.conversationId,
      parentId: parent.id,
      messages,
      preview: parent.assembledPreview ?? formatPayload(messages),
      origin: { kind: "regenerate", sourceNodeId: assistantNodeId },
      policy: parent.contextPolicy,
      // A retry re-asks the same question, so it re-uses the same model.
      model: target.model ?? get().modelForBranch(parent.id),
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
    // A parked passage whose message is gone can never be asked about.
    const parked = get().conversations.find((c) => c.id === node.conversationId)?.later;
    if (parked?.length) {
      const kept = pruneParked(parked, idSet);
      if (kept.length !== parked.length) await saveLater(set, node.conversationId, kept);
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
      return {
        nodes: next,
        activeNodeId: stillValid
          ? activeNodeId
          : mainSpineCursor(next, node.conversationId, node.parentId),
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

  /**
   * The nearest per-branch override the active provider offers, else its
   * default. See branchModel() in src/lib/model.ts.
   */
  modelForBranch: (nodeId) => {
    const { nodes, settings } = get();
    return branchModel(
      nodes,
      nodeId,
      settings.providers.find((p) => p.id === settings.activeProviderId),
    );
  },

  exportAll: async () => {
    const [conversations, nodes, templates] = await Promise.all([
      db.conversations.toArray(),
      db.nodes.toArray(),
      loadTemplateSet(),
    ]);
    return JSON.stringify(
      buildBundle({ conversations, nodes, templates, settings: get().settings }),
      null,
      2,
    );
  },

  exportConversation: async (id) => {
    const [conversation, nodes, templates] = await Promise.all([
      db.conversations.get(id),
      db.nodes.where("conversationId").equals(id).toArray(),
      loadTemplateSet(),
    ]);
    return JSON.stringify(
      buildBundle({
        conversations: conversation ? [conversation] : [],
        nodes,
        templates,
        settings: get().settings,
      }),
      null,
      2,
    );
  },

  importBundle: async (raw) => {
    const [existingConversations, existingNodes] = await Promise.all([
      db.conversations.toCollection().primaryKeys(),
      db.nodes.toCollection().primaryKeys(),
    ]);
    const parsed = parseBundle(raw, {
      conversations: new Set(existingConversations.map(String)),
      nodes: new Set(existingNodes.map(String)),
    });

    await db.transaction("rw", db.conversations, db.nodes, db.templates, async () => {
      await db.conversations.bulkPut(parsed.conversations);
      await db.nodes.bulkPut(parsed.nodes);
      for (const [id, body] of Object.entries(parsed.templates)) {
        if (body) await db.templates.put({ id: id as TemplateId, body, updatedAt: Date.now() });
      }
    });

    const [conversations, templates] = await Promise.all([
      db.conversations.orderBy("updatedAt").reverse().toArray(),
      loadTemplateSet(),
    ]);
    set({ conversations, templates });
    if (parsed.conversations[0]) {
      await get().selectConversation(parsed.conversations[0].id);
    }
    return {
      conversations: parsed.conversations.length,
      nodes: parsed.nodes.length,
      remapped: parsed.remapped,
    };
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
  /** Resolved per-branch model; falls back to the provider default. */
  model?: string;
  /** Stream into the node without moving the app's cursor to it. */
  detached?: boolean;
  /** Fired once the reply node exists, before the first delta arrives. */
  onCommitted?: (assistantNodeId: NodeId) => void;
}

/** Persist mid-stream at most this often, so a crash loses at most this much. */
const STREAM_PERSIST_MS = 800;

/** Returns the id of the node the reply was streamed into, error or not. */
async function runStream(set: Setter, get: Getter, req: StreamRequest): Promise<NodeId> {
  const settings = get().settings;
  const config = settings.providers.find((p) => p.id === settings.activeProviderId);

  const assistantNode: ConversationNode = {
    id: newId("a"),
    conversationId: req.conversationId,
    parentId: req.parentId,
    childrenIds: [],
    role: "assistant",
    content: "",
    model: req.model ?? config?.model,
    createdAt: Date.now(),
    status: "streaming",
    origin: req.origin,
    // An assistant node does not choose a policy; it records the one that
    // produced it, so the inspector reads the same on both halves of a turn.
    contextPolicy: req.policy,
    assembledPreview: req.preview,
  };

  await commitNode(set, get, assistantNode, req.detached === true);
  req.onCommitted?.(assistantNode.id);

  if (!config) {
    await patchNode(set, assistantNode.id, {
      status: "error",
      error: "No provider configured. Open Settings and add a base URL and key.",
    });
    return assistantNode.id;
  }
  if (!config.apiKey && config.kind === "anthropic") {
    await patchNode(set, assistantNode.id, {
      status: "error",
      error: "Anthropic requires an API key. Add one in Settings.",
    });
    return assistantNode.id;
  }

  const controller = new AbortController();
  set({ abort: controller, streamingNodeId: assistantNode.id });

  let text = "";
  let lastPersist = Date.now();
  const toolUse: ToolUse[] = [];
  let usage: Usage | undefined;
  let resolvedModel: string | undefined;
  // What the bridge adds to a reply, recorded with it: which tools it used,
  // what it cost, and that it came through Claude Code at all.
  const extras = (): Partial<ConversationNode> =>
    config.kind === "claude-code"
      ? {
          harness: "claude-code",
          ...(toolUse.length ? { toolUse: [...toolUse] } : {}),
          ...(usage ? { usage } : {}),
          // The id that answered, not the alias that was asked for.
          ...(resolvedModel ? { model: resolvedModel } : {}),
        }
      : {};

  try {
    const provider = createProvider(config);
    for await (const delta of provider.streamChat(req.messages, {
      model: req.model ?? config.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
      toolScope: toolScopeFor(req.policy, settings.chatTools),
    })) {
      if (delta.rateLimit) set({ rateLimit: delta.rateLimit });
      if (delta.usage) usage = delta.usage;
      if (delta.model) resolvedModel = delta.model;
      if (delta.tool) {
        toolUse.push(delta.tool);
        // Shown while the reply is still streaming, so a pause reads as
        // "looking something up" rather than as a stall.
        set((s) => ({
          nodes: { ...s.nodes, [assistantNode.id]: { ...s.nodes[assistantNode.id], toolUse: [...toolUse] } },
        }));
      }
      if (!delta.text) continue;
      text += delta.text;
      set((s) => ({
        nodes: { ...s.nodes, [assistantNode.id]: { ...s.nodes[assistantNode.id], content: text } },
      }));
      if (Date.now() - lastPersist > STREAM_PERSIST_MS) {
        lastPersist = Date.now();
        void db.nodes.update(assistantNode.id, { content: text });
      }
    }
    await patchNode(set, assistantNode.id, { content: text, status: "complete", ...extras() });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    await patchNode(set, assistantNode.id, {
      ...extras(),
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
  return assistantNode.id;
}

/* ------------------------------------------------------------------ */
/* Persistence helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Write a node, link it to its parent, and — unless the caller asked to stay
 * put — move the cursor onto it.
 *
 * `detached` skips three things and only these three: the active node, the
 * remembered fork choice at the parent, and the persisted cursor. The node
 * itself, and the parent's `childrenIds`, are written either way — a branch in
 * a window is a real part of the tree, not a draft.
 */
async function commitNode(
  set: Setter,
  get: Getter,
  node: ConversationNode,
  detached = false,
): Promise<void> {
  const parent = node.parentId ? get().nodes[node.parentId] : undefined;
  const parentChildren = parent ? [...parent.childrenIds, node.id] : null;

  set((s) => {
    const nodes = { ...s.nodes, [node.id]: node };
    if (parent && parentChildren) {
      nodes[parent.id] = { ...parent, childrenIds: parentChildren };
    }
    if (detached) return { nodes };
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
  if (!detached) void persistActive(node.conversationId, node.id);
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

function openConversation(get: Getter): Conversation | undefined {
  const { conversations, conversationId } = get();
  return conversations.find((c) => c.id === conversationId);
}

async function saveLater(
  set: Setter,
  conversationId: string,
  later: LaterItem[],
): Promise<void> {
  set((s) => ({
    conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, later } : c)),
  }));
  await db.conversations.update(conversationId, { later });
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

/**
 * Where the main chat box's cursor may sit: the end of the spine that starts at
 * the conversation's root, and nowhere else.
 *
 * The window invariant is that a window shows one linear spine, so the main
 * window can never show a branch — which means its cursor can never be inside
 * one. A `preferred` node is honoured only if it is on that spine, which is what
 * keeps a cursor persisted before this rule existed (or left behind by a delete)
 * from reopening the conversation halfway down a lens.
 */
function mainSpineCursor(
  nodes: NodeMap,
  conversationId: string,
  preferred: NodeId | null,
): NodeId | null {
  const outline = buildOutline(nodes, conversationId);
  const main = outline.threads[0];
  if (!main) return rootsOf(nodes, conversationId)[0]?.id ?? null;
  if (preferred && nodes[preferred] && threadOf(outline, preferred)?.depth === 0) {
    return spineLeaf(nodes, preferred);
  }
  return spineLeaf(nodes, main.headNodeId);
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
