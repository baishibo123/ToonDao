import { useEffect, useMemo, useRef } from "react";
import type { NodeId } from "@/types";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { MessageView } from "@/components/MessageView";
import { pathToRoot } from "@/lib/tree";

interface TranscriptProps {
  /** Leaf to render the path to. Defaults to the app's active node. */
  leafId?: NodeId | null;
  /**
   * Render the path from this node down instead of from the root. An aside
   * shows its own branch, not the ancestry that led to it — the ancestry is on
   * screen already, in the thread beside it.
   */
  fromNodeId?: NodeId | null;
  /** What to say when there is nothing to show. */
  empty?: React.ReactNode;
}

export function Transcript({ leafId, fromNodeId, empty }: TranscriptProps = {}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const appActiveNodeId = useStore((s) => s.activeNodeId);
  const leafStreaming = useStore((s) => {
    const leaf = leafId === undefined ? s.activeNodeId : leafId;
    return leaf ? leaf in s.streams : false;
  });
  const scrollTarget = useUI((s) => s.scrollTarget);

  const activeNodeId = leafId === undefined ? appActiveNodeId : leafId;

  /**
   * The transcript is the *lineage* path (Graph A), root to the active leaf.
   * It never consults contextPolicy — what is on screen and what was sent are
   * different questions, and each message's "context" action answers the second.
   */
  const path = useMemo(() => {
    const full = pathToRoot(nodes, activeNodeId);
    if (!fromNodeId) return full;
    const start = full.findIndex((n) => n.id === fromNodeId);
    return start === -1 ? full : full.slice(start);
  }, [nodes, activeNodeId, fromNodeId]);

  // Follow the stream, but only while the reader is at the bottom. Scrolling up
  // is the reader leaving on purpose: the follow stops until they scroll back
  // down to the end, or send something, which starts a new stream to watch.
  // The follow jumps rather than glides: `.transcript` scrolls smoothly, and a
  // glide restarted on every delta never settles, so it dragged the reader back
  // down and read to the old check as still being at the bottom.
  const pinnedRef = useRef(true);
  const autoTopRef = useRef(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // The reader's own input says they are leaving, before any scroll event
    // does: a glide they start can be cut short by the next delta's jump.
    const leave = () => {
      pinnedRef.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) leave();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) leave();
    };
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap < 8) pinnedRef.current = true;
      else if (el.scrollTop < autoTopRef.current - 2) leave();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", leave, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", leave);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  useEffect(() => {
    if (leafStreaming) pinnedRef.current = true;
  }, [leafStreaming]);

  const lastContent = path.at(-1)?.content.length ?? 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinnedRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    autoTopRef.current = el.scrollTop;
  }, [lastContent, path.length, leafStreaming]);

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
          <MessageView key={node.id} node={node} />
        ))}
      </div>
    </div>
  );
}

/**
 * The first screen. It says what the product is for — reading — and names the
 * moves in the words the toolbar uses, so the toolbar is recognised the first
 * time it appears rather than learnt.
 */
function EmptyState() {
  return (
    <div className="empty">
      <h2>A chat you can read.</h2>
      <p>
        Ask anything. It behaves like an ordinary chat — until an answer gets
        hard. Then, instead of scrolling back and retyping, act on the text
        itself:
      </p>
      <ul className="empty__moves">
        <li>
          <b>Explain</b> — click a term you don't know. It is answered beside the
          conversation, not in it.
        </li>
        <li>
          <b>Later</b> — not now. The term is marked where it is and kept in a
          list, so it is neither chased nor lost.
        </li>
        <li>
          <b>Reply</b> — select a passage to answer that part specifically.
        </li>
        <li>
          <b>Just this</b> — select a passage to ask about it on its own, with
          nothing else attached.
        </li>
        <li>
          <b>Lost me here</b> — hover the left edge of an answer and cut it where
          you stopped following. Nothing after the cut is sent.
        </li>
      </ul>
      <p className="empty__coda">
        This column stays one conversation. Side questions open beside it and are
        listed on the left; what was sent for any message is under its{" "}
        <i>context</i> button.
      </p>
    </div>
  );
}
