import { create } from "zustand";
import type { NodeId, TextAnchor } from "@/types";
import { newId } from "@/lib/id";
import { clamp, viewportSize } from "@/lib/viewport";

/**
 * Ephemeral UI state. Nothing here is persisted — it is all about what the user
 * is in the middle of doing, and none of it should survive a reload.
 */

/** A gesture that has been started but not yet sent. It determines the policy,
 *  origin and parent of the next submit. */
export type PendingGesture =
  | { kind: "quote"; sourceNodeId: NodeId; anchor: TextAnchor }
  /** An ordinary turn, but off an earlier message — a new line of thought. */
  | { kind: "fork"; sourceNodeId: NodeId }
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
  /** Set when the selection was made inside a branch window, so a quote reply
   *  docks into that window's composer rather than the main one. */
  windowId?: string;
}

/**
 * A branch, opened as its own window in front of the thread.
 *
 * WHY A WINDOW. A branch is not the next thing you said — it is a second thing
 * you are now doing, and the first one is not finished. Pushing it into the
 * single transcript makes the reader lose the place they were reading; putting
 * it in a window keeps both visible at once and makes the carried context
 * inspectable side by side with the passage it came from. The window is a
 * *view*, not a container: the nodes it shows live in the same tree as
 * everything else, which is why nothing here is persisted — closing a window
 * loses no conversation, and the outline can always open another one.
 */
export interface BranchWindowState {
  id: string;
  conversationId: string;
  /** The node the branch hangs off. */
  sourceNodeId: NodeId;
  /** The gesture that opened it. Cleared on the first send. */
  pending: PendingGesture | null;
  /** First node of the branch, once it exists. */
  rootNodeId: NodeId | null;
  /** Leaf inside the branch that this window's composer is attached to. */
  activeNodeId: NodeId | null;
  /** Text to seed the composer with, consumed once ("Compare with…"). */
  seed?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
}

const WINDOW_W = 468;
const WINDOW_H = 540;
const MIN_W = 320;
const MIN_H = 220;
/** Classic cascade, so two windows opened from one passage are both reachable. */
const CASCADE = 26;

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

  treeOpen: boolean;
  setTreeOpen: (open: boolean) => void;

  /** Outline rows the user has collapsed. Absent means open: a conversation is
   *  mostly worth seeing, and hiding it by default hides the feature. */
  collapsedRows: Set<string>;
  toggleRow: (id: string) => void;
  setRowCollapsed: (id: string, collapsed: boolean) => void;

  /** Node the tree is hovering, mirrored into the transcript as a highlight. */
  hoverNodeId: NodeId | null;
  setHoverNodeId: (id: NodeId | null) => void;

  /** Bumped to ask the transcript to scroll a node into view. */
  scrollTarget: { id: NodeId; nonce: number } | null;
  requestScrollTo: (id: NodeId) => void;

  composerFocusNonce: number;
  focusComposer: () => void;

  /* -- branch windows --------------------------------------------- */

  windows: BranchWindowState[];
  /** Opens a window for a gesture that has not been sent yet. */
  openBranchWindow: (args: {
    gesture: PendingGesture;
    conversationId: string;
    /** Rect of the passage the gesture came from, so the window lands near it. */
    near?: Rect;
    seed?: string;
  }) => string;
  /** Re-opens an existing branch as a window. Focuses one already showing it. */
  openNodeWindow: (args: {
    conversationId: string;
    sourceNodeId: NodeId;
    rootNodeId: NodeId;
    activeNodeId: NodeId;
  }) => string;
  closeBranchWindow: (id: string) => void;
  focusBranchWindow: (id: string) => void;
  moveBranchWindow: (id: string, x: number, y: number) => void;
  resizeBranchWindow: (id: string, width: number, height: number) => void;
  setBranchWindowMinimized: (id: string, minimized: boolean) => void;
  setBranchWindowPending: (id: string, pending: PendingGesture | null) => void;
  setBranchWindowTurns: (id: string, turns: number) => void;
  setBranchWindowActive: (id: string, nodeId: NodeId) => void;
  /** Binds a freshly sent branch to the window that sent it. */
  attachBranchWindow: (id: string, rootNodeId: NodeId, activeNodeId: NodeId) => void;
  /** Pulls windows back into view after the viewport shrinks. */
  clampWindowsToViewport: () => void;
}

