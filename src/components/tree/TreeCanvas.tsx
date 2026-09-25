import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { focusNode } from "@/store/focusNode";
import { useUI } from "@/store/useUI";
import { layoutTree, type LaidOutNode, type TreeLayout } from "@/lib/treeLayout";
import { Edge, EdgeLegend, edgeColor } from "@/components/tree/edges";
import { BRANCH_META } from "@/lib/policyMeta";
import { policyLabel } from "@/lib/assembleContext";

interface TreeCanvasProps {
  width: number;
  height: number;
}

interface View {
  x: number;
  y: number;
  scale: number;
}

const PADDING = 26;
/** Where the trunk sits across the page. Right of the reading column. */
const HOME_X = 0.79;
/** How small the whole-tree view is allowed to get before it overflows. */
const MIN_FIT = 0.45;
const MAX_FIT = 1.05;
/** Scale of the close-up view, for working on one stretch of the tree. */
const CLOSE_SCALE = 1.15;
/** Room under the last row for a "+N" collapse badge, which the layout — which
 *  knows nothing about badges — does not reserve. */
const BADGE_ROOM = 18;
/** How long the light takes to drift home once the cursor leaves. */
const RETURN_MS = 420;
/** Smallest comfortable click target for a dot, in screen pixels. */
const MIN_HIT = 7;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * The tree, drawn across the whole page and lit by a spotlight (§6).
 *
 * The map used to own a rectangle of the window, which is a bad trade: a tree
 * is mostly whitespace, so reserving space for its bounding box wastes most of
 * what it takes. It now lies over the entire page — over the thread, the
 * composer, everything — at an opacity where it reads as a watermark and the
 * words underneath stay legible.
 *
 * What makes it usable is that the cursor carries a light. Inside the light the
 * tree is at full strength and sharp; outside it is a ghost. That is also the
 * answer to scale: the whole structure is on the page at once however big it
 * gets, and you read it by sweeping the light across it rather than by panning
 * a viewport around a shape you cannot see.
 *
 * Only the dots take pointer events, so everything the tree lies over — text
 * selection, buttons, the composer — still works straight through it.
 */
