import { memo, useMemo, useRef } from "react";
import type { ConversationNode } from "@/types";
import { Markdown } from "@/components/Markdown";
import { ContextChip, Inspector } from "@/components/ContextChip";
import { BRANCH_META, branchColor } from "@/lib/policyMeta";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { childrenOf, siblingsOf } from "@/lib/tree";

interface MessageViewProps {
  node: ConversationNode;
  turn: number;
  /** The next node down the active path, so the rail knows where it leads. */
  isLast: boolean;
}

export const MessageView = memo(function MessageView({ node, turn, isLast }: MessageViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const regenerate = useStore((s) => s.regenerate);
  const deleteSubtree = useStore((s) => s.deleteSubtree);
  const setActiveLeafFrom = useStore((s) => s.setActiveLeafFrom);
  const assemble = useStore((s) => s.assemble);

  const openInspector = useUI((s) => s.openInspectors.has(node.id));
  const hovered = useUI((s) => s.hoverNodeId === node.id);
  const cropHover = useUI((s) => (s.cropHover?.nodeId === node.id ? s.cropHover.charOffset : null));

  const streaming = streamingNodeId === node.id;
  const siblings = useMemo(() => siblingsOf(nodes, node.id), [nodes, node.id]);
  const siblingIndex = siblings.findIndex((s) => s.id === node.id);
  const branchCount = useMemo(() => childrenOf(nodes, node.id).length, [nodes, node.id]);

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
      id={`msg-${node.id}`}
      data-node-id={node.id}
    >
      {/* The gutter rail is where §5.2's crop handle lands in P1. */}
      <div className="msg__rail" />

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
                onClick={() => setActiveLeafFrom(siblings[siblingIndex - 1].id)}
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
                onClick={() => setActiveLeafFrom(siblings[siblingIndex + 1].id)}
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
                onClick={() => void regenerate(node.id)}
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
          {branchCount > 1 && isLast === false ? (
            <span className="msg__branchcount">{branchCount} branches below</span>
          ) : null}
        </footer>

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
