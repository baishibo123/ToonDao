import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { layoutTree, type LaidOutNode, type TreeLayout } from "@/lib/treeLayout";
import { Edge, edgeColor } from "@/components/tree/edges";
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

const PADDING = 22;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.6;
/**
 * The scale the resting view refuses to go below. A long conversation is not
 * shrunk to fit — shrinking is how a map becomes a smudge. It stays readable,
 * overflows, and hands the overflow to the focus mask.
 */
const LEGIBLE_SCALE = 1;
/** How far an automatic fit may enlarge a small tree. */
const MAX_FIT = 1.7;
/** Softness of the out-of-focus copy, in screen pixels. */
const BLUR = 2.2;
/** Room under the last row for a "+N" collapse badge, which the layout — which
 *  knows nothing about badges — does not reserve. */
const BADGE_ROOM = 18;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * An exponential ease toward `target`, in a ref so it survives re-layout.
 * Used for the reveal, which has to interpolate a transform, a mask radius and
 * an opacity together — CSS can transition none of those on an SVG mask.
 */
function useEased(target: number, speed = 0.18): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setValue(target);
      return;
    }
    let frame = 0;
    const step = () => {
      const next = current.current + (target - current.current) * speed;
      const done = Math.abs(target - next) < 0.003;
      current.current = done ? target : next;
      setValue(current.current);
      if (!done) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, speed]);

  return value;
}

/**
 * Put the trunk down the middle, which is the whole point of having one — but
 * never at the cost of pushing a branch off the edge, so the offer is withdrawn
 * as soon as the tree is wider than the panel.
 */