export function TreeCanvas({ width, height }: TreeCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);
  const conversationId = useStore((s) => s.conversationId);
  const activeNodeId = useStore((s) => s.activeNodeId);

  const setHoverNodeId = useUI((s) => s.setHoverNodeId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [closeUp, setCloseUp] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<LaidOutNode | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);

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
   * Two views, no free zoom. The whole tree at once is the resting state —
   * being able to see all of it is the point of it being a watermark — and the
   * close-up is for when a stretch of it needs real estate.
   */
  const base = useMemo<View>(() => {
    if (!layout.nodes.length || width === 0 || height === 0) {
      return { x: 0, y: 0, scale: 1 };
    }
    const current = layout.nodes.find((n) => n.isCurrent) ?? layout.nodes.at(-1)!;
    if (closeUp) {
      return {
        scale: CLOSE_SCALE,
        x: width * HOME_X - current.x * CLOSE_SCALE,
        y: height / 2 - current.y * CLOSE_SCALE,
      };
    }
    const content = layout.height + BADGE_ROOM;
    const scale = clamp(
      Math.min(
        (width - PADDING * 2) / Math.max(1, layout.width),
        (height - PADDING * 2) / Math.max(1, content),
      ),
      MIN_FIT,
      MAX_FIT,
    );
    const trunk = layout.nodes.find((n) => n.branchLevel === 0);
    const spread = layout.width * scale;
    const wanted = width * HOME_X - (trunk ? trunk.x : layout.width / 2) * scale;
    const near = PADDING;
    const far = width - PADDING - spread;
    return {
      scale,
      x: clamp(wanted, Math.min(near, far), Math.max(near, far)),
      y:
        content * scale <= height - PADDING * 2
          ? (height - content * scale) / 2
          : height / 2 - current.y * scale,
    };
  }, [layout, width, height, closeUp]);

  const view: View = { x: base.x + pan.x, y: base.y + pan.y, scale: base.scale };

  // A pan belongs to the view it was made in.
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [closeUp, conversationId]);

  const screenOf = useCallback(
    (node: LaidOutNode) => ({
      x: node.x * view.scale + view.x,
      y: node.y * view.scale + view.y,
    }),
    [view.scale, view.x, view.y],
  );

  /* ---- the light ------------------------------------------------- */

  const current = layout.nodes.find((n) => n.isCurrent) ?? layout.nodes.at(-1);
  const homeX = current ? current.x * view.scale + view.x : width * HOME_X;
  const homeY = current ? current.y * view.scale + view.y : height / 2;

  const spot = useRef({ x: homeX, y: homeY });
  const home = useRef({ x: homeX, y: homeY });
  const tracking = useRef(false);
  const frame = useRef(0);

  const paint = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    el.style.setProperty("--spot-x", `${spot.current.x}px`);
    el.style.setProperty("--spot-y", `${spot.current.y}px`);
  }, []);

  /** Drift the light back to the turn you are on. */
  const driftHome = useCallback(() => {
    cancelAnimationFrame(frame.current);
    const from = { ...spot.current };
    const to = { ...home.current };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      spot.current = to;
      paint();
      return;
    }
    const started = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / RETURN_MS);
      const k = 1 - (1 - t) ** 3;
      spot.current = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
      paint();
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [paint]);

  // The cursor carries the light while it is over the page. Moving it is a
  // direct DOM write on two custom properties rather than a re-render — the
  // tree is drawn three times over and cannot be reconciled at pointer rate.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const inside = x >= 0 && y >= 0 && x <= box.width && y <= box.height;
      if (inside) {
        cancelAnimationFrame(frame.current);
        tracking.current = true;
        spot.current = { x, y };
        paint();
      } else if (tracking.current) {
        tracking.current = false;
        driftHome();
      }
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(frame.current);
    };
  }, [driftHome, paint]);

  // Follow the highlighted turn as it moves, but never yank the light out of
  // the user's hand while they are pointing at something.
  useEffect(() => {
    home.current = { x: homeX, y: homeY };
    if (tracking.current) return;
    driftHome();
  }, [homeX, homeY, driftHome]);

  useEffect(() => {
    if (!tracking.current) spot.current = { ...home.current };
    paint();
  }, [width, height, paint]);

  /* ---- interaction ------------------------------------------------ */

  const dragged = useRef(false);

  const onGrab = useCallback(
    (e: React.PointerEvent) => {
      const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      dragged.current = false;
      const move = (ev: PointerEvent) => {
        if (!dragged.current && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) {
          return;
        }
        dragged.current = true;
        setPan({ x: start.px + (ev.clientX - start.x), y: start.py + (ev.clientY - start.y) });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [pan.x, pan.y],
  );

  const navigateTo = useCallback(
    (group: LaidOutNode) => {
      if (dragged.current) return;
      // Land on the reply the user was reading if there is one, so clicking a
      // dot and clicking its message in the transcript agree.
      const target = group.replies.at(-1)?.id ?? group.user.id;
      // The dot may be on a branch, in which case this opens its window rather
      // than pulling the branch into the thread.
      focusNode(target);
      setFocusId(group.id);
    },
    [focusNode],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // The preview card follows the dot under the cursor, and lets go a beat late
  // so that sweeping across a fork does not strobe it.
  const hoverTimer = useRef<number | undefined>(undefined);
  const enterNode = useCallback(
    (node: LaidOutNode) => {
      window.clearTimeout(hoverTimer.current);
      setHover(node);
      setHoverNodeId(node.replies.at(-1)?.id ?? node.user.id);
    },
    [setHoverNodeId],
  );
  const leaveNode = useCallback(() => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      setHover(null);
      setHoverNodeId(null);
    }, 110);
  }, [setHoverNodeId]);
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  /** Arrows walk the tree; Enter navigates. §6's keyboard requirement. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const currentId = focusId ?? layout.nodes.find((n) => n.isCurrent)?.id;
    const from = layout.nodes.find((n) => n.id === currentId);
    if (!from) return;

    const siblings = layout.nodes
      .filter((n) => n.parentGroupId === from.parentGroupId)
      .sort((a, b) => a.x - b.x);
    const index = siblings.findIndex((n) => n.id === from.id);
    let next: LaidOutNode | undefined;

    switch (e.key) {
      case "ArrowLeft":
        next = siblings[index - 1];
        break;
      case "ArrowRight":
        next = siblings[index + 1];
        break;
      case "ArrowUp":
        next = layout.nodes.find((n) => n.id === from.parentGroupId);
        break;
      case "ArrowDown":
        next = layout.nodes
          .filter((n) => n.parentGroupId === from.id)
          .sort((a, b) => a.x - b.x)[0];
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        navigateTo(from);
        return;
      default:
        return;
    }
    if (!next) return;
    e.preventDefault();
    setFocusId(next.id);
    setHover(next);
  };

  const hoverAt = hover ? screenOf(hover) : null;

  // The root is rendered whether or not there is a tree yet: the light's
  // listener binds to it once, and an early return would leave it holding a
  // null ref for the life of the conversation.
  if (layout.nodes.length === 0) {
    return (
      <div className="treecanvas" ref={rootRef}>
        <p className="treecanvas__empty">
          Nothing branched yet. Send a message, then select some text in a reply.
        </p>
      </div>
    );
  }

  return (
    <div className="treecanvas" ref={rootRef}>
      {/* The watermark: the whole tree, always, faint enough to read through. */}
      <div className="treelayer treelayer--ambient" aria-hidden>
        <TreeWorld layout={layout} view={view} width={width} height={height} tone="ambient" />
      </div>

      {/* The lit patch under the cursor, cut out of an identical sharp copy. */}
      <div className="treelayer treelayer--lit" aria-hidden>
        <TreeWorld layout={layout} view={view} width={width} height={height} tone="lit" />
      </div>

      <svg
        className="treelayer treelayer--hits"
        width={width}
        height={height}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="tree"
        aria-label="Conversation tree"
      >
        {layout.nodes.map((node) => {
          const at = screenOf(node);
          return (
            <TreeHit
              key={node.id}
              node={node}
              x={at.x}
              y={at.y}
              radius={Math.max(MIN_HIT, (node.radius + 3) * view.scale)}
              badgeOffset={(node.radius + 10) * view.scale}
              focused={focusId === node.id}
              onGrab={onGrab}
              onEnter={() => enterNode(node)}
              onLeave={leaveNode}
              onSelect={() => navigateTo(node)}
              onToggle={() => toggleExpanded(node.id)}
            />
          );
        })}
      </svg>

      <div className="treecanvas__controls">
        <button
          type="button"
          className={`btn btn--sm btn--ghost${closeUp ? " btn--on" : ""}`}
          onClick={() => setCloseUp((v) => !v)}
          aria-pressed={closeUp}
          title={closeUp ? "Back to the whole tree" : "Close up on the current turn"}
        >
          {closeUp ? "all" : "here"}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => setLegend((v) => !v)}
          aria-pressed={legend}
          title="Edge types"
        >
          ?
        </button>
        <span className="treecanvas__zoom">{Math.round(view.scale * 100)}%</span>
      </div>

      {legend ? <EdgeLegend onClose={() => setLegend(false)} /> : null}

      {hover && hoverAt ? (
        <HoverPreview node={hover} place={hoverAt.y < height / 2 ? "bottom" : "top"} />
      ) : null}

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

