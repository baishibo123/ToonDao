import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { Sidebar } from "@/components/Sidebar";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import { SelectionPopover } from "@/components/SelectionPopover";
import { useSelectionWatcher } from "@/hooks/useSelectionWatcher";
import { useTermHover } from "@/hooks/useTermHover";

export default function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const init = useStore((s) => s.init);
  const nodes = useStore((s) => s.nodes);
  const conversationId = useStore((s) => s.conversationId);
  const conversations = useStore((s) => s.conversations);
  const renameConversation = useStore((s) => s.renameConversation);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const settingsOpen = useUI((s) => s.settingsOpen);

  useSelectionWatcher();
  useTermHover();

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, setSettingsOpen]);

  if (!ready) return <div className="boot">opening…</div>;

  const conversation = conversations.find((c) => c.id === conversationId);
  const nodeCount = Object.values(nodes).filter(
    (n) => n.conversationId === conversationId,
  ).length;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {bootError ? (
          <p className="msg__error" role="alert" style={{ margin: "12px 24px" }}>
            {bootError}
          </p>
        ) : null}
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
        </header>
        <Transcript />
        <Composer />
      </main>
      <SelectionPopover />
      <Settings />
    </div>
  );
}
