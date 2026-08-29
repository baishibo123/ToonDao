import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { Sidebar } from "@/components/Sidebar";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import { SelectionPopover } from "@/components/SelectionPopover";
import { TreeStage } from "@/components/tree/TreeStage";
import { useSelectionWatcher } from "@/hooks/useSelectionWatcher";
import { useTermHover } from "@/hooks/useTermHover";
import { useShortcuts } from "@/hooks/useShortcuts";
import { Shortcuts } from "@/components/Shortcuts";

export default function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const init = useStore((s) => s.init);
  const nodes = useStore((s) => s.nodes);
  const conversationId = useStore((s) => s.conversationId);
  const conversations = useStore((s) => s.conversations);
  const renameConversation = useStore((s) => s.renameConversation);
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen);
  const treeOpen = useUI((s) => s.treeOpen);
  const treeGutter = useUI((s) => s.treeGutter);
  const storedGutter = useStore((s) => s.settings.treePanel.width);

  useSelectionWatcher();
  useTermHover();
  useShortcuts();

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) return <div className="boot">opening…</div>;

  // How much canvas the tree is holding. The stage owns the number once it has
  // measured itself; until then the persisted width is the best guess.
  const gutter = treeOpen ? (treeGutter ?? storedGutter) : 0;

  const conversation = conversations.find((c) => c.id === conversationId);
  const nodeCount = Object.values(nodes).filter(
    (n) => n.conversationId === conversationId,
  ).length;

  return (
    <div className="app">
      <Sidebar />
      {/* One canvas. The tree is the ground; the thread is a card lying on it. */}
      <main className="main" style={{ ["--tree-gutter" as string]: `${gutter}px` }}>
        <TreeStage />
        <div className="thread">
          {bootError ? (
            <p className="msg__error" role="alert" style={{ margin: "0 0 10px" }}>
              {bootError}
            </p>
          ) : null}
          <div className="thread__card">
            <header className="topbar">
              <input
                className="topbar__title"
                value={conversation?.title ?? ""}
                aria-label="Conversation title"
                onChange={(e) =>
                  conversationId && void renameConversation(conversationId, e.target.value)
                }
              />
              <span className="topbar__meta">
                {nodeCount} node{nodeCount === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setShortcutsOpen(true)}
                title="Keyboard shortcuts (?)"
                aria-label="Keyboard shortcuts"
              >
                ?
              </button>
            </header>
            <Transcript />
          </div>
          <Composer />
        </div>
      </main>
      <SelectionPopover />
      <Settings />
      <Shortcuts />
    </div>
  );
}
