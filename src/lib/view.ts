/**
 * What a conversation looked like when it was last on screen (P-50): its open
 * asides, the unsent words in each box and where each pane was scrolled. Kept
 * on the conversation record, so a reload — or a trip to another conversation
 * and back — puts the reader back where they were instead of at the bottom of
 * the thread with nothing open.
 *
 * Pure: picking what survives and checking it against the tree are tested
 * without a database or a DOM. The writing lives in `src/store/viewPersistence.ts`.
 */
import type { Conversation, NodeId } from "@/types";
import type { AsideFrame, PendingGesture } from "@/store/useUI";
import type { AskAgainSeed } from "@/lib/draft";
import type { NodeMap } from "@/lib/tree";

/** One box's unsent question: its words, files and the choices made for it. */
export interface ComposerDraft extends AskAgainSeed {
  /**
   * What a rewind put in the box (P-44), so backing out of the rewind empties
   * it again only while the words are still the ones it put there.
   */
  prefilled?: { nodeId: NodeId; text: string };
}

/**
 * Where a pane was scrolled: the first message showing at its top, and how far
 * into that message. A message survives a change of layout that would make a
 * pixel offset point somewhere else. A pane at its end has no mark: the end is
 * where a pane starts, and it keeps following a reply from there.
 */
export interface ScrollMark {
  nodeId: NodeId;
  offset: number;
}

export interface ConversationView {
  /** When this was written. The newest is the conversation open at a reload. */
  savedAt: number;
  /** Outermost first, each with the gesture it was opened for if unsent. */
  asides: AsideFrame[];
  wideAsideId: string | null;
  /** The thread's unsent quote or rewind. */
  pending: PendingGesture | null;
  /** By `draftKey()`; a box with nothing in it is left out. */
  drafts: Record<string, ComposerDraft>;
  /** By `draftKey()`; a pane at its end is left out. */
  scroll: Record<string, ScrollMark>;
  /** Outline rows folded shut: the conversation's own id and branch heads. */
  collapsed?: string[];
}

/** The part of the UI a view is made from and restored into. */
export interface ViewState {
  asides: AsideFrame[];
  wideAsideId: string | null;
  pending: PendingGesture | null;
  drafts: Record<string, ComposerDraft>;
  collapsedRows: Set<string>;
}

export interface RestoredView extends ViewState {
  scroll: Record<string, ScrollMark>;
}

export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  model: null,
  effort: null,
  pacing: null,
};

export function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.text === "" &&
    draft.attachments.length === 0 &&
    draft.model === null &&
    draft.effort === null &&
    draft.pacing === null &&
    !draft.prefilled
  );
}

/** The key the thread's own surface uses, the same one `draftKey()` gives it. */
const THREAD_KEY = "__draft__";
const asideKey = (id: string) => `${THREAD_KEY}:${id}`;

/** What of the UI survives a reload, as it stands now. */
export function snapshotView(
  ui: ViewState,
  scroll: Record<string, ScrollMark>,
  now: number = Date.now(),
): ConversationView {
  const drafts: Record<string, ComposerDraft> = {};
  for (const [key, draft] of Object.entries(ui.drafts)) {
    if (!isEmptyDraft(draft)) drafts[key] = draft;
  }
  return {
    savedAt: now,
    asides: ui.asides,
    wideAsideId: ui.wideAsideId,
    pending: ui.pending,
    drafts,
    scroll: { ...scroll },
    collapsed: [...ui.collapsedRows],
  };
}

/**
 * A saved view, checked against the tree it is reopened over. Messages can be
 * deleted after a view was written, or by an older build that never read it:
 * an aside whose messages are gone closes, and every aside opened from inside
 * it closes too, because its breadcrumb no longer leads home. A gesture about a
 * deleted message is dropped; a draft or a scroll mark goes with its pane.
 */
export function restoreView(
  view: ConversationView | undefined,
  nodes: NodeMap,
  conversationId: string,
): RestoredView {
  const empty: RestoredView = {
    asides: [], wideAsideId: null, pending: null, drafts: {}, scroll: {}, collapsedRows: new Set(),
  };
  if (!view || typeof view !== "object") return empty;

  const asides: AsideFrame[] = [];
  for (const frame of Array.isArray(view.asides) ? view.asides : []) {
    if (!frame || frame.conversationId !== conversationId) break;
    if (!nodes[frame.sourceNodeId]) break;
    if (frame.rootNodeId && !nodes[frame.rootNodeId]) break;
    if (!frame.rootNodeId && !gestureHolds(frame.pending, nodes)) break;
    const activeNodeId =
      frame.activeNodeId && nodes[frame.activeNodeId] ? frame.activeNodeId : frame.rootNodeId;
    const pending = gestureHolds(frame.pending, nodes) ? frame.pending : null;
    asides.push({ ...frame, activeNodeId, pending });
  }

  const surfaces = new Set([THREAD_KEY, ...asides.map((f) => asideKey(f.id))]);
  const drafts: Record<string, ComposerDraft> = {};
  for (const [key, draft] of Object.entries(view.drafts ?? {})) {
    if (!surfaces.has(key) || !draft || typeof draft.text !== "string") continue;
    const prefilled = draft.prefilled && nodes[draft.prefilled.nodeId] ? draft.prefilled : undefined;
    drafts[key] = {
      text: draft.text,
      attachments: Array.isArray(draft.attachments) ? draft.attachments : [],
      model: draft.model ?? null,
      effort: draft.effort ?? null,
      pacing: typeof draft.pacing === "boolean" ? draft.pacing : null,
      ...(prefilled ? { prefilled } : {}),
    };
  }

  const scroll: Record<string, ScrollMark> = {};
  for (const [key, mark] of Object.entries(view.scroll ?? {})) {
    if (surfaces.has(key) && mark && nodes[mark.nodeId] && Number.isFinite(mark.offset)) {
      scroll[key] = { nodeId: mark.nodeId, offset: mark.offset };
    }
  }

  // A folded row stays folded while its branch is still there.
  const collapsedRows = new Set(
    (Array.isArray(view.collapsed) ? view.collapsed : []).filter(
      (id) => id === conversationId || Boolean(nodes[id]),
    ),
  );

  const last = asides.at(-1);
  return {
    asides,
    wideAsideId: last && view.wideAsideId === last.id ? last.id : null,
    pending: gestureHolds(view.pending, nodes) ? view.pending : null,
    drafts,
    scroll,
    collapsedRows,
  };
}

/** Whether a gesture still has the messages it is about. */
function gestureHolds(gesture: PendingGesture | null | undefined, nodes: NodeMap): gesture is PendingGesture {
  if (!gesture || typeof gesture !== "object") return false;
  if (gesture.kind === "rewind") {
    return Boolean(nodes[gesture.nodeId] && nodes[gesture.parentId]) &&
      (!gesture.quote || Boolean(nodes[gesture.quote.sourceNodeId]));
  }
  return Boolean(nodes[gesture.sourceNodeId]);
}

/**
 * The conversation to open at a reload: the one whose view was written last,
 * which is the one that was on screen. Without any, the most recently updated.
 * `conversations` is newest-updated first, as the sidebar lists them.
 */
export function lastOpened(conversations: Conversation[]): Conversation | undefined {
  let best: Conversation | undefined;
  for (const c of conversations) {
    const at = c.view?.savedAt;
    if (typeof at === "number" && (!best || at > (best.view?.savedAt ?? -1))) best = c;
  }
  return best ?? conversations[0];
}
