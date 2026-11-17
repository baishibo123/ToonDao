import { create } from "zustand";
import type { NodeId, TextAnchor } from "@/types";
import { newId } from "@/lib/id";
import type { AskAgainSeed } from "@/lib/draft";
import { EMPTY_DRAFT, type ComposerDraft, type RestoredView, type ScrollMark } from "@/lib/view";

/**
 * What the reader is in the middle of doing. Most of it is gone at a reload;
 * the part a reader would have to rebuild — the open asides, the gesture
 * waiting in a box, the unsent words, where each pane was — is written to the
 * conversation's `view` (P-50, `src/store/viewPersistence.ts`) and comes back
 * through `restore()`.
 */

/** A gesture that has been started but not yet sent. It determines the policy,
 *  origin and parent of the next submit. */
export type PendingGesture =
  | { kind: "quote"; sourceNodeId: NodeId; anchor: TextAnchor }
  | { kind: "isolated"; sourceNodeId: NodeId; anchor: TextAnchor }
  | { kind: "concept"; sourceNodeId: NodeId; anchor: TextAnchor; turns: number }
  | {
      kind: "crop";
      sourceNodeId: NodeId;
      charOffset: number;
      blockPath: string;
      discardedChars: number;
    }
  /**
   * Asking an earlier question of the thread again (P-44). The new question
   * goes under the same reply and takes the thread over; `quote` keeps the
   * passage a quote reply answered.
   */
  | {
      kind: "rewind";
      nodeId: NodeId;
      parentId: NodeId;
      quote?: { sourceNodeId: NodeId; anchor: TextAnchor };
    };

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SelectionState {
  nodeId: NodeId;
  anchor: TextAnchor;
  /** Viewport rect of the selection, for positioning the toolbar. */
  rect: Rect;
  /** Set when the selection was made inside an aside, so a quote reply docks
   *  into that aside's composer rather than the thread's. */
  asideId?: string;
}

/**
 * A side conversation, docked beside the thread.
 *
 * WHY BESIDE, NOT IN. A lens, a crop or an isolation is not the next thing you
 * said — it is a second thing you are now doing, and the first is not finished.
 * Putting it in the thread would make the reader lose their place; putting it
 * beside the thread keeps the passage it came from readable while you read the
 * answer to it. That is how a margin works, and a margin never covers the text.
 *
 * WHY A STACK. An aside can raise a question of its own. Asking it opens a
 * deeper aside on the right, the aside it was asked in moves to the centre
 * (P-49), and the frames above it become the breadcrumb back: one side
 * conversation beside the line it left, with a way home.
 *
 * A frame is a *view*, not a container: the nodes it shows live in the same tree
 * as everything else, which is why nothing here is persisted — closing the pane
 * loses no conversation, and the outline can always reopen it.
 */
export interface AsideFrame {
  id: string;
  conversationId: string;
  /** The node the aside hangs off. */
  sourceNodeId: NodeId;
  /** The gesture that opened it. Cleared on the first send. */
  pending: PendingGesture | null;
  /** First node of the aside, once it exists. */
  rootNodeId: NodeId | null;
  /** Leaf inside the aside that its composer is attached to. */
  activeNodeId: NodeId | null;
}

/** Where an existing branch sits: what `showAsides()` needs to reopen it. */
export type AsideTarget = Pick<
  AsideFrame,
  "conversationId" | "sourceNodeId" | "rootNodeId" | "activeNodeId"
>;

interface UIState {
  pending: PendingGesture | null;
  setPending: (pending: PendingGesture | null) => void;

  selection: SelectionState | null;
  setSelection: (selection: SelectionState | null) => void;

  /** Node ids whose inspector is expanded. */
  openInspectors: Set<NodeId>;
  toggleInspector: (id: NodeId) => void;

  /** Crop rail hover state, so the message can dim its own tail. */
  cropHover: { nodeId: NodeId; charOffset: number } | null;
  setCropHover: (hover: { nodeId: NodeId; charOffset: number } | null) => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;

  /** Outline rows the user has collapsed. Absent means open: a conversation is
   *  mostly worth seeing, and hiding it by default hides the feature. */
  collapsedRows: Set<string>;
  toggleRow: (id: string) => void;
  setRowCollapsed: (id: string, collapsed: boolean) => void;

  /** Bumped to ask the transcript to scroll a node into view. */
  scrollTarget: { id: NodeId; nonce: number } | null;
  requestScrollTo: (id: NodeId) => void;

  composerFocusNonce: number;
  /**
   * Words, files and choices for the thread's composer to take once (P-44):
   * the first question of a conversation, asked again in a new one. The nonce
   * makes the same seed twice two requests.
   */
  composerSeed: (AskAgainSeed & { nonce: number }) | null;
  seedComposer: (seed: AskAgainSeed) => void;
  focusComposer: () => void;

