import { useCallback, useEffect, useMemo, useRef } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { BRANCH_META } from "@/lib/policyMeta";
import {
  ancestorThreadIds,
  buildOutline,
  flattenOutline,
  type OutlineThread,
} from "@/lib/outline";
import { focusNode } from "@/store/focusNode";

/**
 * The conversation as a file structure (requirement 1).
 *
 * Every branch is a row of its own, nested under the thread it left, with a
 * disclosure triangle, an indentation guide and one selected row — the Finder
 * idiom, because that is the one hierarchical list every user of this app
 * already knows how to drive. What it borrows is the *interaction*: triangles
 * toggle, arrow keys walk, ⌘-less single click selects, double click opens.
 *
 * Only the open conversation has its nodes in memory, so only it can show its
 * branches. Another conversation's triangle selects it first — which loads its
 * nodes — and then expands, so the gesture still does what it looks like it
 * does, just with a database read in the middle.
 */
export function Outline() {
  const listRef = useRef<HTMLDivElement>(null);
  const conversations = useStore((s) => s.conversations);
  const conversationId = useStore((s) => s.conversationId);
  const nodes = useStore((s) => s.nodes);
  const activeNodeId = useStore((s) => s.activeNodeId);
  const selectConversation = useStore((s) => s.selectConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);

  const collapsedRows = useUI((s) => s.collapsedRows);
  const toggleRow = useUI((s) => s.toggleRow);
  const setRowCollapsed = useUI((s) => s.setRowCollapsed);
  const windows = useUI((s) => s.windows);

  const outline = useMemo(() => buildOutline(nodes, conversationId), [nodes, conversationId]);
  /** Branch roots that already have a window, so a row can say so. */
  const windowRoots = useMemo(
    () => new Set(windows.map((w) => w.rootNodeId).filter((id): id is string => Boolean(id))),
    [windows],
  );

  /** Which row holds the cursor, so the selection follows navigation anywhere. */
  const selectedThreadId = activeNodeId
    ? (outline.threadOfNode.get(activeNodeId) ?? null)
    : null;

  // A branch you navigate to from the transcript or the tree must not be hidden
  // behind a collapsed parent — the outline's job is to say where you are.
  useEffect(() => {
    if (!selectedThreadId) return;
    for (const id of ancestorThreadIds(outline.threads, selectedThreadId)) {
      if (collapsedRows.has(id)) setRowCollapsed(id, false);
    }
    // collapsedRows is read, not depended on: re-running when the user collapses
    // a row would immediately re-open it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThreadId, outline.threads, setRowCollapsed]);

  const isOpen = useCallback(
    (id: string) => !collapsedRows.has(id),
    [collapsedRows],
  );

  /** Rows in display order, for arrow-key walking. */
  const visibleRows = useMemo(() => {
    const rows: { key: string; conversationId: string; thread?: OutlineThread }[] = [];
    for (const conversation of conversations) {
      rows.push({ key: `c:${conversation.id}`, conversationId: conversation.id });
      if (conversation.id !== conversationId || !isOpen(conversation.id)) continue;
      for (const thread of flattenOutline(outline.threads, (t) => isOpen(t.id))) {
        rows.push({ key: `t:${thread.id}`, conversationId: conversation.id, thread });
      }
    }
    return rows;
  }, [conversations, conversationId, outline.threads, isOpen]);

  /**
   * One click, one place to go — and `focusNode()` decides where that is. A row
   * for the root spine moves the chat box's cursor; a row for anything else
   * opens or fronts that thread's window, because the chat box cannot show it.
   *
   * The row's *own* leaf, never the deepest node beneath it: its children are
   * the rows below it and they have their own leaves. Clicking a row must select
   * that row, which is what clicking a row means everywhere else.
   */
  const goToThread = (thread: OutlineThread) => focusNode(thread.leafNodeId);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "ArrowRight" && key !== "ArrowLeft") {
      return;
    }
    const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-row-key]");
    const index = visibleRows.findIndex((r) => r.key === focused?.dataset.rowKey);
    if (index === -1) return;
    event.preventDefault();

    if (key === "ArrowDown" || key === "ArrowUp") {
      const next = visibleRows[index + (key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      listRef.current
        ?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(next.key)}"] .row__label`)
        ?.focus();
      return;
    }

    const row = visibleRows[index];
    const id = row.thread ? row.thread.id : row.conversationId;
    const hasKids = row.thread ? row.thread.children.length > 0 : true;
    if (!hasKids) return;
    setRowCollapsed(id, key === "ArrowLeft");
  };

  return (
    <div
      className="outline"
      role="tree"
      aria-label="Conversations and branches"
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {conversations.map((conversation) => {
        const current = conversation.id === conversationId;
        const expanded = current && isOpen(conversation.id);
        return (
          // presentation, so the rows inside count as direct children of the
          // tree: depth is carried by aria-level, which is how a flat tree is
          // meant to work.
          <div key={conversation.id} className="outline__group" role="presentation">
            <div
              className="row row--conv"
              data-row-key={`c:${conversation.id}`}
              role="treeitem"
              aria-level={1}
              aria-selected={current}
              aria-expanded={expanded}
            >
              <button
                type="button"
                className={`row__twist${expanded ? " row__twist--open" : ""}`}
                aria-hidden
                tabIndex={-1}
                onClick={() => {
                  if (!current) {
                    void selectConversation(conversation.id).then(() =>
                      setRowCollapsed(conversation.id, false),
                    );
                    return;
                  }
                  toggleRow(conversation.id);
                }}
              >
                ▶
              </button>
              <button
                type="button"
                className="row__label"
                aria-current={current}
                onClick={() => void selectConversation(conversation.id)}
              >
                <span className="row__text">{conversation.title}</span>
                {current && outline.totalTurns > 0 ? (
                  <span className="row__count">{outline.totalTurns}</span>
                ) : null}
              </button>
              <button
                type="button"
                className="row__kill"
                aria-label={`Delete ${conversation.title}`}
                title="Delete this conversation"
                onClick={() => void deleteConversation(conversation.id)}
              >
                ✕
              </button>
            </div>

            {expanded
              ? outline.threads.map((thread) => (
                  <ThreadRows
                    key={thread.id}
                    thread={thread}
                    level={2}
                    isOpen={isOpen}
                    toggleRow={toggleRow}
                    selectedThreadId={selectedThreadId}
                    windowRoots={windowRoots}
                    onSelect={goToThread}
                  />
                ))
              : null}
          </div>
        );
      })}
    </div>
  );
}

