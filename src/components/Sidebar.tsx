import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { Outline } from "@/components/Outline";

export function Sidebar() {
  const newConversation = useStore((s) => s.newConversation);

  const setSettingsOpen = useUI((s) => s.setSettingsOpen);

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <h1 className="sidebar__brand">ToonDao</h1>
        <span className="sidebar__tagline">lineage ≠ context</span>
      </div>

      <div className="sidebar__list">
        <Outline />
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
          onClick={() => setSettingsOpen(true)}
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
