/**
 * ToonDao data model — the source of truth for the whole app.
 *
 * Two graphs are overlaid on the same set of nodes:
 *
 *   Graph A — Lineage.  `parentId` / `childrenIds` / `origin`.
 *             "This thought came out of that thought."  Provenance of inquiry.
 *
 *   Graph B — Context.  `contextPolicy`, resolved by `assembleContext()`.
 *             "These messages were in the prompt when this node was generated."
 *
 * A child in Graph A may inherit nothing in Graph B. That is the product.
 * Nothing in this file may conflate the two.
 */

import type { Effort, ToolUse, Usage } from "@/lib/bridgeProtocol";
import type { ConversationView } from "@/lib/view";

export type NodeId = string;

export interface ConversationNode {
  id: NodeId;
  conversationId: string;
  parentId: NodeId | null;
  childrenIds: NodeId[];
  role: "user" | "assistant";
  /** Raw markdown. Never rendered HTML. Anchor offsets index into this. */
  content: string;
  model?: string;
  createdAt: number;
  status: "complete" | "streaming" | "error";

  /** Graph A: why this node exists. */
  origin: BranchOrigin | null;
  /** Graph B: what was sent. */
  contextPolicy: ContextPolicy;
  /** Cached record of what was actually sent, for the inspector. Historical — never recomputed. */
  assembledPreview?: string;
  /** Set when status === "error". */
  error?: string;

  /**
   * Set on a reply produced through the Claude Code bridge. Claude Code adds
   * context of its own that the recorded payload cannot show, so the inspector
   * needs to know which replies it is describing.
   */
  harness?: "claude-code";
  /**
   * On a user node: the thinking effort chosen from here down this branch,
   * found by walking up like `model` (P-36). On a reply: the effort it was
   * written with. Claude Code bridge only; absent means Claude Code's default.
   */
  effort?: Effort;
  /**
   * On a user node: Pace answers switched on or off from here down this
   * branch, asides included, found by walking up like `effort` (P-37).
   */
  pacing?: boolean;
  /**
   * On a reply: which of its next questions carries the thread, set only by a
   * rewind (P-44). Without it the oldest does. Lineage is untouched: the
   * question it replaced keeps its place in the tree, as a fork.
   */
  line?: NodeId;
  /** On a user node: the files attached to this question (P-43). */
  attachments?: Attachment[];
  /** Outside sources the model used while writing this reply (bridge only). */
  toolUse?: ToolUse[];
  /** Tokens the request cost, as the bridge measured them. */
  usage?: Usage;
}

/** Where in the tree — and where inside a message — this node was born. */
export interface BranchOrigin {
  kind: BranchKind;
  sourceNodeId: NodeId;
  /** Absent only for continuation/regenerate. */
  anchor?: TextAnchor;
}

export type BranchKind =
  | "continuation" // ordinary next turn
  | "regenerate" // sibling retry
  | "concept-lens" // §5.1
  | "structural-crop" // §5.2
  | "isolated-selection" // §5.3
  | "quote-reply"; // §5.4

/** Character range into the RAW MARKDOWN of the source node. */
export interface TextAnchor {
  start: number;
  end: number;
  /** Denormalized so the UI never re-derives it. */
  text: string;
  /** Index path to the mdast block, e.g. "3" or "3.1". */
  blockPath?: string;
}

export type ContextPolicy =
  | { kind: "full-ancestry" }
  | { kind: "windowed"; turns: number; upToNodeId: NodeId }
  | { kind: "truncated"; upToNodeId: NodeId; charOffset: number }
  | { kind: "isolated"; payload: string }
  | {
      kind: "quoted";
      quote: string;
      base: "full-ancestry" | "windowed";
      turns?: number;
    };

export type PolicyKind = ContextPolicy["kind"];

/* ------------------------------------------------------------------ */
/* Provider-facing message shape                                       */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Images and PDFs sent with this turn, for a provider adapter to place
   * beside `content` (P-43). Text files are never here: `assembleContext()`
   * has already written them into `content` through the `attachment` template.
   */
  attachments?: Attachment[];
}

/**
 * A file the person attached to a question (P-43). Stored on the question's
 * node, so it is part of that turn: it is sent wherever the turn is sent whole,
 * and never in a departure's carved-out text.
 */
export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** The file's name as picked. */
  name: string;
  /** image/png, image/jpeg, image/gif, image/webp, application/pdf, text/plain. */
  mediaType: string;
  /** Size of the stored file (after an image was shrunk), in bytes. */
  bytes: number;
  /** Base64 for an image or a PDF; the text itself for a text file. */
  data: string;
  /** An image's size in pixels, as stored. */
  width?: number;
  height?: number;
  /** A PDF's page count, as far as a quick look could tell. */
  pages?: number;
  /** A text attachment made from an Office file (P-45); its pictures are attachments of their own. */
  convertedFrom?: OfficeKind;
}

