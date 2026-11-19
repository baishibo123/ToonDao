import { isEffort } from "@/lib/bridgeProtocol";
import type {
  Attachment,
  AttachmentKind,
  Conversation,
  ConversationNode,
  ConversationProject,
  LaterItem,
  NodeId,
  Settings,
  TemplateId,
  TemplateSet,
} from "@/types";
import { newId } from "@/lib/id";

/**
 * JSON export / import. §8 P3: "full tree fidelity — this is the user's data
 * and it must be extractable."
 *
 * Extractable means more than a dump: a re-import has to reconstruct the same
 * two graphs, so every parentId, childrenIds ordering, origin anchor offset and
 * contextPolicy survives, and every node's assembled payload comes out
 * identical. Acceptance scenario 6 is asserted against exactly that.
 *
 * API keys are never written to an export file. An export is something people
 * put in Dropbox and attach to issues; a provider key does not belong in one.
 * The base URLs and model names come along, so an import is one paste away from
 * working again.
 */

export const BUNDLE_VERSION = 2;

export interface Bundle {
  format: "toondao.export";
  version: number;
  exportedAt: number;
  conversations: Conversation[];
  nodes: ConversationNode[];
  templates: Array<{ id: TemplateId; body: string }>;
  /** Settings minus every secret. */
  settings: Omit<Settings, "providers"> & {
    providers: Array<Omit<Settings["providers"][number], "apiKey">>;
  };
}

export function buildBundle(input: {
  conversations: Conversation[];
  nodes: ConversationNode[];
  templates: TemplateSet;
  settings: Settings;
}): Bundle {
  return {
    format: "toondao.export",
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    // What was on screen is not the conversation (P-50), and its ids would not
    // survive an import that remaps them.
    conversations: input.conversations.map(({ view, ...c }) => {
      void view;
      return c;
    }),
    nodes: input.nodes.map((n) => ({ ...n, childrenIds: [...n.childrenIds] })),
    templates: (Object.keys(input.templates) as TemplateId[]).map((id) => ({
      id,
      body: input.templates[id],
    })),
    settings: {
      ...input.settings,
      providers: input.settings.providers.map(({ apiKey, ...rest }) => {
        void apiKey;
        return rest;
      }),
    },
  };
}

export class ImportError extends Error {}

export interface ParsedBundle {
  conversations: Conversation[];
  nodes: ConversationNode[];
  templates: Partial<Record<TemplateId, string>>;
  /** Ids that were rewritten because they collided with existing data. */
  remapped: boolean;
}

const TEMPLATE_IDS: TemplateId[] = [
  "concept_lens",
  "structural_crop",
  "isolated_selection",
  "quote_reply",
  "pacing",
  "learning_map",
  "title",
  "attachment",
  "rendering",
  "files",
];

/**
 * Validate and normalize an export.
 *
 * `existingIds` are the ids already in the database. When any imported id
 * collides, *every* id in the bundle is rewritten together — partial remapping
 * would silently re-parent nodes onto the wrong tree, which is exactly the kind
 * of corruption a data-fidelity feature must not introduce.
 */
