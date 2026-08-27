import { useMemo } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";

export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const conversationId = useStore((s) => s.conversationId);
  const nodes = useStore((s) => s.nodes);
  const newConversation = useStore((s) => s.newConversation);
  const selectConversation = useStore((s) => s.selectConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);

  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const treeOpen = useUI((s) => s.treeOpen);
  const setTreeOpen = useUI((s) => s.setTreeOpen);

  const currentCount = useMemo(
    () => Object.values(nodes).filter((n) => n.conversationId === conversationId).length,
    [nodes, conversationId],
  );

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <h1 className="sidebar__brand">ToonDao</h1>
        <span className="sidebar__tagline">lineage ≠ context</span>
      </div>

      <div className="sidebar__list">
        {conversations.map((conversation) => (
          <div key={conversation.id} className="conv-row">
            <button
              type="button"
              className="conv"
              aria-current={conversation.id === conversationId}
              onClick={() => void selectConversation(conversation.id)}
            >
              <span className="conv__title">{conversation.title}</span>
              {conversation.id === conversationId && currentCount > 0 ? (
                <span className="conv__count">{currentCount}</span>
              ) : null}
              <span
                className="conv__kill"
                role="button"
                tabIndex={0}
                aria-label={`Delete ${conversation.title}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    void deleteConversation(conversation.id);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteConversation(conversation.id);
                }}
              >
                ✕
              </span>
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button
          type="button"
          className="btn btn--wide"
          onClick={() => void newConversation()}
        >
          + New conversation
        </button>
        <button
          type="button"
          className="btn btn--wide btn--ghost"
          onClick={() => setTreeOpen(!treeOpen)}
        >
          {treeOpen ? "Hide" : "Show"} tree
        </button>
        <button
          type="button"
          className="btn btn--wide btn--ghost"
          onClick={() => setSettingsOpen(true)}
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