/**
 * The inspector key for a composer's own draft. Every surface gets its own, so
 * expanding the carried context in one window does not expand it in all of them.
 */
export function draftKey(windowId?: string): string {
  return windowId ? `__draft__:${windowId}` : "__draft__";
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

  treeOpen: true,
  setTreeOpen: (treeOpen) => set({ treeOpen }),

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

  hoverNodeId: null,
  setHoverNodeId: (hoverNodeId) => set({ hoverNodeId }),

  scrollTarget: null,
  requestScrollTo: (id) =>
    set((s) => ({ scrollTarget: { id, nonce: (s.scrollTarget?.nonce ?? 0) + 1 } })),

  composerFocusNonce: 0,
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),

  windows: [],

  openBranchWindow: ({ gesture, conversationId, near, seed }) => {
    const id = newId("w");
    set((s) => {
      const geometry = place(near, s.windows.length);
      // The window's whole reason for existing is to show what it carries, so
      // the payload starts expanded. Opened in the same transaction as the
      // window: two set() calls would flash a collapsed inspector first.
      const openInspectors = new Set(s.openInspectors);
      openInspectors.add(draftKey(id));
      return {
        openInspectors,
        selection: null,
        windows: [
          ...s.windows,
          {
            id,
            conversationId,
            sourceNodeId: gesture.sourceNodeId,
            pending: gesture,
            rootNodeId: null,
            activeNodeId: null,
            ...(seed ? { seed } : {}),
            ...geometry,
            z: nextZ(s.windows),
            minimized: false,
          },
        ],
      };
    });
    return id;
  },

  openNodeWindow: ({ conversationId, sourceNodeId, rootNodeId, activeNodeId }) => {
    // One window per branch. A second window on the same spine would be two
    // views of one linear conversation, which is the thing windows exist to
    // avoid, so asking again fronts the one that is already open — and moves it
    // to the node that was asked for, since that is why it was asked for.
    const existing = get().windows.find((w) => w.rootNodeId === rootNodeId);
    if (existing) {
      get().focusBranchWindow(existing.id);
      get().setBranchWindowMinimized(existing.id, false);
      get().setBranchWindowActive(existing.id, activeNodeId);
      return existing.id;
    }
    const id = newId("w");
    set((s) => ({
      windows: [
        ...s.windows,
        {
          id,
          conversationId,
          sourceNodeId,
          pending: null,
          rootNodeId,
          activeNodeId,
          ...place(undefined, s.windows.length),
          z: nextZ(s.windows),
          minimized: false,
        },
      ],
    }));
    return id;
  },

  closeBranchWindow: (id) =>
    set((s) => {
      const openInspectors = new Set(s.openInspectors);
      openInspectors.delete(draftKey(id));
      return {
        openInspectors,
        windows: s.windows.filter((w) => w.id !== id),
      };
    }),

  focusBranchWindow: (id) =>
    set((s) => {
      const top = nextZ(s.windows) - 1;
      // Already on top: skip the write so a click inside a window does not
      // re-render every other one.
      if (s.windows.find((w) => w.id === id)?.z === top) return {};
      const z = nextZ(s.windows);
      return { windows: s.windows.map((w) => (w.id === id ? { ...w, z } : w)) };
    }),

  moveBranchWindow: (id, x, y) => patch(set, id, { x, y }),

  resizeBranchWindow: (id, width, height) =>
    patch(set, id, {
      width: Math.max(MIN_W, width),
      height: Math.max(MIN_H, height),
    }),

  setBranchWindowMinimized: (id, minimized) => patch(set, id, { minimized }),

  setBranchWindowPending: (id, pending) =>
    set((s) => ({
      selection: null,
      windows: s.windows.map((w) => (w.id === id ? { ...w, pending } : w)),
    })),

  setBranchWindowTurns: (id, turns) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.id === id && w.pending?.kind === "concept"
          ? { ...w, pending: { ...w.pending, turns: clampTurns(turns) } }
          : w,
      ),
    })),

  setBranchWindowActive: (id, nodeId) => patch(set, id, { activeNodeId: nodeId }),

  attachBranchWindow: (id, rootNodeId, activeNodeId) =>
    set((s) => {
      const existing = s.windows.find((w) => w.id === id);
      // The carried payload is expanded on open because, before the first send,
      // it is the only thing in the window worth reading. Once there is a reply
      // to read it stops being that, and leaving it open would spend most of a
      // small window previewing the *next* message instead of showing this one.
      const openInspectors = new Set(s.openInspectors);
      if (existing && !existing.rootNodeId) openInspectors.delete(draftKey(id));
      return {
        openInspectors,
        windows: s.windows.map((w) =>
          w.id === id
            ? { ...w, rootNodeId, activeNodeId, pending: null, seed: undefined }
            : w,
        ),
      };
    }),

  /**
   * Shrinking the browser can leave a window past the new edge, and a window
   * whose title bar is off-screen cannot be dragged back. Re-clamping on resize
   * is the only way for it to stay reachable.
   */
  clampWindowsToViewport: () =>
    set((s) => {
      const { width: vw, height: vh } = viewportSize();
      let changed = false;
      const windows = s.windows.map((w) => {
        const width = Math.max(MIN_W, Math.min(w.width, vw - 24));
        const height = Math.max(MIN_H, Math.min(w.height, vh - 24));
        const x = clamp(w.x, 12 - width + 96, Math.max(12, vw - 96));
        const y = clamp(w.y, 0, Math.max(0, vh - 40));
        if (x === w.x && y === w.y && width === w.width && height === w.height) return w;
        changed = true;
        return { ...w, x, y, width, height };
      });
      return changed ? { windows } : {};
    }),
}));

