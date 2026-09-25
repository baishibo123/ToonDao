import { memo, useMemo, useRef } from "react";
import type { ConversationNode } from "@/types";
import { Markdown } from "@/components/Markdown";
import { ContextChip, Inspector } from "@/components/ContextChip";
import { BRANCH_META, branchColor } from "@/lib/policyMeta";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { siblingsOf } from "@/lib/tree";
import { branchLabel, forksOf, spineLeaf } from "@/lib/outline";
import { CropRail } from "@/components/CropRail";
import { messageDomId, useSurface } from "@/components/Surface";
import { focusNode } from "@/store/focusNode";

interface MessageViewProps {
  node: ConversationNode;
  turn: number;
}

export const MessageView = memo(function MessageView({ node, turn }: MessageViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { windowId } = useSurface();
  const nodes = useStore((s) => s.nodes);
  const preferredChild = useStore((s) => s.preferredChild);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const regenerate = useStore((s) => s.regenerate);
  const deleteSubtree = useStore((s) => s.deleteSubtree);
  const assemble = useStore((s) => s.assemble);
  const setBranchWindowActive = useUI((s) => s.setBranchWindowActive);

  const openInspector = useUI((s) => s.openInspectors.has(node.id));
  const hovered = useUI((s) => s.hoverNodeId === node.id);
  const cropHover = useUI((s) => (s.cropHover?.nodeId === node.id ? s.cropHover.charOffset : null));

  const streaming = streamingNodeId === node.id;

  /**
   * Switch to another attempt at this same turn. It is on this spine, so it
   * moves this surface's own leaf and nothing else's — and down that attempt's
   * own continuations, because the turns under the attempt you were reading
   * belong to that one.
   */
  const goTo = (id: string) => {
    if (windowId) setBranchWindowActive(windowId, spineLeaf(nodes, id, preferredChild));
    else focusNode(id);
  };
  /**
   * Other attempts at this same turn — retries, switched in place with `‹ ›`.
   *
   * Only replies count. A *user* node's siblings are separate lines of thought
   * off one message, and each of those is its own window now: offering them
   * here as though they were variants of one message would say the opposite of
   * what the layout says, and the fork marks below already lead to them.
   */
  const siblings = useMemo(
    () =>
      node.role === "assistant"
        ? // Role-filtered: a user node can have both replies and a gesture made
          // against it, and only the replies are attempts at this turn.
          siblingsOf(nodes, node.id).filter((sibling) => sibling.role === "assistant")
        : [],
    [nodes, node.id, node.role],
  );
  const siblingIndex = siblings.findIndex((s) => s.id === node.id);

  /**
   * The lines of thought that left from this message. They are not rendered
   * inline — each one is a spine of its own and lives in its own window — so
   * the transcript marks where they left and offers to open them. Without this,
   * a branch would be reachable only from the sidebar, and the passage that
   * caused it would carry no trace of it.
   */
  const forks = useMemo(
    () => forksOf(nodes, node.id, preferredChild),
    [nodes, node.id, preferredChild],
  );

  const messages = useMemo(
    () => (openInspector ? assemble(node) : []),
    // Only assembled when the inspector is actually open; a 200-node tree
    // should not be assembling 200 payloads on every keystroke.
    [openInspector, node, assemble],
  );
  const chipMessages = useMemo(() => assemble(node), [node, assemble]);

  const origin = node.origin;
  const meta = origin ? BRANCH_META[origin.kind] : null;
  const showOriginBadge = Boolean(
    meta && origin && origin.kind !== "continuation",
  );

  return (
    <article
      className={`msg msg--${node.role}${hovered ? " msg--hovered" : ""}`}
      id={messageDomId(node.id, windowId)}
      data-node-id={node.id}
    >
      <div className="msg__rail">
        {node.role === "assistant" &&
        node.status !== "streaming" &&
        node.content.length > 0 ? (
          <CropRail node={node} contentRef={contentRef} />
        ) : null}
      </div>

      <div className="msg__body">
        <header className="msg__head">
          <span className="msg__role">
            {node.role === "user" ? `You · turn ${turn}` : "Assistant"}
          </span>

          {showOriginBadge && meta && origin ? (
            <span
              className="msg__origin"
              style={{
                color: branchColor(origin.kind),
                borderColor: `color-mix(in oklab, ${branchColor(origin.kind)} 45%, transparent)`,
                background: `color-mix(in oklab, ${branchColor(origin.kind)} 10%, transparent)`,
              }}
              title={meta.blurb}
            >
              <span aria-hidden>{meta.glyph}</span>
              {meta.label}
            </span>
          ) : null}

          <span className="msg__spacer" />

          {siblings.length > 1 ? (
            <span className="variants" title={`${siblings.length} branches from this point`}>
              <button
                type="button"
                aria-label="Previous branch"
                disabled={siblingIndex <= 0}
                onClick={() => goTo(siblings[siblingIndex - 1].id)}
              >
                ‹
              </button>
              <span className="variants__n">
                {siblingIndex + 1}/{siblings.length}
              </span>
              <button
                type="button"
                aria-label="Next branch"
                disabled={siblingIndex >= siblings.length - 1}
                onClick={() => goTo(siblings[siblingIndex + 1].id)}
              >
                ›
              </button>
            </span>
          ) : null}

          <span className="msg__actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void navigator.clipboard?.writeText(node.content)}
              title="Copy raw markdown"
            >
              copy
            </button>
            {node.role === "assistant" && !streaming ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() =>
                  void regenerate(node.id, {
                    detached: Boolean(windowId),
                    ...(windowId
                      ? {
                          onCommitted: (id: string) =>
                            setBranchWindowActive(windowId, id),
                        }
                      : {}),
                  })
                }
                title="Retry this prompt as a sibling"
              >
                retry
              </button>
            ) : null}
            {node.parentId ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--danger"
                onClick={() => void deleteSubtree(node.id)}
                title="Delete this node and everything below it"
              >
                delete
              </button>
            ) : null}
          </span>
        </header>

        {origin?.anchor && origin.kind !== "structural-crop" && origin.anchor.text ? (
          <p className="msg__anchor-note">
            <b>{anchorVerb(origin.kind)}</b> “{truncate(origin.anchor.text, 220)}”
          </p>
        ) : null}

        {origin?.kind === "structural-crop" && origin.anchor ? (
          <p className="msg__anchor-note">
            <b>Cut at character {origin.anchor.start}</b> — everything after that
            point in the previous answer was withheld from the prompt.
          </p>
        ) : null}

        <div className="msg__content" ref={contentRef}>
          <TailDimmedContent node={node} cropAt={cropHover} />
          {streaming ? <span className="caret" aria-label="streaming" /> : null}
        </div>

        {node.status === "error" && node.error ? (
          <p className="msg__error" role="alert">
            {node.error}
          </p>
        ) : null}

        <footer className="msg__foot">
          <ContextChip
            nodeId={node.id}
            policy={node.contextPolicy}
            messages={chipMessages}
            detail={windowDetail(node)}
          />
        </footer>

        {forks.length > 0 ? (
          <div className="forks" aria-label="Branches from this message">
            {forks.map((fork) => (
              <ForkMark key={fork.id} fork={fork} />
            ))}
          </div>
        ) : null}

        {openInspector ? (
          <Inspector
            policy={node.contextPolicy}
            messages={messages}
            historical={node.assembledPreview}
          />
        ) : null}
      </div>
    </article>
  );
});