  /**
   * Each box's unsent question, by `draftKey()`. In the store rather than the
   * composer so it can be written to the conversation and restored (P-50).
   */
  drafts: Record<string, ComposerDraft>;
  updateDraft: (key: string, patch: Partial<ComposerDraft> | ((draft: ComposerDraft) => Partial<ComposerDraft>)) => void;
  /** Where each pane should scroll back to once it is laid out; the nonce makes each restore one request. */
  restoredScroll: { marks: Record<string, ScrollMark>; nonce: number };
  /** Puts a saved view back on screen (P-50). */
  restore: (view: RestoredView) => void;

  /* -- asides ----------------------------------------------------- */

  /** Open side conversations, outermost first. The last is on the right, the one
   *  before it in the centre (`placeOf()`); all are its breadcrumb. Empty means
   *  only the thread is open. */
  asides: AsideFrame[];
  /** Opens an aside for a gesture that has not been sent yet. `from` is the
   *  aside it was started in; without it, the aside replaces the whole stack. */
  openAside: (args: {
    /** A rewind never opens an aside: it stays in the thread. */
    gesture: Exclude<PendingGesture, { kind: "rewind" }>;
    conversationId: string;
    from?: string;
  }) => string;
  /** Shows existing branches, outermost first — the chain that leads to one. */
  showAsides: (chain: AsideTarget[]) => void;
  closeAsides: () => void;
  /** Back up the breadcrumb, keeping `id` as the open aside. */
  popAsidesTo: (id: string) => void;
  /**
   * The aside that fills the whole canvas, for a closer look (P-49). It names a
   * frame, so it lapses by itself once that frame is no longer on the right.
   */
  wideAsideId: string | null;
  toggleWide: (id: string) => void;
  setAsidePending: (id: string, pending: PendingGesture | null) => void;
  setAsideTurns: (id: string, turns: number) => void;
  setAsideActive: (id: string, nodeId: NodeId) => void;
  /** Binds a freshly sent aside to the frame that sent it. */
  attachAside: (id: string, rootNodeId: NodeId, activeNodeId: NodeId) => void;
}

/**
 * The inspector key for a composer's own draft. Every surface gets its own, so
 * expanding the carried context in one aside does not expand it in all of them.
 */
export function draftKey(asideId?: string): string {
  return asideId ? `__draft__:${asideId}` : "__draft__";
}

