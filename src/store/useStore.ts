import { create } from "zustand";
import type {
  Attachment,
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
import { DEFAULT_TEMPLATES, renderTemplate } from "@/lib/templates";
import { assembleContext, assembleTitle, formatPayload } from "@/lib/assembleContext";
import { cleanTitle } from "@/lib/title";
import { createProvider } from "@/providers";
import { newId } from "@/lib/id";
import { buildBundle, parseBundle } from "@/lib/transfer";
import { rootsOf, subtreeIds, type NodeMap } from "@/lib/tree";
import { buildOutline, spineLeaf, threadOf } from "@/lib/outline";
import { parkPassage, pruneParked } from "@/lib/later";
import { lastOpened } from "@/lib/view";
import { tabConversation } from "@/lib/tabMemory";
import { toolScopeFor, type ToolGrant } from "@/lib/toolScope";
import { planSubmission, restartedConversation } from "@/lib/draft";
import { branchEffort, branchModel, branchPacing } from "@/lib/model";
import type { Effort, ProjectSummary, RateLimit, ToolUse, Usage } from "@/lib/bridgeProtocol";

export interface SubmitRequest {
  /** The human-readable ask. Becomes node.content. */
  text: string;
  parentId: NodeId | null;
  policy: ContextPolicy;
  origin: BranchOrigin | null;
  /** Per-branch model override. Absent means inherit from the branch. */
  model?: string;
  /** Per-branch thinking effort (P-36). Absent means inherit from the branch. */
  effort?: Effort;
  /** Per-branch Pace answers (P-37). Absent means inherit from the branch. */
  pacing?: boolean;
  /** Files attached to this question (P-43), stored on its node. */
  attachments?: Attachment[];
  /**
   * Set when this question asks an earlier one again (P-44): the reply above
   * both names the new one as its `line`, so the thread follows it and the
   * earlier question, with everything after it, becomes a fork.
   */
  rewinds?: NodeId;
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

  /**
   * Replies being written, by id — any number at once: the thread and an
   * aside, or two conversations (P-46). Each stops only itself, and switching
   * conversations stops none; a reply whose conversation is not open is
   * written to the database alone and shows when its conversation is opened.
   */
  streams: Record<NodeId, { abort: AbortController; conversationId: string }>;
  /** The subscription's usage window, as the Claude Code bridge last reported
   *  it. Null until a bridge request has run. Not persisted: it is live state. */
  rateLimit: RateLimit | null;

  init: () => Promise<void>;
  newConversation: () => Promise<string>;
  /** A new conversation set up like this one, to ask its first question again in (P-44). */
  restartConversation: (fromId: string) => Promise<string>;
  selectConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  renameConversation: (id: string, title: string) => Promise<void>;
  /** Put a whole conversation in the archived list, or take it out (P-58). */
  archiveConversation: (id: string) => Promise<void>;
  unarchiveConversation: (id: string) => Promise<void>;
  /** Hide a branch's row, and the rows beneath it, from the sidebar (P-58). */
  archiveBranch: (conversationId: string, threadId: string) => Promise<void>;
  /** Bring back every branch archived in this conversation. */
  restoreBranches: (conversationId: string) => Promise<void>;
  /**
   * Have the model name the current conversation from what it is about (P-34),
   * in one small request. Resolves true when the title changed.
   */
  nameConversation: (id: string) => Promise<boolean>;

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
  /** Stop one reply; with no id, every reply in the open conversation. */
  stop: (nodeId?: NodeId) => void;
  deleteSubtree: (id: NodeId) => Promise<void>;

  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateTemplate: (id: TemplateId, body: string) => Promise<void>;
  resetTemplate: (id: TemplateId) => Promise<void>;

  exportAll: () => Promise<string>;
  exportConversation: (id: string) => Promise<string>;
  importBundle: (raw: string) => Promise<{ conversations: number; nodes: number; remapped: boolean }>;
  /**
   * Start a conversation that learns from a registered project (P-32): pinned
   * to its latest snapshot, opened with the learning-map template.
   */
  startLearning: (project: ProjectSummary) => Promise<void>;

  /** Model for the next send, inherited down the branch (§8 P3). */
  modelForBranch: (nodeId: NodeId | null) => string | undefined;
  /** The thinking effort inherited at this point of a branch, if one was chosen. */
  effortForBranch: (nodeId: NodeId | null) => Effort | undefined;
  /** Whether Pace answers applies at this point of a branch (P-37). */
  pacingForBranch: (nodeId: NodeId | null) => boolean;

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
  streams: {},
  rateLimit: null,

  nodeStore: () => {
    const nodes = get().nodes;
    return { get: (id: NodeId) => nodes[id] };
  },

  /** Every prompt in the app comes through here, and this is the only caller
   *  of assembleContext(). No component builds a message array. */
  assemble: (node) => {
    // Pace answers as it stands at the question: its own switch, or the branch's
    // (P-37). A reply's payload is its question's; a draft carries its own switch.
    const asked = node.role === "assistant" ? node.parentId : null;
    const pacing =
      node.role === "user" && typeof node.pacing === "boolean"
        ? node.pacing
        : get().pacingForBranch(asked ?? node.parentId);
    return assembleContext(node, get().nodeStore(), get().templates, {
      systemPrompt: get().settings.systemPrompt,
      pacing,
      // P-47: every request is told what this chat can draw.
      rendering: true,
    });
  },

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

      // The conversation on screen at the last reload, not merely the newest (P-50).
      const open = lastOpened(conversations, tabConversation());
      if (open) {
        await get().selectConversation(open.id);
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
      // The default as it is now: changing Settings later leaves this one be (P-37).
      pacing: get().settings.pacing,
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

  restartConversation: async (fromId) => {
    const patch = restartedConversation(get().conversations.find((c) => c.id === fromId));
    const id = await get().newConversation();
    if (Object.keys(patch).length) {
      await db.conversations.update(id, patch);
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    }
    return id;
  },

  selectConversation: async (id) => {
    // Replies still being written keep going (P-46); they write to the
    // database while their conversation is not the one open.
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
    for (const [nodeId, stream] of Object.entries(get().streams)) {
      if (stream.conversationId === id) get().stop(nodeId);
    }
    await db.transaction("rw", db.conversations, db.nodes, async () => {
      await db.nodes.where("conversationId").equals(id).delete();
      await db.conversations.delete(id);
    });
    const remaining = get().conversations.filter((c) => c.id !== id);
    set({ conversations: remaining });
    if (get().conversationId === id) await openNextListed(get, id);
  },

  // Archiving is how the sidebar shows things, not a change to them: neither
  // touches `updatedAt`, so a restored row comes back where it was.
  archiveConversation: async (id) => {
    await patchConversation(set, id, { archivedAt: Date.now() });
    if (get().conversationId === id) await openNextListed(get, id);
  },

  unarchiveConversation: async (id) => {
    await patchConversation(set, id, { archivedAt: undefined });
  },

  archiveBranch: async (conversationId, threadId) => {
    const current = get().conversations.find((c) => c.id === conversationId)?.archivedBranches ?? [];
    if (current.includes(threadId)) return;
    await patchConversation(set, conversationId, { archivedBranches: [...current, threadId] });
  },

  restoreBranches: async (conversationId) => {
    await patchConversation(set, conversationId, { archivedBranches: undefined });
  },

  renameConversation: async (id, title) => {
    const trimmed = title.trim() || "Untitled";
    // A title the person typed is theirs: no automatic naming replaces it.
    await db.conversations.update(id, { title: trimmed, titleSource: "set", updatedAt: Date.now() });
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id ? { ...c, title: trimmed, titleSource: "set" } : c,
      ),
    }));
  },

  nameConversation: async (id) => {
    const { conversationId, nodes, activeNodeId, settings, templates } = get();
    // Only the open conversation has its nodes loaded.
    if (id !== conversationId || naming.has(id)) return false;
    const config = settings.providers.find((p) => p.id === settings.activeProviderId);
    if (!config || (config.kind === "anthropic" && !config.apiKey)) return false;

    // The thread, root first: the cursor always sits on the root spine.
    const spine: ConversationNode[] = [];
    const seen = new Set<NodeId>();
    for (let cursor = activeNodeId; cursor && !seen.has(cursor); cursor = nodes[cursor]?.parentId ?? null) {
      seen.add(cursor);
      const node = nodes[cursor];
      if (node) spine.unshift(node);
    }
    if (!spine.some((n) => n.role === "assistant" && n.status === "complete" && n.content.trim())) return false;

    naming.add(id);
    const controller = new AbortController();
    try {
      let reply = "";
      for await (const delta of createProvider(config).streamChat(assembleTitle(spine, templates), {
        model: get().modelForBranch(activeNodeId) ?? config.model,
        temperature: 0.2,
        maxTokens: 40,
        signal: controller.signal,
        toolScope: "none",
        project: null,
      })) {
        reply += delta.text;
        if (reply.length > 400) break; // a title, not an essay: stop paying for it
      }
      const title = cleanTitle(reply);
      if (!title) return false;
      const patch: Partial<Conversation> = { title, titleSource: "auto" };
      await db.conversations.update(id, patch);
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
      return true;
    } catch {
      return false; // the first words stay; the person can ask again
    } finally {
      controller.abort();
      naming.delete(id);
    }
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
      ...(request.effort ? { effort: request.effort } : {}),
      ...(typeof request.pacing === "boolean" ? { pacing: request.pacing } : {}),
      ...(request.attachments?.length ? { attachments: request.attachments } : {}),
    };

    const detached = request.detached === true;
    // The line moves before the question lands, so the cursor commitNode sets
    // is on the root spine from the first render.
    if (request.rewinds && request.parentId && get().nodes[request.parentId]) {
      await patchNode(set, request.parentId, { line: userNode.id });
    }
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
      effort: request.effort ?? get().effortForBranch(request.parentId),
      detached,
      ...(request.onCommitted
        ? {
            onCommitted: (assistantNodeId: NodeId) =>
              request.onCommitted?.({ userNodeId: userNode.id, assistantNodeId }),
          }
        : {}),
    });

    // A question that is a file alone is named after the file until the model names it.
    await touchConversation(set, get, conversationId, request.text || request.attachments?.[0]?.name || "");
    // The first finished reply in a conversation nobody has named yet: name it.
    const named = get().conversations.find((c) => c.id === conversationId)?.titleSource;
    if (!detached && request.parentId === null && !named && get().nodes[assistantNodeId]?.status === "complete") {
      void get().nameConversation(conversationId);
    }
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
      // A retry re-asks the same question, so it re-uses the same model and effort.
      model: target.model ?? get().modelForBranch(parent.id),
      effort: target.effort ?? get().effortForBranch(parent.id),
    });
  },

  stop: (nodeId) => {
    const { streams, conversationId } = get();
    const ids = nodeId ? [nodeId] : Object.keys(streams).filter((id) => streams[id]?.conversationId === conversationId);
    for (const id of ids) streams[id]?.abort.abort();
    if (!ids.length) return;
    set((s) => {
      const next = { ...s.streams };
      for (const id of ids) delete next[id];
      return { streams: next };
    });
  },

  deleteSubtree: async (id) => {
    const { nodes, activeNodeId } = get();
    const node = nodes[id];
    if (!node) return;
    const ids = subtreeIds(nodes, id);
    const idSet = new Set(ids);

    await db.nodes.bulkDelete(ids);
    // Deleting the version a rewind put on the line gives the line back to the oldest.
    const unline = Boolean(node.parentId && nodes[node.parentId]?.line === id);
    if (node.parentId && nodes[node.parentId]) {
      const remaining = nodes[node.parentId].childrenIds.filter((c) => c !== id);
      await db.nodes.update(node.parentId, { childrenIds: remaining, ...(unline ? { line: undefined } : {}) });
    }
    // A parked passage whose message is gone can never be asked about.
    const parked = get().conversations.find((c) => c.id === node.conversationId)?.later;
    if (parked?.length) {
      const kept = pruneParked(parked, idSet);
      if (kept.length !== parked.length) await saveLater(set, node.conversationId, kept);
    }
    // An archived branch that no longer exists has nothing to hide or restore.
    const archived = get().conversations.find((c) => c.id === node.conversationId)?.archivedBranches;
    if (archived?.some((a) => idSet.has(a))) {
      const kept = archived.filter((a) => !idSet.has(a));
      await patchConversation(set, node.conversationId, { archivedBranches: kept.length ? kept : undefined });
    }

    set((s) => {
      const next: NodeMap = {};
      for (const [key, value] of Object.entries(s.nodes)) {
        if (idSet.has(key)) continue;
        next[key] =
          value.id === node.parentId
            ? {
                ...value,
                childrenIds: value.childrenIds.filter((c) => c !== id),
                ...(unline ? { line: undefined } : {}),
              }
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

  effortForBranch: (nodeId) => branchEffort(get().nodes, nodeId),

  pacingForBranch: (nodeId) => {
    const { nodes, conversations, conversationId, settings } = get();
    const conversation = conversations.find((c) => c.id === conversationId);
    return branchPacing(nodes, nodeId, conversation?.pacing, settings.pacing);
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

  startLearning: async (project) => {
    const snapshot = project.snapshots.at(-1);
    if (!snapshot || typeof snapshot.files !== "number") {
      throw new Error(
        `Take a new snapshot of "${project.name}" first: this one was taken before the model could read snapshots.`,
      );
    }
    const conversationId = await get().newConversation();
    const patch: Partial<Conversation> = {
      title: `Learning: ${project.name}`,
      titleSource: "set",
      project: { slug: project.slug, snapshot: snapshot.id, name: project.name },
    };
    await db.conversations.update(conversationId, patch);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, ...patch } : c)),
    }));
    // The first message is an ordinary one, planned like any other: the
    // template is its text, and what the model reads comes from the pin.
    const text = renderTemplate(get().templates.learning_map, { project: project.name });
    const plan = planSubmission({ text, pending: null, activeLeafId: null });
    await get().submit({ text: plan.content, parentId: plan.parentId, policy: plan.policy, origin: plan.origin });
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
  /** Resolved per-branch thinking effort; absent means Claude Code's default. */
  effort?: Effort | undefined;
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
  set((s) => ({
    streams: { ...s.streams, [assistantNode.id]: { abort: controller, conversationId: req.conversationId } },
  }));
  // The question being answered decides the tools, through the aside it was
  // asked in, if any; a conversation that learns from a project may read the
  // snapshot it is pinned to.
  const asked = get().nodes[req.parentId];
  const project = get().conversations.find((c) => c.id === req.conversationId)?.project;
  const grant: ToolGrant = asked
    ? toolScopeFor(
        asked,
        get().nodeStore(),
        settings.chatTools,
        project ? { slug: project.slug, snapshot: project.snapshot } : null,
      )
    : { scope: "none", project: null };

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
          ...(req.effort ? { effort: req.effort } : {}),
        }
      : {};

  try {
    const provider = createProvider(config);
    for await (const delta of provider.streamChat(req.messages, {
      model: req.model ?? config.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
      toolScope: grant.scope,
      project: grant.project,
      ...(req.effort ? { effort: req.effort } : {}),
    })) {
      if (delta.rateLimit) set({ rateLimit: delta.rateLimit });
      if (delta.usage) usage = delta.usage;
      if (delta.model) resolvedModel = delta.model;
      if (delta.tool) {
        toolUse.push(delta.tool);
        // Shown while the reply is still streaming, so a pause reads as
        // "looking something up" rather than as a stall.
        setLive(set, assistantNode.id, { toolUse: [...toolUse] });
      }
      if (!delta.text) continue;
      text += delta.text;
      setLive(set, assistantNode.id, { content: text });
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
    if (get().streams[assistantNode.id]) {
      set((s) => {
        const next = { ...s.streams };
        delete next[assistantNode.id];
        return { streams: next };
      });
    }
  }
  return assistantNode.id;
}

