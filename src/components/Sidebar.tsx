import { useEffect } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { Outline } from "@/components/Outline";
import { LaterList } from "@/components/LaterList";

export function Sidebar() {
  const newConversation = useStore((s) => s.newConversation);
  const archivedCount = useStore((s) => s.conversations.filter((c) => c.archivedAt).length);

  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const list = useUI((s) => s.sidebarList);
  const setList = useUI((s) => s.setSidebarList);
  const showingArchived = list === "archived";

  // The last one unarchived: there is no archived list left to look at.
  useEffect(() => {
    if (showingArchived && archivedCount === 0) setList("conversations");
  }, [showingArchived, archivedCount, setList]);

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <h1 className="sidebar__brand">ToonDao</h1>
        <span className="sidebar__tagline">a chat you can read</span>
      </div>

      <div className="sidebar__list">
        {showingArchived ? (
          <div className="sidebar__listhead">
            <button type="button" className="sidebar__back" onClick={() => setList("conversations")}>
              ← Conversations
            </button>
            <span className="sidebar__listname">Archived</span>
          </div>
        ) : null}
        <Outline archived={showingArchived} />
      </div>

      <LaterList />

      <div className="sidebar__foot">
        <button
          type="button"
          className="btn btn--wide"
          onClick={() => {
            setList("conversations");
            void newConversation();
          }}
        >
          + New conversation
        </button>
        <div className="sidebar__footrow">
          <button
            type="button"
            className="btn btn--wide btn--ghost"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </button>
          {archivedCount > 0 ? (
            <button
              type="button"
              className={`btn btn--ghost sidebar__archived${showingArchived ? " sidebar__archived--on" : ""}`}
              title={`Archived conversations (${archivedCount})`}
              aria-label={`Archived conversations (${archivedCount})`}
              aria-pressed={showingArchived}
              onClick={() => setList(showingArchived ? "conversations" : "archived")}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                <rect x="1.5" y="2.5" width="13" height="3.5" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path d="M2.8 6v6.7c0 .5.4.8.8.8h8.8c.4 0 .8-.3.8-.8V6" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6.2 8.6h3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