/** The drawn tree. Rendered twice — once as a watermark, once lit. */
function TreeWorld({
  layout,
  view,
  width,
  height,
  tone,
}: {
  layout: TreeLayout;
  view: View;
  width: number;
  height: number;
  tone: "ambient" | "lit";
}) {
  return (
    <svg width={width} height={height} aria-hidden>
      <g
        className={`treeworld treeworld--${tone}`}
        transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}
      >
        {layout.edges.map((edge) => (
          <Edge key={edge.id} edge={edge} />
        ))}
        {layout.nodes.map((node) => (
          <TreeDot key={node.id} node={node} />
        ))}
      </g>
    </svg>
  );
}

/**
 * One turn. A dot on a line, sized by how far it has strayed from the trunk.
 *
 * The vocabulary is deliberately small: the ring is the origin kind's colour,
 * a filled core means the turn has an answer, a second ring means retries are
 * stacked underneath, and the one turn you are reading wears a halo — which
 * stays lit in the watermark, so you can always find yourself.
 */
function TreeDot({ node }: { node: LaidOutNode }) {
  const accent = edgeColor(node.edgeKind);
  const reply = node.replies.at(-1);
  const streaming = node.user.status === "streaming" || reply?.status === "streaming";
  const failed = node.user.status === "error" || reply?.status === "error";
  const radius = node.radius;

  const classes = [
    "treedot",
    node.onActivePath ? "treedot--onpath" : "",
    node.isCurrent ? "treedot--current" : "",
    node.branchLevel === 0 ? "treedot--trunk" : "treedot--branch",
    streaming ? "treedot--streaming" : "",
    failed ? "treedot--error" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <g className={classes} transform={`translate(${node.x} ${node.y})`}>
      {node.isCurrent ? (
        <>
          <circle className="treedot__halo" r={radius + 4} />
          <circle className="treedot__pulse" r={radius + 4} />
        </>
      ) : null}

      {node.replies.length > 1 ? (
        <circle className="treedot__variants" r={radius + 2.2} />
      ) : null}

      <circle className="treedot__disc" r={radius} style={{ stroke: accent }} />

      {reply ? (
        <circle className="treedot__core" r={radius * 0.42} style={{ fill: accent }} />
      ) : null}

      {node.hiddenDescendants > 0 ? (
        <g className="treedot__badge" transform={`translate(0 ${radius + 10})`}>
          <rect x={-10} y={-6.5} width={20} height={13} rx={6.5} />
          <text x={0} y={3.4}>
            +{node.hiddenDescendants}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/**
 * The interactive twin of a dot, in screen space so the target stays clickable
 * however far the tree has been scaled down. It is the only part of the whole
 * layer that takes a pointer event — everything the tree lies over stays live.
 */
function TreeHit({
  node,
  x,
  y,
  radius,
  badgeOffset,
  focused,
  onGrab,
  onEnter,
  onLeave,
  onSelect,
  onToggle,
}: {
  node: LaidOutNode;
  x: number;
  y: number;
  radius: number;
  badgeOffset: number;
  focused: boolean;
  onGrab: (e: React.PointerEvent) => void;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <g
      className={`treedot__target${focused ? " treedot__target--focused" : ""}`}
      transform={`translate(${x} ${y})`}
      onPointerDown={onGrab}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onSelect}
      role="treeitem"
      aria-selected={node.isCurrent}
      aria-label={`Turn ${node.turn}, ${BRANCH_META[node.edgeKind].label}: ${flatten(
        node.user.content,
        60,
      )}`}
    >
      {focused ? <circle className="treedot__focusring" r={radius} /> : null}
      <circle r={radius} fill="transparent" />
      {node.hiddenDescendants > 0 ? (
        <circle
          r={Math.max(MIN_HIT, radius * 0.9)}
          cy={badgeOffset}
          fill="transparent"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        />
      ) : null}
    </g>
  );
}

function HoverPreview({ node, place }: { node: LaidOutNode; place: "top" | "bottom" }) {
  const reply = node.replies.at(-1);
  const meta = BRANCH_META[node.edgeKind];
  return (
    <div className={`treehover treehover--${place}`}>
      <div className="treehover__head">
        <span style={{ color: edgeColor(node.edgeKind) }}>
          {meta.glyph} {meta.label}
        </span>
        <span className="chip__sep">·</span>
        <span>turn {node.turn}</span>
        <span className="chip__sep">·</span>
        <span>{node.branchLevel === 0 ? "trunk" : `branch ${node.branchLevel}`}</span>
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
