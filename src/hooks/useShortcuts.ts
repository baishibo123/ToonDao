import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { siblingsOf } from "@/lib/tree";
import { focusNode } from "@/store/focusNode";

export interface Shortcut {
  keys: string;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: "Enter", label: "Send" },
  { keys: "Shift ⏎", label: "Newline" },
  { keys: "Esc", label: "Drop the pending gesture, or back out of what is open" },
  { keys: "⌘ ⇧ W", label: "Close every side conversation" },
  { keys: "⌘ ⇧ N", label: "New conversation" },
  { keys: "⌘ ⇧ I", label: "Inspect the payload of the last message" },
  { keys: "⌘ ⇧ ,", label: "Settings" },
  { keys: "⌥ ↑ / ↓", label: "Previous / next sibling branch" },
  { keys: "⌥ ⌫", label: "Stop generating" },
  { keys: "?", label: "This list" },
];

/**
 * Global shortcuts (§8 P3).
 *
 * Modified with Shift as well as Cmd/Ctrl, because the unshifted combinations
 * are the browser's: ⌘T opens a tab, ⌘N a window, ⌘I varies by platform. A
 * shortcut that has to fight the browser is not a shortcut.
 *
 * Anything that would swallow a keystroke while the user is typing checks the
 * focus target first; only Escape and the explicitly-modified combinations act
 * from inside a text field.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState();
      const store = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const typing = isTyping(e.target);

      if (e.key === "Escape") {
        // One key, unwound in the order the user layered it. A composer holding
        // a gesture stops this chain itself, so Escape there drops the gesture
        // without also closing the aside it was typed into.
        if (ui.selection) return void ui.setSelection(null);
        if (ui.pending) return void ui.setPending(null);
        if (ui.settingsOpen) return void ui.setSettingsOpen(false);
        if (ui.shortcutsOpen) return void ui.setShortcutsOpen(false);
        // A closer look ends first: the aside goes back beside the line it left.
        if (ui.wideAsideId && ui.wideAsideId === ui.asides.at(-1)?.id) return void ui.toggleWide(ui.wideAsideId);
        // An aside backs out one level, the way ✕ and the breadcrumb do.
        if (ui.asides.length > 1) return void ui.popAsidesTo(ui.asides.at(-2)!.id);
        if (ui.asides.length === 1) return void ui.closeAsides();
        // Only the thread is left by now: stop its reply, if it is being written.
        if (store.activeNodeId && store.streams[store.activeNodeId]) return void store.stop(store.activeNodeId);
        return;
      }

      // Some layouts (and some synthetic events) report "/" with Shift held
      // rather than "?", so accept both.
      const isQuestionMark = e.key === "?" || (e.key === "/" && e.shiftKey);
      if (isQuestionMark && !typing && !mod) {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
        return;
      }

      if (e.altKey && e.key === "Backspace") {
        // The reply of the pane being typed in: an aside's, else the thread's.
        const asideId = (document.activeElement as Element | null)?.closest?.("[data-aside-id]")?.getAttribute("data-aside-id");
        const leaf = asideId ? ui.asides.find((f) => f.id === asideId)?.activeNodeId : store.activeNodeId;
        if (leaf && store.streams[leaf]) {
          e.preventDefault();
          store.stop(leaf);
          return;
        }
      }

      // Sibling branch switching, from anywhere including the composer.
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const activeId = store.activeNodeId;
        if (!activeId) return;
        const siblings = siblingsOf(store.nodes, activeId);
        if (siblings.length < 2) return;
        const index = siblings.findIndex((n) => n.id === activeId);
        const next = siblings[index + (e.key === "ArrowDown" ? 1 : -1)];
        if (!next) return;
        e.preventDefault();
        focusNode(next.id);
        return;
      }

      if (!mod || !e.shiftKey) return;

      switch (e.key.toLowerCase()) {
        case "w":
          if (ui.asides.length === 0) break;
          e.preventDefault();
          ui.closeAsides();
          break;
        case "n":
          e.preventDefault();
          void store.newConversation();
          break;
        case "i": {
          e.preventDefault();
          const last = store.activeNodeId;
          if (last) ui.toggleInspector(last);
          break;
        }
        case ",":
        case "<":
          e.preventDefault();
          ui.setSettingsOpen(!ui.settingsOpen);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}
