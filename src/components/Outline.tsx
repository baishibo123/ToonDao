import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDelete } from "@/components/ConfirmDelete";
import { RowMenu, menuPoint, type RowMenuItem, type RowMenuRequest } from "@/components/RowMenu";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { BRANCH_META } from "@/lib/policyMeta";
import {
  ancestorThreadIds,
  buildOutline,
  flattenOutline,
  visibleThreads,
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
 * toggle, arrow keys walk, a click goes there.
 *
 * Only the open conversation has its nodes in memory, so only it can show its
 * branches. Another conversation's triangle selects it first — which loads its
 * nodes — and then expands, so the gesture still does what it looks like it
 * does, just with a database read in the middle.
 *
 * `archived` lists the archived conversations instead of the others; either
 * list leaves out every archived branch (P-58), which a conversation's
 * right-click menu brings back.
 */
export function Outline({ archived = false }: { archived?: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  const allConversations = useStore((s) => s.conversations);
  const conversations = useMemo(
    () => allConversations.filter((c) => Boolean(c.archivedAt) === archived),
    [allConversations, archived],
  );
  const conversationId = useStore((s) => s.conversationId);
  const nodes = useStore((s) => s.nodes);
  const activeNodeId = useStore((s) => s.activeNodeId);
  const selectConversation = useStore((s) => s.selectConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const archiveConversation = useStore((s) => s.archiveConversation);
  const unarchiveConversation = useStore((s) => s.unarchiveConversation);
  const archiveBranch = useStore((s) => s.archiveBranch);
  const restoreBranches = useStore((s) => s.restoreBranches);
  const [menu, setMenu] = useState<RowMenuRequest | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  /** The conversation whose ✕ was clicked, waiting for the person to confirm. */
  const [doomed, setDoomed] = useState<{ id: string; title: string } | null>(null);
  const cancelDelete = useCallback(() => setDoomed(null), []);

  const collapsedRows = useUI((s) => s.collapsedRows);
  const toggleRow = useUI((s) => s.toggleRow);
  const setRowCollapsed = useUI((s) => s.setRowCollapsed);
  const asides = useUI((s) => s.asides);

  const outline = useMemo(() => buildOutline(nodes, conversationId), [nodes, conversationId]);
  const archivedBranches = allConversations.find((c) => c.id === conversationId)?.archivedBranches;
  /** The rows shown: the outline without its archived branches. */
  const shown = useMemo(
    () => visibleThreads(outline.threads, new Set(archivedBranches ?? [])),
    [outline.threads, archivedBranches],
  );
  /** Branch roots open in the aside pane, so a row can say so. */
  const asideRoots = useMemo(
    () => new Set(asides.map((f) => f.rootNodeId).filter((id): id is string => Boolean(id))),
    [asides],
  );

  /** Which row holds the cursor, so the selection follows navigation anywhere. */
  const selectedThreadId = activeNodeId
    ? (outline.threadOfNode.get(activeNodeId) ?? null)
    : null;

  // A branch you navigate to from the transcript must not be hidden
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
      for (const thread of flattenOutline(shown, (t) => isOpen(t.id))) {
        rows.push({ key: `t:${thread.id}`, conversationId: conversation.id, thread });
      }
    }
    return rows;
  }, [conversations, conversationId, shown, isOpen]);

  /**
   * One click, one place to go — and `focusNode()` decides where that is. A row
   * for the root spine moves the chat box's cursor; a row for anything else
   * opens it in the aside pane, because the thread cannot show it.
   *
   * The row's *own* leaf, never the deepest node beneath it: its children are
   * the rows below it and they have their own leaves. Clicking a row must select
   * that row, which is what clicking a row means everywhere else.
   */
  const goToThread = (thread: OutlineThread) => focusNode(thread.leafNodeId);

  /** A conversation's menu: on its own row, and on its main thread's. */
  const conversationMenu = (id: string, title: string): RowMenuItem[] => {
    const record = allConversations.find((c) => c.id === id);
    const count = record?.archivedBranches?.length ?? 0;
    return [
      ...(count > 0
        ? [{ label: `Restore ${count} archived branch${count === 1 ? "" : "es"}`, onSelect: () => void restoreBranches(id) }]
        : []),
      record?.archivedAt
        ? { label: "Unarchive conversation", onSelect: () => void unarchiveConversation(id) }
        : { label: "Archive conversation", onSelect: () => void archiveConversation(id) },
      { label: "Delete…", danger: true, onSelect: () => setDoomed({ id, title }) },
    ];
  };

  const openMenu = (event: React.MouseEvent<HTMLElement>, items: RowMenuItem[]) => {
    event.preventDefault();
    const returnTo = event.currentTarget.querySelector<HTMLElement>(".row__label");
    setMenu({ ...menuPoint(event), items, returnTo });
  };

  const onThreadMenu = (event: React.MouseEvent<HTMLElement>, thread: OutlineThread) => {
    if (!conversationId) return;
    const title = allConversations.find((c) => c.id === conversationId)?.title ?? "";
    openMenu(
      event,
      thread.depth === 0
        ? conversationMenu(conversationId, title)
        : [{ label: "Archive branch", onSelect: () => void archiveBranch(conversationId, thread.id) }],
    );
  };

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
              onContextMenu={(e) => openMenu(e, conversationMenu(conversation.id, conversation.title))}
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
                onClick={() => setDoomed({ id: conversation.id, title: conversation.title })}
              >
                ✕
              </button>
            </div>

            {expanded
              ? shown.map((thread) => (
                  <ThreadRows
                    key={thread.id}
                    thread={thread}
                    level={2}
                    isOpen={isOpen}
                    toggleRow={toggleRow}
                    selectedThreadId={selectedThreadId}
                    asideRoots={asideRoots}
                    onSelect={goToThread}
                    onMenu={onThreadMenu}
                  />
                ))
              : null}
          </div>
        );
      })}
      {doomed ? (
        <ConfirmDelete
          title={doomed.title}
          onCancel={cancelDelete}
          onConfirm={() => {
            setDoomed(null);
            void deleteConversation(doomed.id);
          }}
        />
      ) : null}
      {menu ? <RowMenu request={menu} onClose={closeMenu} /> : null}
    </div>
  );
}

interface ThreadRowsProps {
  thread: OutlineThread;
  level: number;
  isOpen: (id: string) => boolean;
  toggleRow: (id: string) => void;
  selectedThreadId: string | null;
  asideRoots: Set<string>;
  onSelect: (thread: OutlineThread) => void;
  onMenu: (event: React.MouseEvent<HTMLElement>, thread: OutlineThread) => void;
}

function ThreadRows({
  thread,
  level,
  isOpen,
  toggleRow,
  selectedThreadId,
  asideRoots,
  onSelect,
  onMenu,
}: ThreadRowsProps) {
  const meta = BRANCH_META[thread.kind];
  const hasKids = thread.children.length > 0;
  const expanded = hasKids && isOpen(thread.id);
  const selected = selectedThreadId === thread.id;
  const inAside = asideRoots.has(thread.headNodeId);

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
        onContextMenu={(e) => onMenu(e, thread)}
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
            thread.depth > 0 ? "\nOpens beside the thread" : ""
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

        {inAside ? (
          <span className="row__open" title="Open beside the thread" aria-label="Open beside the thread">
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
              asideRoots={asideRoots}
              onSelect={onSelect}
              onMenu={onMenu}
            />
          ))
        : null}
    </>
  );
}