export function parseBundle(
  raw: string,
  existingIds: { conversations: Set<string>; nodes: Set<NodeId> } = {
    conversations: new Set(),
    nodes: new Set(),
  },
): ParsedBundle {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ImportError("That is not valid JSON.");
  }
  if (!isRecord(json)) throw new ImportError("Expected a JSON object.");
  if (json.format !== "toondao.export") {
    throw new ImportError(
      "That file is not a ToonDao export (missing the \"toondao.export\" marker).",
    );
  }
  if (typeof json.version !== "number" || json.version > BUNDLE_VERSION) {
    throw new ImportError(
      `That export is version ${String(json.version)}; this build reads up to ${BUNDLE_VERSION}.`,
    );
  }

  const rawConversations = Array.isArray(json.conversations) ? json.conversations : [];
  const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
  if (rawConversations.length === 0 && rawNodes.length === 0) {
    throw new ImportError("That export contains no conversations.");
  }

  const collides =
    rawConversations.some((c) => isRecord(c) && existingIds.conversations.has(String(c.id))) ||
    rawNodes.some((n) => isRecord(n) && existingIds.nodes.has(String(n.id)));

  const conversationIds = new Map<string, string>();
  const nodeIds = new Map<string, string>();
  const mapConversation = (id: string): string => {
    if (!collides) return id;
    const existing = conversationIds.get(id);
    if (existing) return existing;
    const next = newId("c");
    conversationIds.set(id, next);
    return next;
  };
  const mapNode = (id: string): string => {
    if (!collides) return id;
    const existing = nodeIds.get(id);
    if (existing) return existing;
    const next = newId("n");
    nodeIds.set(id, next);
    return next;
  };

  // Pre-map in document order so ids stay stable regardless of reference order.
  for (const c of rawConversations) if (isRecord(c)) mapConversation(String(c.id));
  for (const n of rawNodes) if (isRecord(n)) mapNode(String(n.id));

  const nodes: ConversationNode[] = rawNodes.map((value, index) => {
    if (!isRecord(value)) throw new ImportError(`Node ${index} is not an object.`);
    const role = value.role === "assistant" ? "assistant" : "user";
    if (typeof value.id !== "string" || value.id.length === 0) {
      throw new ImportError(`Node ${index} has no id.`);
    }
    if (typeof value.content !== "string") {
      throw new ImportError(`Node ${value.id} has no content string.`);
    }
    return {
      id: mapNode(value.id),
      conversationId: mapConversation(String(value.conversationId ?? "")),
      parentId: typeof value.parentId === "string" ? mapNode(value.parentId) : null,
      childrenIds: Array.isArray(value.childrenIds)
        ? value.childrenIds.filter(isString).map(mapNode)
        : [],
      role,
      content: value.content,
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
      status:
        value.status === "streaming" || value.status === "error"
          ? // A stream cannot be resumed across an export, so anything caught
            // mid-flight comes back as the complete partial answer it is.
            value.status === "error"
            ? "error"
            : "complete"
          : "complete",
      origin: parseOrigin(value.origin, mapNode),
      contextPolicy: parsePolicy(value.contextPolicy, mapNode),
      ...(typeof value.assembledPreview === "string"
        ? { assembledPreview: value.assembledPreview }
        : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...parseBridgeRecord(value),
      ...parseAttachments(value.attachments),
      ...(typeof value.line === "string" ? { line: mapNode(value.line) } : {}),
    };
  });

  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  // Drop dangling references rather than importing a broken tree.
  for (const node of nodes) {
    if (node.parentId && !nodesById.has(node.parentId)) node.parentId = null;
    node.childrenIds = node.childrenIds.filter((id) => nodesById.has(id));
  }
  // Rebuild any childrenIds a hand-edited file left out, preserving the order
  // the file did give.
  for (const node of nodes) {
    if (!node.parentId) continue;
    const parent = nodesById.get(node.parentId)!;
    if (!parent.childrenIds.includes(node.id)) parent.childrenIds.push(node.id);
  }

  const conversations: Conversation[] = rawConversations
    .filter(isRecord)
    .map((value) => {
      const id = mapConversation(String(value.id));
      const own = nodes.filter((n) => n.conversationId === id);
      const rootId = own.find((n) => n.parentId === null)?.id ?? null;
      const activeRaw =
        typeof value.activeNodeId === "string" ? mapNode(value.activeNodeId) : null;
      const later = parseLater(value.later, mapNode, nodesById);
      const project = parseProject(value.project);
      return {
        id,
        title: typeof value.title === "string" && value.title ? value.title : "Imported",
        createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
        updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
        rootId,
        activeNodeId: activeRaw && nodesById.has(activeRaw) ? activeRaw : rootId,
        ...(later.length > 0 ? { later } : {}),
        ...(project ? { project } : {}),
        ...(value.titleSource === "auto" || value.titleSource === "set" ? { titleSource: value.titleSource } : {}),
        ...(typeof value.pacing === "boolean" ? { pacing: value.pacing } : {}),
        ...(typeof value.archivedAt === "number" ? { archivedAt: value.archivedAt } : {}),
        ...parseArchivedBranches(value.archivedBranches, mapNode, nodesById),
      };
    });

  // Nodes whose conversation is missing get one, so no tree is lost.
  const knownConversations = new Set(conversations.map((c) => c.id));
  for (const node of nodes) {
    if (knownConversations.has(node.conversationId)) continue;
    const conversation: Conversation = {
      id: node.conversationId,
      title: "Imported",
      createdAt: node.createdAt,
      updatedAt: node.createdAt,
      rootId: node.parentId === null ? node.id : null,
      activeNodeId: null,
    };
    conversations.push(conversation);
    knownConversations.add(conversation.id);
  }

  const templates: Partial<Record<TemplateId, string>> = {};
  if (Array.isArray(json.templates)) {
    for (const entry of json.templates) {
      if (!isRecord(entry)) continue;
      const id = entry.id;
      if (typeof id === "string" && (TEMPLATE_IDS as string[]).includes(id)) {
        if (typeof entry.body === "string") templates[id as TemplateId] = entry.body;
      }
    }
  }

  return { conversations, nodes, templates, remapped: collides };
}