/* ------------------------------------------------------------------ */

type Setter = (fn: (s: UIState) => Partial<UIState>) => void;

function patch(set: Setter, id: string, fields: Partial<BranchWindowState>): void {
  set((s) => ({
    windows: s.windows.map((w) => (w.id === id ? { ...w, ...fields } : w)),
  }));
}

function nextZ(windows: BranchWindowState[]): number {
  return windows.reduce((max, w) => Math.max(max, w.z), 0) + 1;
}

function clampTurns(turns: number): number {
  return Math.max(1, Math.min(5, turns));
}

/**
 * Where a new window lands.
 *
 * Beside the passage it came from when we know where that was, because the
 * spatial link is the cheapest possible explanation of where the branch came
 * from — no arrow, no label. Clamped to the viewport, and cascaded when there
 * is no rect to work from, so a second window is never hidden under the first.
 */
function place(
  near: Rect | undefined,
  index: number,
): Pick<BranchWindowState, "x" | "y" | "width" | "height"> {
  const { width: vw, height: vh } = viewportSize();
  const width = Math.min(WINDOW_W, Math.max(MIN_W, vw - 80));
  const height = Math.min(WINDOW_H, Math.max(MIN_H, vh - 120));
  const offset = (index % 6) * CASCADE;
  const gutter = sidebarWidth() + 12;

  const x = near
    ? near.left + 18 + offset
    : Math.round((vw - width) / 2) + offset;
  const y = near ? near.bottom + 12 + offset : Math.round((vh - height) / 2.6) + offset;

  return {
    width,
    height,
    // The left bound is the sidebar, not the screen edge: a window that opens
    // over the outline hides the list of branches it just joined.
    x: clamp(x, gutter, Math.max(gutter, vw - width - 12)),
    y: clamp(y, 12, Math.max(12, vh - height - 12)),
  };
}

/** Read from CSS so the number lives in exactly one place. */
function sidebarWidth(): number {
  if (typeof window === "undefined") return 248;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w");
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 248;
}