export type OfficeKind = "docx" | "pptx";

export type AttachmentKind = "image" | "pdf" | "text";

/* ------------------------------------------------------------------ */
/* Conversations, templates, settings                                  */
/* ------------------------------------------------------------------ */

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  rootId: NodeId | null;
  /** The leaf the composer is currently attached to. */
  activeNodeId: NodeId | null;
  /**
   * Passages parked for later, oldest first (src/lib/later.ts). Optional, and
   * stored on the conversation rather than in a table of its own, so no schema
   * version bump is needed and older builds simply ignore the field.
   */
  later?: LaterItem[];
  /**
   * The project this conversation learns from, pinned to one snapshot so every
   * turn reads the same files the learning map was drawn from (P-32). Optional,
   * like `later`.
   */
  project?: ConversationProject;
  /**
   * Who named the conversation. `auto`: a model, from what it is about (P-34).
   * `set`: the person typed it, or the app chose it on purpose (a learning
   * conversation's). Absent: still the first words of the first message, which
   * the first finished reply replaces with a model-written title. Optional.
   */
  titleSource?: "auto" | "set";
  /**
   * Pace answers for this conversation, until a question in a branch switches
   * it (P-37). Taken from Settings when the conversation is created, so changing
   * that default later leaves existing conversations as they were. Optional:
   * a conversation from before P-37 follows Settings.
   */
  pacing?: boolean;
  /**
   * What was on screen when this conversation was last open — its asides, the
   * unsent words in each box, where each pane was scrolled (P-50) — so a reload
   * or a trip elsewhere comes back to it. Optional, like `later`; never
   * exported, and never part of what is sent.
   */
  view?: ConversationView;
  /**
   * When the person archived the whole conversation: it leaves the sidebar's
   * list for the archived one and is otherwise untouched (P-58).
   */
  archivedAt?: number;
  /**
   * Branches the person archived: the ids of their head turns (an outline
   * row's id). Each hides its row and every row beneath it in the sidebar, and
   * nothing else — not the tree, not the context, not a reply's fork markers.
   */
  archivedBranches?: NodeId[];
}

/** A registered project and the snapshot a conversation reads (names only; the bridge holds the folder). */
export interface ConversationProject {
  slug: string;
  snapshot: string;
  name: string;
}

/** A passage the reader chose not to chase yet. */
export interface LaterItem {
  id: string;
  /** The message the passage is in. */
  sourceNodeId: NodeId;
  anchor: TextAnchor;
  createdAt: number;
}

export type TemplateId =
  | "concept_lens"
  | "structural_crop"
  | "isolated_selection"
  | "quote_reply"
  | "pacing"
  | "learning_map"
  | "title"
  | "attachment"
  | "rendering"
  | "files";

export interface PromptTemplate {
  id: TemplateId;
  /** Body with {{double_brace}} variables. */
  body: string;
  updatedAt: number;
}

export type TemplateSet = Record<TemplateId, string>;

export interface ProviderConfig {
  id: string;
  /** Which adapter implements this config. */
  kind: "openai-compatible" | "anthropic" | "claude-code";
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Models offered in the picker; free-text entry is always allowed too. */
  knownModels: string[];
}

export interface Settings {
  id: "singleton";
  providers: ProviderConfig[];
  activeProviderId: string | null;
  systemPrompt: string;
  /**
   * Ask the model to answer one idea at a time and stop at a checkpoint. The
   * wording is the `pacing` template, appended to the system message.
   */
  pacing: boolean;
  /**
   * Let ordinary replies and quotes use research tools. The lens always may;
   * an isolation and a crop never do (src/lib/toolScope.ts). Only the Claude
   * Code bridge has tools, so this does nothing with other providers.
   */
  chatTools: boolean;
  /** Default turn count for the concept lens (§5.1), range 1–5. */
  conceptLensTurns: number;
  temperature: number;
  maxTokens: number | null;
  /** How large the interface's text is (P-38). Optional: older settings read as "default". */
  textSize?: TextSize;
  /** The side pane's share of the canvas, set by dragging the divider (P-49). Absent: the default width. */
  asideShare?: number;
}

export type TextSize = "small" | "default" | "large" | "larger";

/* ------------------------------------------------------------------ */
/* Node store — the read interface assembleContext() is given          */
/* ------------------------------------------------------------------ */

export interface NodeStore {
  get(id: NodeId): ConversationNode | undefined;
}

export function nodeStoreFromMap(
  map: Map<NodeId, ConversationNode> | Record<NodeId, ConversationNode>,
): NodeStore {
  if (map instanceof Map) return { get: (id) => map.get(id) };
  return { get: (id) => map[id] };
}
