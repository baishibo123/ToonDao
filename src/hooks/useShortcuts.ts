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
  { keys: "Esc", label: "Drop the pending gesture, or close what is open" },
  { keys: "⌘ ⇧ W", label: "Close the front branch window" },
  { keys: "⌘ ⇧ T", label: "Show or hide the tree" },
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
        // without also closing the window it was typed into.
        if (ui.selection) return void ui.setSelection(null);
        if (ui.pending) return void ui.setPending(null);
        if (ui.settingsOpen) return void ui.setSettingsOpen(false);
        if (ui.shortcutsOpen) return void ui.setShortcutsOpen(false);
        const focused = focusedWindowId();
        if (focused) return void ui.closeBranchWindow(focused);
        if (store.streamingNodeId) return void store.stop();
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

      if (e.altKey && e.key === "Backspace" && store.streamingNodeId) {
        e.preventDefault();
        store.stop();
        return;
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
        case "w": {
          // The front window, or the one the caret is in.
          const focused = focusedWindowId();
          const front = ui.windows.reduce<typeof ui.windows[number] | null>(
            (top, w) => (!top || w.z > top.z ? w : top),
            null,
          );
          const target = focused ?? front?.id;
          if (!target) break;
          e.preventDefault();
          ui.closeBranchWindow(target);
          break;
        }
        case "t":
          e.preventDefault();
          ui.setTreeOpen(!ui.treeOpen);
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

/** The branch window the caret is in, if any. */
function focusedWindowId(): string | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  return el.closest("[data-window-id]")?.getAttribute("data-window-id") ?? null;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}