interface ThreadRowsProps {
  thread: OutlineThread;
  level: number;
  isOpen: (id: string) => boolean;
  toggleRow: (id: string) => void;
  selectedThreadId: string | null;
  windowRoots: Set<string>;
  onSelect: (thread: OutlineThread) => void;
}

function ThreadRows({
  thread,
  level,
  isOpen,
  toggleRow,
  selectedThreadId,
  windowRoots,
  onSelect,
}: ThreadRowsProps) {
  const meta = BRANCH_META[thread.kind];
  const hasKids = thread.children.length > 0;
  const expanded = hasKids && isOpen(thread.id);
  const selected = selectedThreadId === thread.id;
  const inWindow = windowRoots.has(thread.headNodeId);

  return (
    <>
      <div
        className={`row row--thread${selected ? " row--selected" : ""}`}
        data-row-key={`t:${thread.id}`}
        role="treeitem"
        aria-level={level}
        aria-selected={selected}
        {...(hasKids ? { "aria-expanded": expanded } : {})}
        style={{
          ["--indent" as string]: `${(level - 2) * 13}px`,
          ["--kind" as string]: `var(${meta.cssVar})`,
        }}
      >
        {hasKids ? (
          <button
            type="button"
            className={`row__twist${expanded ? " row__twist--open" : ""}`}
            aria-hidden
            tabIndex={-1}
            onClick={() => toggleRow(thread.id)}
          >
            ▶
          </button>
        ) : (
          <span className="row__twist row__twist--leaf" aria-hidden />
        )}

        <button
          type="button"
          className="row__label"
          title={`${meta.label} · ${meta.blurb}${
            thread.depth > 0 ? "\nOpens in its own window" : ""
          }`}
          onClick={() => onSelect(thread)}
        >
          <span className="row__icon" aria-hidden>
            {meta.glyph}
          </span>
          <span className="row__text">{thread.label}</span>
          <span className="row__count">
            {thread.turnCount}
            {thread.totalTurns > thread.turnCount ? `+${thread.totalTurns - thread.turnCount}` : ""}
          </span>
        </button>

        {inWindow ? (
          <span className="row__open" title="Open in a window" aria-label="Open in a window">
            ⧉
          </span>
        ) : null}
      </div>

      {expanded
        ? thread.children.map((child) => (
            <ThreadRows
              key={child.id}
              thread={child}
              level={level + 1}
              isOpen={isOpen}
              toggleRow={toggleRow}
              selectedThreadId={selectedThreadId}
              windowRoots={windowRoots}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}
