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
  const none: ReadonlySet<NodeId> = new Set();

  switch (policy.kind) {
    case "full-ancestry":
      return withSystem(lineageMessages(node, store, templates, none), opts, templates);

    // A departure is sent as one user message (A-2), and the same text stands
    // in for everything above the aside in every later turn there (P-27), so
    // it is built in one place.
    case "windowed":
    case "truncated":
    case "isolated":
      return withSystem(
        [{ role: "user", content: departurePrompt(node, store, templates, none) }],
        opts,
        templates,
      );

    case "quoted": {
      const parent = node.parentId ? store.get(node.parentId) : undefined;
      let base: ChatMessage[] = [];
      if (parent) {
        base =
          policy.base === "windowed"
            ? windowedMessages(parent.id, policy.turns ?? 2, store, templates, none)
            : lineageMessages(parent, store, templates, none);
      }
      const body = `${asBlockquote(policy.quote)}\n\n${node.content}`.trimEnd();
      return withSystem([...base, { role: "user", content: body }], opts, templates);
    }
  }
}

/**
 * The one user message a departure is sent as: its template, filled with the
 * context it carved out of the conversation it left — a window of turns, the
 * conversation up to a cut, or a passage alone.
 *
 * A window or a cut is read from lineage that may itself start at an earlier
 * departure (an aside inside an aside), so this recurses. In a well-formed
 * tree it only ever moves upward; `visiting` keeps a corrupt cycle from
 * hanging the UI.
 */
function departurePrompt(
  node: ConversationNode,
  store: NodeStore,
  templates: TemplateSet,
  visiting: ReadonlySet<NodeId>,
): string {
  if (visiting.has(node.id)) return node.content;
  const inner = new Set(visiting).add(node.id);
  const policy = node.contextPolicy;

  switch (policy.kind) {
    case "windowed": {
      const window = windowedMessages(policy.upToNodeId, policy.turns, store, templates, inner);
      return renderTemplate(templates.concept_lens, {
        context_turns: asProse(window),
        concept: node.content,
      });
    }

    case "truncated": {
      const source = store.get(policy.upToNodeId);
      const above = source?.parentId ? store.get(source.parentId) : undefined;
      const before = above ? lineageMessages(above, store, templates, inner) : [];
      const head = source
        ? source.content.slice(0, clampOffset(policy.charOffset, source.content))
        : "";
      // Everything after charOffset is discarded here and can never re-enter
      // the payload: the tail is not read again anywhere below this line, and
      // later turns in the aside carry this text instead of the source (P-27).
      const truncated: ChatMessage[] = source
        ? [...before, { role: source.role, content: head }]
        : before;
      const body = renderTemplate(templates.structural_crop, {
        truncated_context: asProse(truncated),
      });
      return appendNote(body, node);
    }

    case "isolated":
      return appendNote(
        renderTemplate(templates.isolated_selection, { selection: policy.payload }),
        node,
      );

    case "full-ancestry":
    case "quoted":
      return node.content;
  }
}

/* ------------------------------------------------------------------ */
/* Lineage walking                                                     */
/* ------------------------------------------------------------------ */

/**
 * Walk `parentId` to root, reverse — stopping at, and including, the nearest
 * context root. Lineage continues above a root in Graph A; the walk that builds
 * context (Graph B) stops there.
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

/**
 * Does this node start a context of its own?
 *
 * DECISION (docs/decisions.md, P-27, generalising A-1): every departure is a
 * context root — `isolated`, `windowed` and `truncated`. An aside exists to
 * leave the conversation with just enough of it; a later turn that re-inherited
 * the whole ancestry, or the tail a crop discarded, would break that promise
 * one turn after it was made.
 *
 * This must agree with `plan.forks` in `planSubmission()` — a gesture that
 * opens an aside is exactly one that starts a context — and a test holds the
 * two together. It reads the policy, never the origin: context is decided by
 * Graph B alone.
 */
export function isContextRoot(node: ConversationNode): boolean {
  if (node.role !== "user") return false;
  switch (node.contextPolicy.kind) {
    case "isolated":
    case "windowed":
    case "truncated":
      return true;
    case "full-ancestry":
    case "quoted":
      return false;
  }
}

