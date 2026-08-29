import type { ReactNode } from "react";
import type { BranchKind } from "@/types";
import type { LaidOutEdge } from "@/lib/treeLayout";
import { BRANCH_META } from "@/lib/policyMeta";

/**
 * Typed edges (§6). This is where the personality lives: "the difference
 * between an inherited edge and a detached edge should be legible at a glance
 * without a legend."
 *
 *   continuation        solid neutral hairline
 *   concept-lens        solid accent, heavier
 *   structural-crop     dashed, scissor cap at the parent end
 *   isolated-selection  dotted, with a visible GAP at the parent end — the gap
 *                       *is* the semantics: nothing flowed down this edge
 *   quote-reply         doubled hairline
 *   regenerate          not an inter-turn edge; retries collapse into the
 *                       variant ring drawn around the dot
 *
 * Two geometries carry the trunk/branch distinction. An edge between two turns
 * of one thread is a straight vertical run, so the trunk reads as one unbroken
 * line with its turns strung along it. An edge that forks leaves the parent
 * sideways and arrives from directly above the child — a quarter arc, which is
 * what makes a fork read as a distributary rather than as a corner.
 */

const GAP_AT_PARENT = 8;
/** Circle-approximation constants for the quarter arc a fork draws. */
const OUT_TANGENT = 0.62;
const IN_TANGENT = 0.55;

export function edgeColor(kind: BranchKind): string {
  return `var(${BRANCH_META[kind].cssVar})`;
}

export function edgePath(edge: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isSpine: boolean;
}): string {
  const { x1, y1, x2, y2 } = edge;
  if (edge.isSpine || Math.abs(x2 - x1) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dx = x2 - x1;
  const dy = y2 - y1;
  return `M ${x1} ${y1} C ${x1 + dx * OUT_TANGENT} ${y1}, ${x2} ${y2 - dy * IN_TANGENT}, ${x2} ${y2}`;
}

/** Shorten a path's start along its initial direction, for the isolated gap. */
function shiftStart(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  by: number,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  return { x: x1 + (dx / length) * by, y: y1 + (dy / length) * by };
}

export function Edge({ edge }: { edge: LaidOutEdge }): ReactNode {
  const { kind, x2, y2, isSpine, onActivePath } = edge;
  let { x1, y1 } = edge;
  const color = edgeColor(kind);

  if (kind === "isolated-selection") {
    // The gap at the parent end encodes "no inheritance". Nothing crosses it.
    const shifted = shiftStart(x1, y1, x2, y2, GAP_AT_PARENT);
    x1 = shifted.x;
    y1 = shifted.y;
  }

  const d = edgePath({ x1, y1, x2, y2, isSpine });

  return (
    <g
      className={`edge${onActivePath ? " edge--onpath" : ""}${isSpine ? " edge--spine" : ""}`}
      data-kind={kind}
    >
      {kind === "quote-reply" ? (
        <>
          <path d={d} fill="none" stroke={color} strokeWidth={0.75} transform="translate(-1.3,0)" />
          <path d={d} fill="none" stroke={color} strokeWidth={0.75} transform="translate(1.3,0)" />
        </>
      ) : (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth(kind)}
          strokeDasharray={dashArray(kind)}
          strokeLinecap={kind === "isolated-selection" ? "round" : "butt"}
        />
      )}

      {kind === "structural-crop" ? (
        <text
          className="edge__cap"
          x={edge.x1 + 2}
          y={edge.y1 - 2}
          fill={color}
          fontSize={8}
        >
          ✂
        </text>
      ) : null}

      {kind === "isolated-selection" ? (
        <circle cx={edge.x1} cy={edge.y1} r={1.4} fill={color} opacity={0.55} />
      ) : null}

      {/* An arrival mark only where a fork actually inherited something. On the
          spine the direction is not in question, and an isolated edge
          deliberately gets none: nothing arrived. */}
      {!isSpine && kind !== "isolated-selection" ? (
        <path
          d={`M ${x2 - 2.6} ${y2 - 3.4} L ${x2} ${y2} L ${x2 + 2.6} ${y2 - 3.4}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth(kind)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </g>
  );
}

function strokeWidth(kind: BranchKind): number {
  switch (kind) {
    case "concept-lens":
      return 1.7;
    case "structural-crop":
      return 1.5;
    case "isolated-selection":
      return 1.4;
    case "regenerate":
      return 0.9;
    default:
      return 1.3;
  }
}

function dashArray(kind: BranchKind): string | undefined {
  switch (kind) {
    case "structural-crop":
      return "5 3";
    case "isolated-selection":
      return "1.5 3.5";
    case "regenerate":
      return "3 2";
    default:
      return undefined;
  }
}

export function EdgeLegend({ onClose }: { onClose: () => void }) {
  const kinds: BranchKind[] = [
    "continuation",
    "quote-reply",
    "concept-lens",
    "structural-crop",
    "isolated-selection",
    "regenerate",
  ];
  return (
    <div className="treelegend">
      <div className="treelegend__head">
        <span>Edge types</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="treelegend__note">
        Continuation and quote stay on the trunk — they are the thread carrying
        on. The other three leave it as branches, and branch again off each
        other.
      </p>
      {kinds.map((kind) => (
        <div className="treelegend__row" key={kind}>
          <svg width={38} height={12} aria-hidden>
            {kind === "quote-reply" ? (
              <>
                <line x1={2} y1={5} x2={36} y2={5} stroke={edgeColor(kind)} strokeWidth={0.75} />
                <line x1={2} y1={7.8} x2={36} y2={7.8} stroke={edgeColor(kind)} strokeWidth={0.75} />
              </>
            ) : (
              <line
                x1={kind === "isolated-selection" ? 12 : 2}
                y1={6}
                x2={36}
                y2={6}
                stroke={edgeColor(kind)}
                strokeWidth={strokeWidth(kind)}
                strokeDasharray={dashArray(kind)}
                strokeLinecap={kind === "isolated-selection" ? "round" : "butt"}
              />
            )}
            {kind === "isolated-selection" ? (
              <circle cx={3} cy={6} r={1.6} fill={edgeColor(kind)} opacity={0.55} />
            ) : null}
            {kind === "structural-crop" ? (
              <text x={0} y={9} fontSize={8} fill={edgeColor(kind)}>
                ✂
              </text>
            ) : null}
          </svg>
          <span className="treelegend__label">{BRANCH_META[kind].label}</span>
          <span className="treelegend__blurb">{BRANCH_META[kind].blurb}</span>
        </div>
      ))}
    </div>
  );
}