export const useUI = create<UIState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending, selection: null }),

  selection: null,
  setSelection: (selection) => set({ selection }),

  openInspectors: new Set<NodeId>(),
  toggleInspector: (id) =>
    set((s) => {
      const next = new Set(s.openInspectors);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { openInspectors: next };
    }),

  cropHover: null,
  setCropHover: (cropHover) => set({ cropHover }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  collapsedRows: new Set<string>(),
  toggleRow: (id) =>
    set((s) => {
      const next = new Set(s.collapsedRows);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedRows: next };
    }),
  setRowCollapsed: (id, collapsed) =>
    set((s) => {
      const next = new Set(s.collapsedRows);
      if (collapsed) next.add(id);
      else next.delete(id);
      return { collapsedRows: next };
    }),

  scrollTarget: null,
  requestScrollTo: (id) =>
    set((s) => ({ scrollTarget: { id, nonce: (s.scrollTarget?.nonce ?? 0) + 1 } })),

  composerFocusNonce: 0,
  composerSeed: null,
  seedComposer: (seed) =>
    set((s) => ({ composerSeed: { ...seed, nonce: (s.composerSeed?.nonce ?? 0) + 1 }, pending: null, selection: null })),
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),

  drafts: {},
  updateDraft: (key, patch) =>
    set((s) => {
      const current = s.drafts[key] ?? EMPTY_DRAFT;
      const next = typeof patch === "function" ? patch(current) : patch;
      return { drafts: { ...s.drafts, [key]: { ...current, ...next } } };
    }),

  restoredScroll: { marks: {}, nonce: 0 },
  restore: (view) =>
    set((s) => {
      // An aside not yet sent shows what it will carry, as it did when opened.
      const openInspectors = withoutDrafts(s.openInspectors, s.asides, []);
      for (const f of view.asides) if (!f.rootNodeId) openInspectors.add(draftKey(f.id));
      return {
        asides: view.asides,
        wideAsideId: view.wideAsideId,
        pending: view.pending,
        drafts: view.drafts,
        collapsedRows: view.collapsedRows,
        selection: null,
        openInspectors,
        restoredScroll: { marks: view.scroll, nonce: s.restoredScroll.nonce + 1 },
      };
    }),

  asides: [],

  openAside: ({ gesture, conversationId, from }) => {
    const id = newId("s");
    set((s) => {
      const at = from ? s.asides.findIndex((f) => f.id === from) : -1;
      const kept = at >= 0 ? s.asides.slice(0, at + 1) : [];
      // Before the first send, what the aside will carry is the only thing in
      // it worth reading, so its payload starts expanded — in the same
      // transaction as the frame, or a collapsed inspector flashes first.
      const openInspectors = withoutDrafts(s.openInspectors, s.asides, kept);
      openInspectors.add(draftKey(id));
      return {
        openInspectors,
        drafts: keepDrafts(s.drafts, kept),
        selection: null,
        asides: [
          ...kept,
          {
            id,
            conversationId,
            sourceNodeId: gesture.sourceNodeId,
            pending: gesture,
            rootNodeId: null,
            activeNodeId: null,
          },
        ],
      };
    });
    return id;
  },

  showAsides: (chain) =>
    set((s) => {
      // Frames already showing the same branch at the same depth are kept, so
      // a half-typed follow-up survives being navigated back to. Only the
      // innermost frame moves: the node asked for is in it.
      const asides = chain.map((target, i): AsideFrame => {
        const existing = s.asides[i];
        const last = i === chain.length - 1;
        if (existing && existing.rootNodeId === target.rootNodeId) {
          return last ? { ...existing, activeNodeId: target.activeNodeId } : existing;
        }
        return { id: newId("s"), pending: null, ...target };
      });
      return {
        asides,
        drafts: keepDrafts(s.drafts, asides),
        openInspectors: withoutDrafts(s.openInspectors, s.asides, asides),
      };
    }),

  closeAsides: () =>
    set((s) => ({
      asides: [],
      drafts: keepDrafts(s.drafts, []),
      openInspectors: withoutDrafts(s.openInspectors, s.asides, []),
    })),

  popAsidesTo: (id) =>
    set((s) => {
      const at = s.asides.findIndex((f) => f.id === id);
      if (at === -1) return {};
      const asides = s.asides.slice(0, at + 1);
      return {
        asides,
        drafts: keepDrafts(s.drafts, asides),
        openInspectors: withoutDrafts(s.openInspectors, s.asides, asides),
      };
    }),

  wideAsideId: null,
  toggleWide: (id) => set((s) => ({ wideAsideId: s.wideAsideId === id ? null : id })),

  setAsidePending: (id, pending) =>
    set((s) => ({
      selection: null,
      asides: s.asides.map((f) => (f.id === id ? { ...f, pending } : f)),
    })),

  setAsideTurns: (id, turns) =>
    set((s) => ({
      asides: s.asides.map((f) =>
        f.id === id && f.pending?.kind === "concept"
          ? { ...f, pending: { ...f.pending, turns: clampTurns(turns) } }
          : f,
      ),
    })),

  setAsideActive: (id, nodeId) =>
    set((s) => ({
      asides: s.asides.map((f) => (f.id === id ? { ...f, activeNodeId: nodeId } : f)),
    })),

  attachAside: (id, rootNodeId, activeNodeId) =>
    set((s) => {
      const existing = s.asides.find((f) => f.id === id);
      // Expanded on open because, before the first send, the payload is all
      // there is to read. Once there is a reply, leaving it open would spend the
      // pane previewing the *next* message instead of showing this one.
      const openInspectors = new Set(s.openInspectors);
      if (existing && !existing.rootNodeId) openInspectors.delete(draftKey(id));
      return {
        openInspectors,
        asides: s.asides.map((f) =>
          f.id === id ? { ...f, rootNodeId, activeNodeId, pending: null } : f,
        ),
      };
    }),
}));

/* ------------------------------------------------------------------ */

/** A closed aside's box goes with it, as it did when the box lived in the composer. */
function keepDrafts(drafts: Record<string, ComposerDraft>, asides: AsideFrame[]): Record<string, ComposerDraft> {
  const live = new Set([draftKey(), ...asides.map((f) => draftKey(f.id))]);
  const kept: Record<string, ComposerDraft> = {};
  for (const [key, draft] of Object.entries(drafts)) if (live.has(key)) kept[key] = draft;
  return kept;
}

function clampTurns(turns: number): number {
  return Math.max(1, Math.min(5, turns));
}

/** Drops the draft-inspector keys of frames that are leaving the stack. */
function withoutDrafts(
  open: Set<NodeId>,
  before: AsideFrame[],
  after: AsideFrame[],
): Set<NodeId> {
  const next = new Set(open);
  const staying = new Set(after.map((f) => f.id));
  for (const frame of before) if (!staying.has(frame.id)) next.delete(draftKey(frame.id));
  return next;
}
