/**
 * Writes what is on screen to the open conversation's `view`, and puts a
 * conversation's view back when it is opened (P-50).
 *
 * Writing follows the reader 300 ms behind, and at once when the page is
 * hidden or unloaded, so a reload forced by a stuck tab loses at most the last
 * keystrokes. It never touches `updatedAt`: looking at a conversation is not
 * changing it, and the sidebar is ordered by change.
 *
 * Scroll positions are reported by each transcript (`noteScroll()`) rather
 * than kept in the UI store, so scrolling re-renders nothing.
 */
import { useEffect } from "react";
import { db } from "@/db/db";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { restoreView, snapshotView, type ConversationView, type ScrollMark } from "@/lib/view";
import { rememberTabConversation } from "@/lib/tabMemory";

const SAVE_DELAY_MS = 300;

/** Each pane's scroll mark in the open conversation, by `draftKey()`. */
let scroll: Record<string, ScrollMark> = {};
/** Views written this session, newer than the records the store loaded at boot. */
const written = new Map<string, ConversationView>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** The conversation whose view has changed since it was last written. */
let dirty: string | null = null;

/** A pane reports where it is; `null` means at its end. */
export function noteScroll(key: string, mark: ScrollMark | null): void {
  if (mark) scroll[key] = mark;
  else delete scroll[key];
  schedule();
}

function schedule(): void {
  const id = useStore.getState().conversationId;
  if (!id) return;
  dirty = id;
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY_MS);
}

/** Writes the open conversation's view now, if anything changed. */
export function flush(): void {
  clearTimeout(timer);
  const id = dirty;
  dirty = null;
  if (!id) return;
  const view = snapshotView(useUI.getState(), scroll);
  written.set(id, view);
  // A conversation deleted meanwhile has no record left; update() then does nothing.
  void db.conversations.update(id, { view }).catch(() => undefined);
}

/**
 * The open conversation changed. The UI still shows the one being left, so it
 * is written first; then the new one's view is checked against its tree and
 * put on screen, and written back at once so it is the newest — the one a
 * reload reopens.
 */
function opened(next: string | null, previous: string | null): void {
  if (previous) flush();
  scroll = {};
  if (!next) return;
  rememberTabConversation(next);
  const { nodes, conversations } = useStore.getState();
  const view = written.get(next) ?? conversations.find((c) => c.id === next)?.view;
  const restored = restoreView(view, nodes, next);
  // A hidden pane reports nothing until it is shown, so its mark is carried
  // forward from the view rather than lost at the next write.
  scroll = { ...restored.scroll };
  useUI.getState().restore(restored);
  schedule();
}

export function useViewPersistence(): void {
  useEffect(() => {
    const offStore = useStore.subscribe((s, p) => {
      if (s.conversationId !== p.conversationId) opened(s.conversationId, p.conversationId);
    });
    const offUI = useUI.subscribe((s, p) => {
      if (
        s.asides !== p.asides ||
        s.wideAsideId !== p.wideAsideId ||
        s.pending !== p.pending ||
        s.drafts !== p.drafts ||
        s.collapsedRows !== p.collapsedRows
      ) {
        schedule();
      }
    });
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      offStore();
      offUI();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
      flush();
    };
  }, []);
}
