import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  USER_BAND_HEIGHT,
  layoutTree,
  type LaidOutNode,
} from "@/lib/treeLayout";
import { Edge, edgeColor } from "@/components/tree/edges";
import { BRANCH_META } from "@/lib/policyMeta";
import { policyLabel } from "@/lib/assembleContext";

interface TreeCanvasProps {
  width: number;
  height: number;
}

const PADDING = 26;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.2;
/** The smallest scale at which a card's label is still readable. */
const LEGIBLE_SCALE = 0.62;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export function TreeCanvas({ width, height }: TreeCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const nodes = useStore((s) => s.nodes);
  const conversationId = useStore((s) => s.conversationId);
  const activeNodeId = useStore((s) => s.activeNodeId);
  const setActiveLeafFrom = useStore((s) => s.setActiveLeafFrom);

  const setHoverNodeId = useUI((s) => s.setHoverNodeId);
  const requestScrollTo = useUI((s) => s.requestScrollTo);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [hover, setHover] = useState<LaidOutNode | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const userMovedRef = useRef(false);

  const layout = useMemo(
    () =>
      layoutTree({
        nodes,
        conversationId: conversationId ?? "",
        activeNodeId,
        expanded,
      }),
    [nodes, conversationId, activeNodeId, expanded],
  );

  /**
   * Fit everything, however small that ends up. Bound to the button, not used
   * automatically: a deep conversation fits at 30% zoom, where the cards are
   * unreadable and the map stops being a map.
   */
  const fitAll = useCallback(() => {
    if (layout.width === 0 || width === 0) return;
    const scale = clamp(
      Math.min(
        (width - PADDING * 2) / layout.width,
        (height - PADDING * 2) / Math.max(1, layout.height + CARD_HEIGHT),
      ),
      MIN_SCALE,
      1.05,
    );
    setView({ x: (width - layout.width * scale) / 2, y: PADDING, scale });
    userMovedRef.current = false;
  }, [layout.width, layout.height, width, height]);

  /**
   * The automatic fit. Fits the *width* and refuses to go below a legible
   * scale, then scrolls so the current card is in frame. Depth is what the
   * user pans; legibility is not negotiable.
   */
  const autoFit = useCallback(() => {
    if (layout.width === 0 || width === 0) return;
    const scale = clamp((width - PADDING * 2) / layout.width, LEGIBLE_SCALE, 1.05);
    const current = layout.nodes.find((n) => n.isCurrent) ?? layout.nodes.at(-1);
    const y = current
      ? clamp(
          height / 2 - current.y * scale,
          Math.min(PADDING, height - (layout.height + CARD_HEIGHT) * scale - PADDING),
          PADDING,
        )
      : PADDING;
    setView({ x: (width - layout.width * scale) / 2, y, scale });
    userMovedRef.current = false;
  }, [layout.width, layout.height, layout.nodes, width, height]);

  // Re-fit when the shape changes, but never yank the view out from under
  // someone who has panned it themselves.
  useEffect(() => {
    if (!userMovedRef.current) autoFit();
  }, [autoFit, layout.nodes.length]);

  // Keep the current card in frame as the conversation grows.
  useEffect(() => {
    const current = layout.nodes.find((n) => n.isCurrent);
    if (!current || !userMovedRef.current) return;
    const screenY = current.y * view.scale + view.y;
    if (screenY < 20 || screenY > height - 20) {
      setView((v) => ({ ...v, y: height / 2 - current.y * v.scale }));
    }
  }, [layout.nodes, height, view.scale, view.y]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    userMovedRef.current = true;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
      const k = next / v.scale;
      return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest(".treecard")) return;
    const start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    userMovedRef.current = true;

    const move = (ev: PointerEvent) => {
      setView((v) => ({
        ...v,
        x: start.vx + (ev.clientX - start.x),
        y: start.vy + (ev.clientY - start.y),
      }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const navigateTo = useCallback(
    (group: LaidOutNode) => {
      // Land on the reply the user was reading if there is one, so clicking a
      // card and clicking its message in the transcript agree.
      const target = group.replies.at(-1)?.id ?? group.user.id;
      setActiveLeafFrom(target);
      requestScrollTo(target);
      setFocusId(group.id);
    },
    [setActiveLeafFrom, requestScrollTo],
  );

  /** Arrows walk the tree; Enter navigates. §6's keyboard requirement. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const currentId = focusId ?? layout.nodes.find((n) => n.isCurrent)?.id;
    const current = layout.nodes.find((n) => n.id === currentId);
    if (!current) return;

    const siblings = layout.nodes
      .filter((n) => n.parentGroupId === current.parentGroupId)
      .sort((a, b) => a.x - b.x);
    const index = siblings.findIndex((n) => n.id === current.id);
    let next: LaidOutNode | undefined;

    switch (e.key) {
      case "ArrowLeft":
        next = siblings[index - 1];
        break;
      case "ArrowRight":
        next = siblings[index + 1];
        break;
      case "ArrowUp":
        next = layout.nodes.find((n) => n.id === current.parentGroupId);
        break;
      case "ArrowDown":
        next = layout.nodes
          .filter((n) => n.parentGroupId === current.id)
          .sort((a, b) => a.x - b.x)[0];
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        navigateTo(current);
        return;
      default:
        return;
    }
    if (!next) return;
    e.preventDefault();
    setFocusId(next.id);
    setHover(next);
  };

  if (layout.nodes.length === 0) {
    return (
      <div className="treecanvas treecanvas--empty">
        Nothing branched yet. Send a message, then select some text in a reply.
      </div>
    );
  }

  return (
    <div className="treecanvas">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onMouseLeave={() => {
          setHover(null);
          setHoverNodeId(null);
        }}
        tabIndex={0}
        role="tree"
        aria-label="Conversation tree"
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {layout.edges.map((edge) => (
            <Edge key={edge.id} edge={edge} />
          ))}
          {layout.nodes.map((node) => (
            <TreeCard
              key={node.id}
              node={node}
              focused={focusId === node.id}
              onEnter={() => {
                setHover(node);
                setHoverNodeId(node.replies.at(-1)?.id ?? node.user.id);
              }}
              onSelect={() => navigateTo(node)}
              onToggle={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.id)) next.delete(node.id);
                  else next.add(node.id);
                  return next;
                })
              }
            />
          ))}
        </g>
      </svg>

      <div className="treecanvas__controls">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={autoFit}
          title="Centre on the current turn at a readable scale"
        >
          here
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={fitAll}
          title="Fit the whole tree, however small"
        >
          all
        </button>
        <span className="treecanvas__zoom">{Math.round(view.scale * 100)}%</span>
      </div>

      {hover ? <HoverPreview node={hover} /> : null}

      <div className="treecanvas__stats">
        {layout.totalGroups} turn{layout.totalGroups === 1 ? "" : "s"}
        {layout.nodes.length < layout.totalGroups
          ? ` · ${layout.totalGroups - layout.nodes.length} collapsed`
          : ""}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function TreeCard({
  node,
  focused,
  onEnter,
  onSelect,
  onToggle,
}: {
  node: LaidOutNode;
  focused: boolean;
  onEnter: () => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const left = node.x - CARD_WIDTH / 2;
  const top = node.y - CARD_HEIGHT / 2;
  const accent = edgeColor(node.edgeKind);
  const variants = node.replies.length;
  const reply = node.replies.at(-1);

  return (
    <g
      className={`treecard${node.onActivePath ? " treecard--onpath" : ""}${
        node.isCurrent ? " treecard--current" : ""
      }${focused ? " treecard--focused" : ""}`}
      transform={`translate(${left} ${top})`}
      onMouseEnter={onEnter}
      onClick={onSelect}
      role="treeitem"
      aria-label={`Turn ${node.turn}: ${flatten(node.user.content, 60)}`}
    >
      {/* §11 Q2 / §6: retries are the same thought, so they read as a stack of
          thin parallel siblings behind one card rather than as separate nodes. */}
      {Array.from({ length: Math.min(2, Math.max(0, variants - 1)) }).map((_, i) => (
        <rect
          key={i}
          className="treecard__ghost"
          x={3 + i * 3}
          y={3 + i * 3}
          width={CARD_WIDTH}
          height={CARD_HEIGHT}
          rx={5}
        />
      ))}

      <rect
        className="treecard__body"
        width={CARD_WIDTH}
        height={CARD_HEIGHT}
        rx={5}
      />
      <rect className="treecard__spine" width={2.5} height={CARD_HEIGHT} rx={1.5} fill={accent} />

      <line
        className="treecard__divide"
        x1={2.5}
        y1={USER_BAND_HEIGHT}
        x2={CARD_WIDTH}
        y2={USER_BAND_HEIGHT}
      />

      <text className="treecard__turn" x={7} y={12}>
        {node.turn}
      </text>
      <text className="treecard__user" x={19} y={12}>
        {flatten(node.user.content, 17)}
      </text>

      {reply ? (
        <text className="treecard__reply" x={7} y={USER_BAND_HEIGHT + 13}>
          {flatten(reply.content, 22)}
        </text>
      ) : (
        <text className="treecard__reply treecard__reply--pending" x={7} y={USER_BAND_HEIGHT + 13}>
          {node.user.status === "streaming" ? "…" : "no reply"}
        </text>
      )}

      {node.user.contextPolicy.kind !== "full-ancestry" ? (
        <text className="treecard__policy" x={7} y={CARD_HEIGHT - 5} fill={accent}>
          {BRANCH_META[node.edgeKind].glyph} {policyLabel(node.user.contextPolicy)}
        </text>
      ) : null}

      {variants > 1 ? (
        <text className="treecard__variants" x={CARD_WIDTH - 7} y={12}>
          {variants}/{variants}
        </text>
      ) : null}

      {node.hiddenDescendants > 0 ? (
        <g
          className="treecard__badge"
          transform={`translate(${CARD_WIDTH / 2} ${CARD_HEIGHT + 9})`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <rect x={-13} y={-8} width={26} height={16} rx={8} />
          <text x={0} y={4}>
            +{node.hiddenDescendants}
          </text>
        </g>
      ) : node.childCount > 0 && node.hiddenDescendants === 0 && !node.onActivePath ? (
        <g
          className="treecard__badge treecard__badge--collapse"
          transform={`translate(${CARD_WIDTH / 2} ${CARD_HEIGHT + 9})`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          <rect x={-9} y={-8} width={18} height={16} rx={8} />
          <text x={0} y={4}>
            −
          </text>
        </g>
      ) : null}
    </g>
  );
}

function HoverPreview({ node }: { node: LaidOutNode }) {
  const reply = node.replies.at(-1);
  const meta = BRANCH_META[node.edgeKind];
  return (
    <div className="treehover">
      <div className="treehover__head">
        <span style={{ color: edgeColor(node.edgeKind) }}>
          {meta.glyph} {meta.label}
        </span>
        <span className="chip__sep">·</span>
        <span>turn {node.turn}</span>
      </div>
      <p className="treehover__line">
        <b>You</b> {flatten(node.user.content, 80)}
      </p>
      {reply ? (
        <p className="treehover__line">
          <b>Assistant</b> {flatten(reply.content, 80)}
        </p>
      ) : null}
      <div className="treehover__foot">
        <span className={`chip chip--${node.user.contextPolicy.kind}`}>
          {policyLabel(node.user.contextPolicy)}
        </span>
        {node.anchor && node.anchor.text ? (
          <span className="treehover__anchor">“{flatten(node.anchor.text, 40)}”</span>
        ) : null}
      </div>
    </div>
  );
}

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "—";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