/* ------------------------------------------------------------------ */

/**
 * What a reply produced through the Claude Code bridge recorded about itself.
 * Malformed entries are dropped one by one rather than failing the import: this
 * is a record of what happened, not something the tree depends on.
 */
function parseBridgeRecord(value: Record<string, unknown>): Partial<ConversationNode> {
  const out: Partial<ConversationNode> = {};
  if (value.harness === "claude-code") out.harness = "claude-code";
  if (isEffort(value.effort)) out.effort = value.effort;
  if (typeof value.pacing === "boolean") out.pacing = value.pacing;
  if (Array.isArray(value.toolUse)) {
    const toolUse = value.toolUse
      .filter(isRecord)
      .filter((t) => typeof t.name === "string")
      .map((t) => ({ name: t.name as string, query: typeof t.query === "string" ? t.query : "" }));
    if (toolUse.length > 0) out.toolUse = toolUse;
  }
  if (isRecord(value.usage)) {
    const u = value.usage;
    out.usage = {
      inputTokens: numberOr(u.inputTokens, 0),
      cacheCreationInputTokens: numberOr(u.cacheCreationInputTokens, 0),
      cacheReadInputTokens: numberOr(u.cacheReadInputTokens, 0),
      outputTokens: numberOr(u.outputTokens, 0),
    };
  }
  return out;
}

/**
 * A question's files (P-43). Each is kept only whole — a kind, a name and its
 * data — so a hand-edited bundle cannot put a half-file into a prompt. Their
 * ids are local to the node and need no remap.
 */
function parseAttachments(value: unknown): Pick<ConversationNode, "attachments"> {
  if (!Array.isArray(value)) return {};
  const attachments: Attachment[] = value
    .filter(isRecord)
    .filter(
      (a) =>
        (a.kind === "image" || a.kind === "pdf" || a.kind === "text") &&
        typeof a.name === "string" &&
        typeof a.mediaType === "string" &&
        typeof a.data === "string",
    )
    .map((a) => ({
      id: typeof a.id === "string" ? a.id : newId("f"),
      kind: a.kind as AttachmentKind,
      name: a.name as string,
      mediaType: a.mediaType as string,
      data: a.data as string,
      bytes: numberOr(a.bytes, (a.data as string).length),
      ...(typeof a.width === "number" ? { width: a.width } : {}),
      ...(typeof a.height === "number" ? { height: a.height } : {}),
      ...(typeof a.pages === "number" ? { pages: a.pages } : {}),
      ...(a.convertedFrom === "docx" || a.convertedFrom === "pptx" ? { convertedFrom: a.convertedFrom } : {}),
    }));
  return attachments.length ? { attachments } : {};
}

/**
 * A conversation's parked passages. Their node ids go through the same remap as
 * everything else — a parked passage pointing at the pre-import id of its
 * message would be unaskable — and one whose message did not make it into the
 * bundle is dropped rather than kept as a dangling promise.
 */
/** A conversation's project: three names, kept only when all three are there. */
function parseProject(value: unknown): ConversationProject | null {
  if (!isRecord(value)) return null;
  const { slug, snapshot, name } = value;
  return typeof slug === "string" && typeof snapshot === "string" && typeof name === "string"
    ? { slug, snapshot, name }
    : null;
}

