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
}

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
  | "quote_reply";

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
  kind: "openai-compatible" | "anthropic";
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
  /** Default turn count for the concept lens (§5.1), range 1–5. */
  conceptLensTurns: number;
  temperature: number;
  maxTokens: number | null;
}

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