/**
 * A streaming reply's latest text, on screen only if its conversation is the
 * one open: the node map holds that conversation alone, and a reply written
 * elsewhere must not appear in it (P-46). The database gets it either way.
 */
function setLive(set: Setter, id: NodeId, patch: Partial<ConversationNode>): void {
  set((s) => (s.nodes[id] ? { nodes: { ...s.nodes, [id]: { ...s.nodes[id], ...patch } } } : {}));
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
  // The person may have opened another conversation while the question was
  // being written (P-46): the node then goes to the database only, and shows
  // when its own conversation is opened again.
  if (node.conversationId !== get().conversationId) {
    await db.transaction("rw", db.nodes, async () => {
      await db.nodes.put(node);
      const parent = node.parentId ? await db.nodes.get(node.parentId) : undefined;
      if (parent && !parent.childrenIds.includes(node.id)) {
        await db.nodes.update(parent.id, { childrenIds: [...parent.childrenIds, node.id] });
      }
    });
    return;
  }
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

/** Changes a conversation's record as it is, `updatedAt` included. */
async function patchConversation(set: Setter, id: string, patch: Partial<Conversation>): Promise<void> {
  set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  await db.conversations.update(id, patch);
}

/** After the open conversation leaves the list: the newest one still in it, else a new one. */
async function openNextListed(get: Getter, leaving: string): Promise<void> {
  const next = get().conversations.find((c) => c.id !== leaving && !c.archivedAt);
  if (next) await get().selectConversation(next.id);
  else await get().newConversation();
}

async function persistActive(conversationId: string | null, nodeId: NodeId): Promise<void> {
  if (!conversationId) return;
  await db.conversations.update(conversationId, { activeNodeId: nodeId });
}

/** Conversations being named right now, so a second click does not send a second request. */
const naming = new Set<string>();

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
