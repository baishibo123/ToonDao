import type {
  BranchOrigin,
  ContextPolicy,
  ConversationNode,
  NodeId,
  TextAnchor,
} from "@/types";
import type { PendingGesture } from "@/store/useUI";

/**
 * Gesture → policy. The single mapping.
 *
 * §2 of SPEC.md: "Do not implement them as five special cases." This is where
 * the five interactions become five values of one union, and it is the only
 * place a ContextPolicy is ever constructed for a new node. The composer, the
 * selection toolbar and the concept popover all route through here, so they
 * cannot drift into inventing policies of their own.
 */

export interface SubmissionPlan {
  parentId: NodeId | null;
  policy: ContextPolicy;
  origin: BranchOrigin | null;
  /** Becomes node.content — the human-readable ask. */
  content: string;
  /** False when the gesture deliberately continues the current path (§5.4). */
  forks: boolean;
}

export function planSubmission(args: {
  text: string;
  pending: PendingGesture | null;
  activeLeafId: NodeId | null;
  /** Raw markdown of the crop source, needed to size the discarded tail. */
  sourceContent?: string;
}): SubmissionPlan {
  const text = args.text.trim();
  const { pending, activeLeafId } = args;

  if (!pending) {
    // §5.5 — ordinary chat. Must feel like a completely normal chat client.
    return {
      parentId: activeLeafId,
      policy: { kind: "full-ancestry" },
      origin: activeLeafId
        ? { kind: "continuation", sourceNodeId: activeLeafId }
        : null,
      content: text,
      forks: false,
    };
  }

  switch (pending.kind) {
    // §5.4 — the messaging-app gesture. The one of the four that extends the
    // current path instead of opening a branch, because that is the social
    // convention it borrows from.
    case "quote":
      return {
        parentId: activeLeafId,
        policy: {
          kind: "quoted",
          quote: pending.anchor.text,
          base: "full-ancestry",
        },
        origin: {
          kind: "quote-reply",
          sourceNodeId: pending.sourceNodeId,
          anchor: pending.anchor,
        },
        content: text,
        forks: false,
      };

    // Not one of the five: an ordinary turn taken off an earlier message rather
    // than off the end of the thread. Same policy as §5.5 chat — full ancestry,
    // a continuation edge — and the only thing that makes it a departure is
    // *where* it attaches. It forks, so it opens a window: two ordinary lines of
    // thought off one message are two conversations, and the invariant is that a
    // window is one linear spine.
    case "fork":
      return {
        parentId: pending.sourceNodeId,
        policy: { kind: "full-ancestry" },
        origin: { kind: "continuation", sourceNodeId: pending.sourceNodeId },
        content: text,
        forks: true,
      };

    // §5.3 — lineage without inheritance.
    case "isolated":
      return {
        parentId: pending.sourceNodeId,
        policy: { kind: "isolated", payload: pending.anchor.text },
        origin: {
          kind: "isolated-selection",
          sourceNodeId: pending.sourceNodeId,
          anchor: pending.anchor,
        },
        content: text,
        forks: true,
      };

    // §5.1 — a narrow window plus the concept template.
    case "concept":
      return {
        parentId: pending.sourceNodeId,
        policy: {
          kind: "windowed",
          turns: pending.turns,
          upToNodeId: pending.sourceNodeId,
        },
        origin: {
          kind: "concept-lens",
          sourceNodeId: pending.sourceNodeId,
          anchor: pending.anchor,
        },
        // An empty ask means "explain this term", so the anchored text *is*
        // the concept.
        content: text || pending.anchor.text,
        forks: true,
      };

    // §5.2 — the flagship. The tail is discarded from the prompt only; the
    // source node's content is never mutated.
    case "crop":
      return {
        parentId: pending.sourceNodeId,
        policy: {
          kind: "truncated",
          upToNodeId: pending.sourceNodeId,
          charOffset: pending.charOffset,
        },
        origin: {
          kind: "structural-crop",
          sourceNodeId: pending.sourceNodeId,
          anchor: cutAnchor(pending.charOffset, pending.blockPath),
        },
        content: text,
        forks: true,
      };
  }
}

/**
 * A crop is anchored to a *point*, not a range: the cut line. A zero-length
 * anchor keeps `text === content.slice(start, end)` true, and the discarded
 * tail stays recoverable from the source node, which is never mutated — so
 * copying it in here would only be a second, staler copy.
 */
function cutAnchor(charOffset: number, blockPath: string): TextAnchor {
  return { start: charOffset, end: charOffset, text: "", blockPath };
}

/**
 * Does this gesture leave the conversation you are reading — and so open an
 * aside beside it, rather than docking into the composer you are typing in?
 *
 * Derived from `plan.forks` rather than re-listed as a set of kinds, because it
 * is the same question asked in the UI's vocabulary: a gesture that opens a
 * branch opens an aside, and a gesture that continues the path you are reading
 * stays in its composer (§5.4 — a quote reply is the messaging-app gesture, and
 * messaging apps do not open anything for a reply). Keeping the two answers
 * derived from one another means a gesture can never fork in the payload while
 * behaving like a reply on screen.
 */
export function gestureOpensAside(pending: PendingGesture | null): boolean {
  if (!pending) return false;
  return planSubmission({ text: "", pending, activeLeafId: null }).forks;
}

/** Can this plan be sent? */
export function planIsSendable(plan: SubmissionPlan, pending: PendingGesture | null): boolean {
  if (plan.content.trim().length > 0) return true;
  // These three carry their own context, so an empty ask is meaningful.
  return pending?.kind === "isolated" || pending?.kind === "crop" || pending?.kind === "concept";
}

/**
 * A throwaway node used only to preview a payload before it is sent. It is
 * never persisted and never enters the store — it exists so the composer's
 * chip can show the real assembled payload rather than an approximation.
 */
export function draftNode(
  plan: SubmissionPlan,
  conversationId: string,
): ConversationNode {
  return {
    id: "__draft__",
    conversationId,
    parentId: plan.parentId,
    childrenIds: [],
    role: "user",
    content: plan.content,
    createdAt: Date.now(),
    status: "complete",
    origin: plan.origin,
    contextPolicy: plan.policy,
  };
}