/** One branch that left from a message, as a way back into it. */
function ForkMark({ fork }: { fork: ConversationNode }) {
  const kind = fork.origin?.kind ?? "continuation";
  const meta = BRANCH_META[kind];
  const open = useUI((s) => s.windows.some((w) => w.rootNodeId === fork.id));
  return (
    <button
      type="button"
      className={`fork${open ? " fork--open" : ""}`}
      style={{ ["--kind" as string]: branchColor(kind) }}
      title={`${meta.label} — ${meta.blurb}\n${open ? "Its window is open" : "Opens in its own window"}`}
      onClick={() => focusNode(fork.id)}
    >
      <span className="fork__glyph" aria-hidden>
        {meta.glyph}
      </span>
      <span className="fork__label">{branchLabel(fork)}</span>
      <span className="fork__open" aria-hidden>
        ⧉
      </span>
    </button>
  );
}

/**
 * §5.2's live preview: while the crop rail is hovered, the tail that would be
 * thrown away dims to ~30%. Split at the cut so the discarded part is visibly
 * still there — the source is never mutated, only the prompt is.
 */
function TailDimmedContent({
  node,
  cropAt,
}: {
  node: ConversationNode;
  cropAt: number | null;
}) {
  if (cropAt === null || cropAt >= node.content.length) {
    return <Markdown source={node.content} />;
  }
  return (
    <>
      <Markdown source={node.content.slice(0, cropAt)} />
      <div className="msg__discarded" aria-hidden>
        <Markdown source={node.content.slice(cropAt)} />
      </div>
    </>
  );
}

function windowDetail(node: ConversationNode): string | undefined {
  const policy = node.contextPolicy;
  if (policy.kind === "windowed") return `${policy.turns * 2} msgs inlined`;
  if (policy.kind === "truncated") return "tail withheld";
  return undefined;
}

function anchorVerb(kind: string): string {
  switch (kind) {
    case "concept-lens":
      return "About";
    case "isolated-selection":
      return "Only this:";
    case "quote-reply":
      return "Replying to";
    default:
      return "Anchored to";
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