function centreOnTrunk(layout: TreeLayout, viewport: number, scale: number): number {
  const trunk = layout.nodes.find((n) => n.branchLevel === 0);
  const content = layout.width * scale;
  const wanted = viewport / 2 - (trunk ? trunk.x : layout.width / 2) * scale;
  const edge = viewport - PADDING - content;
  return clamp(wanted, Math.min(PADDING, edge), Math.max(PADDING, edge));
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
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const [userMoved, setUserMoved] = useState(false);
  const [hover, setHover] = useState<LaidOutNode | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pointerInside, setPointerInside] = useState(false);
  const uid = useId().replace(/:/g, "");

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
  const leaveNode = useCallback(
    (immediate = false) => {
      window.clearTimeout(hoverTimer.current);
      const clear = () => {
        setHover(null);
        setHoverNodeId(null);
      };
      if (immediate) clear();
      else hoverTimer.current = window.setTimeout(clear, 110);
    },
    [setHoverNodeId],
  );
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

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

  /** Everything at once, however small that ends up. */
  const overview = useMemo<View>(() => {
    if (!layout.nodes.length || width === 0 || height === 0) {
      return { x: 0, y: 0, scale: 1 };
    }
    const scale = clamp(
      Math.min(
        (width - PADDING * 2) / Math.max(1, layout.width),
        (height - PADDING * 2) / Math.max(1, layout.height + BADGE_ROOM),
      ),
      MIN_SCALE,
      MAX_FIT,
    );
    return {
      scale,
      x: centreOnTrunk(layout, width, scale),
      y: (height - (layout.height + BADGE_ROOM) * scale) / 2,
    };
  }, [layout, width, height]);

  /**
   * The resting view: a readable scale, parked on the turn you are in. Depth is
   * what the user pans; legibility is not negotiable. The whole tree is one
   * hover away, so this view does not have to compromise to show it.
   */
  const focused = useMemo<View>(() => {
    if (!layout.nodes.length || width === 0 || height === 0) {
      return { x: 0, y: 0, scale: 1 };
    }
    // Fill the panel when the tree is small enough to fill it, and stop at a
    // legible scale when it is not — at which point the focus mask takes over
    // and the rest of the tree is a hover away.
    const scale = clamp(
      Math.min(
        (width - PADDING * 2) / Math.max(1, layout.width),
        (height - PADDING * 2) / Math.max(1, layout.height + BADGE_ROOM),
      ),
      LEGIBLE_SCALE,
      MAX_FIT,
    );
    const current = layout.nodes.find((n) => n.isCurrent) ?? layout.nodes.at(-1)!;
    const content = (layout.height + BADGE_ROOM) * scale;
    return {
      scale,
      x: centreOnTrunk(layout, width, scale),
      y:
        content <= height - PADDING * 2
          ? (height - content) / 2
          : clamp(height / 2 - current.y * scale, height - PADDING - content, PADDING),
    };
  }, [layout, width, height]);

  // Re-fit when the shape changes, but never yank the view out from under
  // someone who has panned it themselves.
  useEffect(() => {
    if (!userMoved) setView(focused);
  }, [focused, userMoved]);

  // Keep the current turn in frame as the conversation grows.
  useEffect(() => {
    if (!userMoved) return;
    const current = layout.nodes.find((n) => n.isCurrent);
    if (!current) return;
    const screenY = current.y * view.scale + view.y;
    if (screenY < 20 || screenY > height - 20) {
      setView((v) => ({ ...v, y: height / 2 - current.y * v.scale }));
    }
  }, [layout.nodes, height, userMoved, view.scale, view.y]);

  /**
   * §6's focus rule. A tree that fits needs no help; one that runs off the
   * panel gets a soft edge, so the eye lands on the stretch you are working in
   * instead of on a wall of dots. Hovering the panel dissolves it — that is the
   * gesture for "show me the whole thing", and it costs nothing to undo.
   */
  const overflows =
    layout.nodes.length > 0 &&
    ((layout.height + BADGE_ROOM) * view.scale > height - PADDING ||
      layout.width * view.scale > width - PADDING);

  const reveal = useEased(pointerInside && overflows ? 1 : 0);
  const masked = overflows && reveal < 0.995;

  const shown: View = userMoved
    ? view
    : {
        x: lerp(view.x, overview.x, reveal),
        y: lerp(view.y, overview.y, reveal),
        scale: lerp(view.scale, overview.scale, reveal),
      };

  const anchorNode = layout.nodes.find((n) => n.isCurrent) ?? layout.nodes.at(-1);
  const focusX = anchorNode ? anchorNode.x * shown.scale + shown.x : width / 2;
  const focusY = anchorNode ? anchorNode.y * shown.scale + shown.y : height / 2;
  const focusR = lerp(
    Math.max(130, Math.min(width, height) * 0.55),
    Math.hypot(width, height) * 1.2,
    reveal,
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setUserMoved(true);
    setView((v) => {
      const from = userMoved ? v : shown;
      const next = clamp(from.scale * (e.deltaY < 0 ? 1.12 : 0.89), MIN_SCALE, MAX_SCALE);
      const k = next / from.scale;
      return { scale: next, x: px - (px - from.x) * k, y: py - (py - from.y) * k };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest(".treedot__target")) return;
    const from = userMoved ? view : shown;
    const start = { x: e.clientX, y: e.clientY, vx: from.x, vy: from.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    let dragged = false;

    const move = (ev: PointerEvent) => {
      if (!dragged && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      dragged = true;
      setUserMoved(true);
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
      // dot and clicking its message in the transcript agree.
      const target = group.replies.at(-1)?.id ?? group.user.id;
      setActiveLeafFrom(target);
      requestScrollTo(target);
      setFocusId(group.id);
    },
    [setActiveLeafFrom, requestScrollTo],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
    <div
      className={`treecanvas${masked ? " treecanvas--masked" : ""}`}
      onMouseEnter={() => setPointerInside(true)}
      // Also on move: a panel that opens under a cursor already sitting on it
      // never receives an enter, and would stay masked until the mouse left
      // and came back.
      onMouseMove={() => setPointerInside(true)}
      onMouseLeave={() => {
        setPointerInside(false);
        leaveNode(true);
      }}
    >
      <svg
        ref={svgRef}
        width={width}
        height={height}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="tree"
        aria-label="Conversation tree"
      >
        <defs>
          <radialGradient
            id={`${uid}-focus`}
            gradientUnits="userSpaceOnUse"
            cx={focusX}
            cy={focusY}
            r={Math.max(1, focusR)}
          >
            <stop offset="0" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.42" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.78" stopColor="#fff" stopOpacity="0.45" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
            <rect width={width} height={height} fill={`url(#${uid}-focus)`} />
          </mask>
          <filter id={`${uid}-blur`} x="-8%" y="-8%" width="116%" height="116%">
            <feGaussianBlur stdDeviation={BLUR * (1 - reveal)} />
          </filter>
          <filter id={`${uid}-glow`} x="-260%" y="-260%" width="620%" height="620%">
            <feGaussianBlur stdDeviation={2.4} result="halo" />
            <feMerge>
              <feMergeNode in="halo" />
              <feMergeNode in="halo" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* The out-of-focus copy. Only what is masked away above shows through,
            so the tree does not stop at the edge of the panel — it goes soft. */}
        {masked ? (
          <g className="treecanvas__far" opacity={0.55 * (1 - reveal)} filter={`url(#${uid}-blur)`}>
            <TreeWorld layout={layout} view={shown} glowId={`${uid}-glow`} />
          </g>
        ) : null}

        <g mask={masked ? `url(#${uid}-mask)` : undefined}>
          <TreeWorld layout={layout} view={shown} glowId={`${uid}-glow`} />
        </g>

        {/* Hit targets live outside the mask so a faded turn is still clickable. */}
        <g className="treecanvas__hits" transform={`translate(${shown.x} ${shown.y}) scale(${shown.scale})`}>
          {layout.nodes.map((node) => (
            <TreeHit
              key={node.id}
              node={node}
              focused={focusId === node.id}
              onEnter={() => enterNode(node)}
              onLeave={() => leaveNode()}
              onSelect={() => navigateTo(node)}
              onToggle={() => toggleExpanded(node.id)}
            />
          ))}
        </g>
      </svg>

      <div className="treecanvas__controls">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            setUserMoved(false);
            setView(focused);
          }}
          title="Centre on the current turn at a readable scale"
        >
          here
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => {
            setUserMoved(true);
            setView(overview);
          }}
          title="Fit the whole tree, however small"
        >
          all
        </button>
        <span className="treecanvas__zoom">{Math.round(shown.scale * 100)}%</span>
      </div>

      {hover ? (
        <HoverPreview
          node={hover}
          // Sit opposite the turn being described, so the card never covers the
          // dot the cursor is on — or the stretch of tree around it.
          place={hover.y * shown.scale + shown.y < height / 2 ? "bottom" : "top"}
        />
      ) : null}

      <div className="treecanvas__stats">
        {layout.totalGroups} turn{layout.totalGroups === 1 ? "" : "s"}
        {layout.nodes.length < layout.totalGroups
          ? ` · ${layout.totalGroups - layout.nodes.length} collapsed`
          : ""}
        {overflows && !hover ? " · hover to reveal" : ""}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** The drawn tree. Rendered twice — once sharp, once soft behind the mask. */
