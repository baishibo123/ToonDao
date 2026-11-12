import { useEffect, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { Sidebar } from "@/components/Sidebar";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { Settings } from "@/components/Settings";
import { SelectionPopover } from "@/components/SelectionPopover";
import { AsidePane } from "@/components/AsidePane";
import { useSelectionWatcher } from "@/hooks/useSelectionWatcher";
import { useTermHover } from "@/hooks/useTermHover";
import { useParkedMarks } from "@/hooks/useParkedMarks";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useViewPersistence } from "@/store/viewPersistence";
import { Shortcuts } from "@/components/Shortcuts";
import { textScale } from "@/lib/textSize";
import { asideBasis, threadPlace } from "@/lib/panes";

export default function App() {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const init = useStore((s) => s.init);
  const conversationId = useStore((s) => s.conversationId);
  const conversations = useStore((s) => s.conversations);
  const renameConversation = useStore((s) => s.renameConversation);
  const nameConversation = useStore((s) => s.nameConversation);
  const hasReply = useStore((s) =>
    Object.values(s.nodes).some((n) => n.role === "assistant" && n.status === "complete"),
  );
  const [naming, setNaming] = useState(false);
  const setShortcutsOpen = useUI((s) => s.setShortcutsOpen);
  const textSize = useStore((s) => s.settings.textSize);
  const asideShare = useStore((s) => s.settings.asideShare);
  const asideCount = useUI((s) => s.asides.length);
  const wide = useUI((s) => s.wideAsideId !== null && s.wideAsideId === s.asides.at(-1)?.id);

  // Before init, so the first conversation it opens is restored too (P-50).
  useViewPersistence();
  useSelectionWatcher();
  useTermHover();
  useParkedMarks();
  useShortcuts();

  useEffect(() => {
    void init();
  }, [init]);

  // P-38: one variable every font size in the stylesheets is multiplied by.
  useEffect(() => {
    document.documentElement.style.setProperty("--text-scale", String(textScale(textSize)));
  }, [textSize]);

  if (!ready) return <div className="boot">opening…</div>;

  const conversation = conversations.find((c) => c.id === conversationId);

  return (
    <div className="app">
      <Sidebar />
      <main
        className={`main${asideCount > 0 ? " main--split" : ""}${wide ? " main--wide" : ""}`}
        style={asideShare === undefined ? undefined : { ["--aside-basis" as string]: asideBasis(asideShare) }}
      >
        {/* Hidden rather than unmounted while an aside holds the centre (P-49),
            so the thread's draft and scroll position wait for it. */}
        <div className="thread" hidden={threadPlace(asideCount) === "hidden"}>
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
              {/* This conversation only: names it again from what it is about now (P-34). */}
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={!conversationId || !hasReply || naming}
                onClick={async () => {
                  if (!conversationId) return;
                  setNaming(true);
                  try {
                    await nameConversation(conversationId);
                  } finally {
                    setNaming(false);
                  }
                }}
                title="Name this conversation again from what it is about"
                aria-label="Name this conversation again"
              >
                {naming ? "…" : "↻"}
              </button>
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
        {/* Side conversations sit beside the line they left, never over it. */}
        <AsidePane />
      </main>
      <SelectionPopover />
      <Settings />
      <Shortcuts />
    </div>
  );
}
