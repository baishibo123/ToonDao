import type {
  ChatMessage,
  ContextPolicy,
  ConversationNode,
  NodeId,
  NodeStore,
  TemplateSet,
} from "@/types";
import { asBlockquote, renderTemplate } from "@/lib/templates";

/**
 * THE prompt constructor. Pure, synchronous, deterministic.
 *
 * This is the ONLY place in the codebase where a message array is built.
 * If you find yourself assembling messages anywhere else, you are collapsing
 * Graph A into Graph B and the change is wrong regardless of how much simpler
 * it looks. See §1 of SPEC.md.
 */

export interface AssembleOptions {
  /** Global system prompt from settings. Applied to every policy, including
   *  `isolated` (§3: "no system prompt inheritance beyond the global one"). */
  systemPrompt?: string;
  /** Append the `pacing` template to the system message. Global, like the
   *  system prompt, so it reaches every policy the same way. */
  pacing?: boolean;
}

export function assembleContext(
  node: ConversationNode,
  store: NodeStore,
  templates: TemplateSet,
  opts: AssembleOptions = {},
): ChatMessage[] {
  // An assistant node does not own a policy; its payload is whatever was sent
  // to produce it, which is its parent user node's payload. Delegating here
  // lets the inspector open on any node in the tree.
  if (node.role === "assistant") {
    const parent = node.parentId ? store.get(node.parentId) : undefined;
    if (!parent) return withSystem([], opts, templates);
    return assembleContext(parent, store, templates, opts);
  }

  const policy = node.contextPolicy;

  switch (policy.kind) {
    case "full-ancestry":
      return withSystem(
        lineageMessages(node, store, templates, { inclusive: true }),
        opts,
        templates,
      );

    case "windowed": {
      const window = windowedMessages(
        policy.upToNodeId,
        policy.turns,
        store,
        templates,
      );
      const body = renderTemplate(templates.concept_lens, {
        context_turns: asProse(window),
        concept: node.content,
      });
      return withSystem([{ role: "user", content: body }], opts, templates);
    }

    case "truncated": {
      const source = store.get(policy.upToNodeId);
      const before = source?.parentId
        ? lineageMessages(store.get(source.parentId)!, store, templates, {
            inclusive: true,
          })
        : [];
      const head = source
        ? source.content.slice(0, clampOffset(policy.charOffset, source.content))
        : "";
      // Everything after charOffset is discarded here and can never re-enter
      // the payload: the tail is not read again anywhere below this line.
      const truncated: ChatMessage[] = source
        ? [...before, { role: source.role, content: head }]
        : before;
      const body = renderTemplate(templates.structural_crop, {
        truncated_context: asProse(truncated),
      });
      return withSystem([{ role: "user", content: appendNote(body, node) }], opts, templates);
    }

    case "isolated": {
      const body = renderTemplate(templates.isolated_selection, {
        selection: policy.payload,
      });
      return withSystem([{ role: "user", content: appendNote(body, node) }], opts, templates);
    }

    case "quoted": {
      const parent = node.parentId ? store.get(node.parentId) : undefined;
      let base: ChatMessage[] = [];
      if (parent) {
        base =
          policy.base === "windowed"
            ? windowedMessages(parent.id, policy.turns ?? 2, store, templates)
            : lineageMessages(parent, store, templates, { inclusive: true });
      }
      const body = `${asBlockquote(policy.quote)}\n\n${node.content}`.trimEnd();
      return withSystem([...base, { role: "user", content: body }], opts, templates);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Lineage walking                                                     */
/* ------------------------------------------------------------------ */

/**
 * Walk `parentId` to root, reverse.
 *
 * DECISION (docs/decisions.md, A-1): the walk stops at — and includes —
 * a node whose own policy is `isolated`. An isolated node declared itself a
 * fresh start; letting its descendants silently re-inherit the ancestry it
 * deliberately excluded would make §5.3 a lie one turn later. Isolated nodes
 * are therefore *context roots*: lineage continues above them in Graph A, and
 * stops there in Graph B.
 */
export function lineageChain(
  node: ConversationNode,
  store: NodeStore,
  { inclusive }: { inclusive: boolean },
): ConversationNode[] {
  const chain: ConversationNode[] = [];
  let cursor: ConversationNode | undefined = inclusive
    ? node
    : node.parentId
      ? store.get(node.parentId)
      : undefined;
  const seen = new Set<NodeId>();

  while (cursor) {
    if (seen.has(cursor.id)) break; // defensive: a cycle must not hang the UI
    seen.add(cursor.id);
    chain.push(cursor);
    if (isContextRoot(cursor)) break;
    cursor = cursor.parentId ? store.get(cursor.parentId) : undefined;
  }
  return chain.reverse();
}

export function isContextRoot(node: ConversationNode): boolean {
  return node.role === "user" && node.contextPolicy.kind === "isolated";
}

function lineageMessages(
  node: ConversationNode,
  store: NodeStore,
  templates: TemplateSet,
  opts: { inclusive: boolean },
): ChatMessage[] {
  return lineageChain(node, store, opts).map((n) => ({
    role: n.role,
    content: ancestorContent(n, templates),
  }));
}

/**
 * The last `turns` user/assistant *pairs* ending at `upToNodeId`.
 * Trims a leading orphan assistant message so the window always opens on a
 * user turn — a window that starts mid-exchange reads as corrupt to the model.
 */
function windowedMessages(
  upToNodeId: NodeId,
  turns: number,
  store: NodeStore,
  templates: TemplateSet,
): ChatMessage[] {
  const target = store.get(upToNodeId);
  if (!target) return [];
  const all = lineageMessages(target, store, templates, { inclusive: true });
  const wanted = Math.max(1, Math.floor(turns)) * 2;
  const slice = all.slice(Math.max(0, all.length - wanted));
  while (slice.length > 1 && slice[0].role === "assistant") slice.shift();
  return slice;
}

/**
 * What an ancestor message looked like *in the prompt*.
 *
 * For user nodes carrying a gesture policy this is the human-readable ask
 * (`content`), not the re-rendered template — re-inlining a window or a crop
 * that is already present as real ancestry would duplicate it. The exception is
 * a node whose policy carries the context itself (`isolated`, `quoted`):
 * dropping that payload would leave the following assistant reply answering a
 * question that is no longer in the transcript.
 */
function ancestorContent(node: ConversationNode, templates: TemplateSet): string {
  if (node.role === "assistant") return node.content;
  const policy = node.contextPolicy;
  switch (policy.kind) {
    case "isolated":
      return appendNote(
        renderTemplate(templates.isolated_selection, {
          selection: policy.payload,
        }),
        node,
      );
    case "quoted":
      return `${asBlockquote(policy.quote)}\n\n${node.content}`.trimEnd();
    default:
      return node.content;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** `User: ...` / `Assistant: ...`. Plain and unadorned — it is read as prose. */
export function asProse(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

/**
 * `structural_crop` and `isolated_selection` are self-contained instructions
 * with no slot for the user's own words, but the composer still lets them type.
 * Their note is appended as a trailing paragraph rather than silently dropped.
 */
function appendNote(body: string, node: ConversationNode): string {
  const note = node.content.trim();
  if (!note) return body;
  return `${body}\n\n${note}`;
}

function clampOffset(offset: number, content: string): number {
  if (!Number.isFinite(offset)) return content.length;
  return Math.max(0, Math.min(Math.floor(offset), content.length));
}

/**
 * The one system message: the user's own prompt first, then the pacing
 * instruction when it is on. Either may be absent; with neither, there is no
 * system message at all.
 */
function withSystem(
  messages: ChatMessage[],
  opts: AssembleOptions,
  templates: TemplateSet,
): ChatMessage[] {
  const parts = [
    opts.systemPrompt?.trim() ?? "",
    opts.pacing ? (templates.pacing ?? "").trim() : "",
  ].filter(Boolean);
  if (parts.length === 0) return messages;
  return [{ role: "system", content: parts.join("\n\n") }, ...messages];
}

/* ------------------------------------------------------------------ */
/* Inspector support                                                   */
/* ------------------------------------------------------------------ */

export function policyLabel(policy: ContextPolicy): string {
  switch (policy.kind) {
    case "full-ancestry":
      return "full ancestry";
    case "windowed":
      return `windowed · ${policy.turns} turn${policy.turns === 1 ? "" : "s"}`;
    case "truncated":
      return "cropped";
    case "isolated":
      return "isolated";
    case "quoted":
      return "quoted";
  }
}

/** Human-readable dump of an assembled payload, for the inspector and for
 *  `assembledPreview`. This is a *record*, not a prompt — never send it. */
export function formatPayload(messages: ChatMessage[]): string {
  return messages
    .map((m) => `### ${m.role}\n${m.content}`)
    .join("\n\n---\n\n");
}
