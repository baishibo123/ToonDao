import { useEffect, useMemo, useRef } from "react";
import type { NodeId } from "@/types";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { MessageView } from "@/components/MessageView";
import { pathToRoot, turnNumbers } from "@/lib/tree";

interface TranscriptProps {
  /** Leaf to render the path to. Defaults to the app's active node. */
  leafId?: NodeId | null;
  /**
   * Render the path from this node down instead of from the root. A branch
   * window shows its own branch, not the ancestry that led to it — the ancestry
   * is on screen already, in the thread the window is floating over.
   */
  fromNodeId?: NodeId | null;
  /** What to say when there is nothing to show. */
  empty?: React.ReactNode;
}

export function Transcript({ leafId, fromNodeId, empty }: TranscriptProps = {}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const appActiveNodeId = useStore((s) => s.activeNodeId);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const scrollTarget = useUI((s) => s.scrollTarget);

  const activeNodeId = leafId === undefined ? appActiveNodeId : leafId;

  /**
   * The transcript is the *lineage* path (Graph A), root to the active leaf.
   * It never consults contextPolicy — what is on screen and what was sent are
   * different questions, and the chips are what answer the second one.
   */
  const path = useMemo(() => {
    const full = pathToRoot(nodes, activeNodeId);
    if (!fromNodeId) return full;
    const start = full.findIndex((n) => n.id === fromNodeId);
    return start === -1 ? full : full.slice(start);
  }, [nodes, activeNodeId, fromNodeId]);
  const turns = useMemo(() => turnNumbers(path), [path]);

  // Follow the stream, but only while the user is already near the bottom.
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const lastContent = path.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastContent, path.length, streamingNodeId]);

  // Scoped to this scroller rather than looked up by DOM id: the same node can
  // be on screen in the main thread and in a window at once, and each surface
  // should scroll its own copy.
  useEffect(() => {
    if (!scrollTarget) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(scrollTarget.id)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("msg--flash");
    const timer = window.setTimeout(() => el.classList.remove("msg--flash"), 1200);
    return () => window.clearTimeout(timer);
  }, [scrollTarget]);

  if (path.length === 0) {
    return (
      <div className="transcript" ref={scrollerRef}>
        {empty ?? <EmptyState />}
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollerRef}>
      <div className="transcript__inner">
        {path.map((node) => (
          <MessageView key={node.id} node={node} turn={turns.get(node.id) ?? 0} />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <h2>Two graphs, one set of nodes.</h2>
      <p>
        A conversation's <em>shape</em> and a conversation's <em>context</em> are
        different graphs. Every other chat client collapses them: what gets sent
        is always the path from the root to wherever you are, invisibly.
      </p>
      <p>
        Here, what gets sent is a policy you can see and change per message. Type
        below and it behaves like an ordinary chat client. Then:
      </p>
      <ul>
        <li>
          Click any <code>N messages · ~tok</code> chip to read the exact payload.
        </li>
        <li>Select text in a reply to ask about only that, or to quote it.</li>
        <li>Click a term to ask about it with a narrow window of context.</li>
        <li>Use the left gutter of a reply to cut it where you stopped following.</li>
      </ul>
      <p>
        A window is <em>one linear conversation</em>. Replies and quoted replies
        carry it on, so they stay here. Anything that departs — a lens, a crop,
        an isolation, or an ordinary question asked off an earlier message —
        is a second line of thought, so it opens in its own window in front of
        this one, showing what it carries before you send. This transcript only
        ever marks where those left; it never splices them in.
      </p>
      <ul>
        <li>Every branch also gets a row in the list on the left, nested under what it left.</li>
      </ul>
    </div>
  );
}
