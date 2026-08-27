import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { MessageView } from "@/components/MessageView";
import { pathToRoot, turnNumbers } from "@/lib/tree";

export function Transcript() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const activeNodeId = useStore((s) => s.activeNodeId);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const scrollTarget = useUI((s) => s.scrollTarget);

  /**
   * The transcript is the *lineage* path (Graph A), root to the active leaf.
   * It never consults contextPolicy — what is on screen and what was sent are
   * different questions, and the chips are what answer the second one.
   */
  const path = useMemo(() => pathToRoot(nodes, activeNodeId), [nodes, activeNodeId]);
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

  useEffect(() => {
    if (!scrollTarget) return;
    const el = document.getElementById(`msg-${scrollTarget.id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("msg--flash");
    const timer = window.setTimeout(() => el.classList.remove("msg--flash"), 1200);
    return () => window.clearTimeout(timer);
  }, [scrollTarget]);

  if (path.length === 0) {
    return (
      <div className="transcript" ref={scrollerRef}>
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="transcript" ref={scrollerRef}>
      <div className="transcript__inner">
        {path.map((node, i) => (
          <MessageView
            key={node.id}
            node={node}
            turn={turns.get(node.id) ?? 0}
            isLast={i === path.length - 1}
          />
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
    </div>
  );
}
