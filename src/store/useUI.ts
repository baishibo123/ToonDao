import { create } from "zustand";
import type { NodeId, TextAnchor } from "@/types";

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

export interface SelectionState {
  nodeId: NodeId;
  anchor: TextAnchor;
  /** Viewport rect of the selection, for positioning the toolbar. */
  rect: { top: number; bottom: number; left: number; right: number };
}

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

  treeOpen: boolean;
  setTreeOpen: (open: boolean) => void;

  /** Node the tree is hovering, mirrored into the transcript as a highlight. */
  hoverNodeId: NodeId | null;
  setHoverNodeId: (id: NodeId | null) => void;

  /** Bumped to ask the transcript to scroll a node into view. */
  scrollTarget: { id: NodeId; nonce: number } | null;
  requestScrollTo: (id: NodeId) => void;

  composerFocusNonce: number;
  focusComposer: () => void;

  /** Text to drop into the composer, consumed once. For "Compare with…". */
  composerSeed: { text: string; nonce: number } | null;
  setComposerSeed: (text: string) => void;
}

export const useUI = create<UIState>((set, get) => ({
  pending: null,
  setPending: (pending) => set({ pending, selection: null }),
  setConceptTurns: (turns) => {
    const pending = get().pending;
    if (pending?.kind !== "concept") return;
    set({ pending: { ...pending, turns: Math.max(1, Math.min(5, turns)) } });
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

  treeOpen: true,
  setTreeOpen: (treeOpen) => set({ treeOpen }),

  hoverNodeId: null,
  setHoverNodeId: (hoverNodeId) => set({ hoverNodeId }),

  scrollTarget: null,
  requestScrollTo: (id) =>
    set((s) => ({ scrollTarget: { id, nonce: (s.scrollTarget?.nonce ?? 0) + 1 } })),

  composerFocusNonce: 0,
  focusComposer: () => set((s) => ({ composerFocusNonce: s.composerFocusNonce + 1 })),

  composerSeed: null,
  setComposerSeed: (text) =>
    set((s) => ({ composerSeed: { text, nonce: (s.composerSeed?.nonce ?? 0) + 1 } })),
}));
