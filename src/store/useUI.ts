import { create } from "zustand";
import type { NodeId, TextAnchor } from "@/types";
import { newId } from "@/lib/id";

/**
 * Ephemeral UI state. Nothing here is persisted — it is all about what the user
 * is in the middle of doing, and none of it should survive a reload.
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
 * deeper aside in the same pane, and the frames above it become the breadcrumb
 * back: one side conversation at a time, with a way home.
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
  setConceptTurns: (turns: number) => void;

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
  focusComposer: () => void;

  /* -- asides ----------------------------------------------------- */

  /** Open side conversations, outermost first. The pane shows the last one; the
   *  others are its breadcrumb. Empty means the pane is closed. */
  asides: AsideFrame[];
  /** Opens an aside for a gesture that has not been sent yet. `from` is the
   *  aside it was started in; without it, the aside replaces the whole stack. */
  openAside: (args: {
    gesture: PendingGesture;
    conversationId: string;
    from?: string;
  }) => string;
  /** Shows existing branches, outermost first — the chain that leads to one. */
  showAsides: (chain: AsideTarget[]) => void;
  closeAsides: () => void;
  /** Back up the breadcrumb, keeping `id` as the open aside. */
  popAsidesTo: (id: string) => void;
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

export const useUI = create<UIState>((set, get) => ({
  pending: null,
  setPending: (pending) => set({ pending, selection: null }),
  setConceptTurns: (turns) => {
    const pending = get().pending;
    if (pending?.kind !== "concept") return;
    set({ pending: { ...pending, turns: clampTurns(turns) } });
  },

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
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),

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
        openInspectors: withoutDrafts(s.openInspectors, s.asides, asides),
      };
    }),

  closeAsides: () =>
    set((s) => ({
      asides: [],
      openInspectors: withoutDrafts(s.openInspectors, s.asides, []),
    })),

  popAsidesTo: (id) =>
    set((s) => {
      const at = s.asides.findIndex((f) => f.id === id);
      if (at === -1) return {};
      const asides = s.asides.slice(0, at + 1);
      return { asides, openInspectors: withoutDrafts(s.openInspectors, s.asides, asides) };
    }),

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