/**
 * The departure whose promise a message is under: the root of the aside it was
 * asked in. Null on the thread, and null for a root itself, whose own policy
 * already says what it carried. A reply answers for its question.
 */
export function contextStart(
  node: ConversationNode,
  store: NodeStore,
): ConversationNode | null {
  const asked =
    node.role === "assistant" ? (node.parentId ? store.get(node.parentId) : undefined) : node;
  if (!asked) return null;
  const first = lineageChain(asked, store, { inclusive: true })[0];
  return first && first.id !== asked.id && isContextRoot(first) ? first : null;
}

function lineageMessages(
  node: ConversationNode,
  store: NodeStore,
  templates: TemplateSet,
  visiting: ReadonlySet<NodeId>,
): ChatMessage[] {
  return lineageChain(node, store, { inclusive: true }).map((n) => ({
    role: n.role,
    content: ancestorContent(n, store, templates, visiting),
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
  visiting: ReadonlySet<NodeId>,
): ChatMessage[] {
  const target = store.get(upToNodeId);
  if (!target) return [];
  const all = lineageMessages(target, store, templates, visiting);
  const wanted = Math.max(1, Math.floor(turns)) * 2;
  const slice = all.slice(Math.max(0, all.length - wanted));
  while (slice.length > 1 && slice[0].role === "assistant") slice.shift();
  return slice;
}

/**
 * What an ancestor message looked like *in the prompt*.
 *
 * A context root is always the first message of the walk, and it stands in for
 * everything above it, so it contributes the prompt it was sent as — without
 * it, the reply below would be answering a question no longer in the
 * transcript. A quote keeps its blockquote for the same reason. Any other user
 * node contributes its human-readable ask.
 */
function ancestorContent(
  node: ConversationNode,
  store: NodeStore,
  templates: TemplateSet,
  visiting: ReadonlySet<NodeId>,
): string {
  if (node.role === "assistant") return node.content;
  if (isContextRoot(node)) return departurePrompt(node, store, templates, visiting);
  const policy = node.contextPolicy;
  if (policy.kind === "quoted") return `${asBlockquote(policy.quote)}\n\n${node.content}`.trimEnd();
  return node.content;
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
/* Naming a conversation (P-34)                                        */
/* ------------------------------------------------------------------ */

/** How much of a conversation a title request carries, in characters. */
export const TITLE_BUDGET = { askChars: 240, asks: 5, answerChars: 400 } as const;

/**
 * The request that names a conversation: the `title` template filled with the
 * person's messages on the thread and the opening of the latest reply, each
 * clipped. Nothing else — no system prompt, no pacing, no earlier answers — so
 * it stays a few hundred tokens however long the conversation grows.
 *
 * `spine` is the thread, root first. With more asks than fit, the first and the
 * latest are kept: where the conversation began, and where it has gone.
 */
export function assembleTitle(spine: readonly ConversationNode[], templates: TemplateSet): ChatMessage[] {
  const clip = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const asks = spine.filter((n) => n.role === "user" && n.content.trim());
  const kept =
    asks.length <= TITLE_BUDGET.asks
      ? asks
      : [asks[0], ...asks.slice(asks.length - (TITLE_BUDGET.asks - 1))].filter(
          (n): n is ConversationNode => Boolean(n),
        );
  const answer = [...spine].reverse().find((n) => n.role === "assistant" && n.content.trim());
  const body = renderTemplate(templates.title, {
    asks: kept.map((n) => `- ${clip(n.content, TITLE_BUDGET.askChars)}`).join("\n"),
    answer: answer ? clip(answer.content, TITLE_BUDGET.answerChars) : "(no answer yet)",
  });
  return [{ role: "user", content: body }];
}

/* ------------------------------------------------------------------ */
/* Inspector support                                                   */
/* ------------------------------------------------------------------ */

/**
 * `start` is the policy of the aside a later turn is under (`contextStart()`):
 * such a turn is `full-ancestry` by policy, but its ancestry begins at the
 * aside, and the label says so.
 */
export function policyLabel(policy: ContextPolicy, start?: ContextPolicy): string {
  switch (policy.kind) {
    case "full-ancestry":
      return start ? "this aside" : "full ancestry";
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