function TreeWorld({
  layout,
  view,
  glowId,
}: {
  layout: TreeLayout;
  view: View;
  glowId: string;
}) {
  return (
    <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
      {layout.edges.map((edge) => (
        <Edge key={edge.id} edge={edge} />
      ))}
      {layout.nodes.map((node) => (
        <TreeDot key={node.id} node={node} glowId={glowId} />
      ))}
    </g>
  );
}

/**
 * One turn. A dot on a line, sized by how far it has strayed from the trunk.
 *
 * The vocabulary is deliberately small: the ring is the origin kind's colour,
 * a filled core means the turn has an answer, a second ring means retries are
 * stacked underneath, and the one turn you are reading wears a halo.
 */
function TreeDot({ node, glowId }: { node: LaidOutNode; glowId: string }) {
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
          <circle className="treedot__halo" r={radius + 4.5} filter={`url(#${glowId})`} />
          <circle className="treedot__pulse" r={radius + 4.5} />
        </>
      ) : null}

      {node.replies.length > 1 ? (
        <circle className="treedot__variants" r={radius + 2.4} />
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
 * The interactive twin of a dot: a generous transparent target, kept out of the
 * focus mask so a dimmed turn is still reachable by mouse and by keyboard.
 */
function TreeHit({
  node,
  focused,
  onEnter,
  onLeave,
  onSelect,
  onToggle,
}: {
  node: LaidOutNode;
  focused: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <g
      className={`treedot__target${focused ? " treedot__target--focused" : ""}`}
      transform={`translate(${node.x} ${node.y})`}
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
      {focused ? <circle className="treedot__focusring" r={node.radius + 5} /> : null}
      <circle r={node.radius + 7} fill="transparent" />
      {node.hiddenDescendants > 0 ? (
        <circle
          r={9}
          cy={node.radius + 10}
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

function HoverPreview({
  node,
  place,
}: {
  node: LaidOutNode;
  place: "top" | "bottom";
}) {
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