function parseLater(
  value: unknown,
  mapNode: (id: string) => string,
  nodesById: Map<NodeId, ConversationNode>,
): LaterItem[] {
  if (!Array.isArray(value)) return [];
  const out: LaterItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.anchor)) continue;
    const sourceNodeId = mapNode(String(entry.sourceNodeId ?? ""));
    if (!nodesById.has(sourceNodeId)) continue;
    out.push({
      id: typeof entry.id === "string" && entry.id ? entry.id : newId("l"),
      sourceNodeId,
      anchor: {
        start: numberOr(entry.anchor.start, 0),
        end: numberOr(entry.anchor.end, 0),
        text: typeof entry.anchor.text === "string" ? entry.anchor.text : "",
        ...(typeof entry.anchor.blockPath === "string"
          ? { blockPath: entry.anchor.blockPath }
          : {}),
      },
      createdAt: numberOr(entry.createdAt, Date.now()),
    });
  }
  return out;
}

function parseOrigin(
  value: unknown,
  mapNode: (id: string) => string,
): ConversationNode["origin"] {
  if (!isRecord(value)) return null;
  const kinds = [
    "continuation",
    "regenerate",
    "concept-lens",
    "structural-crop",
    "isolated-selection",
    "quote-reply",
  ];
  if (typeof value.kind !== "string" || !kinds.includes(value.kind)) return null;
  const anchor = isRecord(value.anchor)
    ? {
        start: numberOr(value.anchor.start, 0),
        end: numberOr(value.anchor.end, 0),
        text: typeof value.anchor.text === "string" ? value.anchor.text : "",
        ...(typeof value.anchor.blockPath === "string"
          ? { blockPath: value.anchor.blockPath }
          : {}),
      }
    : undefined;
  return {
    kind: value.kind as NonNullable<ConversationNode["origin"]>["kind"],
    sourceNodeId: mapNode(String(value.sourceNodeId ?? "")),
    ...(anchor ? { anchor } : {}),
  };
}

/**
 * Reconstruct a policy from an export file.
 *
 * This is deserialization, not authoring: `planSubmission()` in draft.ts stays
 * the only place a policy is *chosen* for a new node. Anything unrecognised
 * degrades to full-ancestry rather than throwing, so one field invented by a
 * future version cannot cost the user their conversation.
 */
function parsePolicy(
  value: unknown,
  mapNode: (id: string) => string,
): ConversationNode["contextPolicy"] {
  if (!isRecord(value)) return { kind: "full-ancestry" };
  switch (value.kind) {
    case "windowed":
      return {
        kind: "windowed",
        turns: numberOr(value.turns, 2),
        upToNodeId: mapNode(String(value.upToNodeId ?? "")),
        ...(typeof value.passage === "string" ? { passage: value.passage } : {}),
      };
    case "truncated":
      return {
        kind: "truncated",
        upToNodeId: mapNode(String(value.upToNodeId ?? "")),
        charOffset: numberOr(value.charOffset, 0),
      };
    case "isolated":
      return {
        kind: "isolated",
        payload: typeof value.payload === "string" ? value.payload : "",
      };
    case "quoted":
      return {
        kind: "quoted",
        quote: typeof value.quote === "string" ? value.quote : "",
        base: value.base === "windowed" ? "windowed" : "full-ancestry",
        ...(value.turns === undefined ? {} : { turns: numberOr(value.turns, 2) }),
      };
    default:
      return { kind: "full-ancestry" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function bundleFilename(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `toondao-${stamp}.json`;
}

/**
 * A conversation's archived branches (P-58), through the same remap as its
 * nodes; one whose branch is not in the bundle is dropped.
 */
function parseArchivedBranches(
  raw: unknown,
  mapNode: (id: string) => string,
  nodesById: Map<string, ConversationNode>,
): { archivedBranches?: NodeId[] } {
  if (!Array.isArray(raw)) return {};
  const ids = raw
    .filter((id): id is string => typeof id === "string")
    .map(mapNode)
    .filter((id) => nodesById.has(id));
  return ids.length ? { archivedBranches: [...new Set(ids)] } : {};
}
