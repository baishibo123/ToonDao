import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ConversationNode } from "@/types";
import { cropBoundaries, type CropBoundary } from "@/lib/anchor";
import { useUI } from "@/store/useUI";
import { useStartGesture } from "@/hooks/useStartGesture";

/**
 * §5.2 — structural crop. The flagship: nothing on the market does this.
 *
 * A rail down the left gutter of an assistant message. Hovering it shows a cut
 * line that snaps to block boundaries; the remainder of the message dims to
 * ~30% as a live preview of what is being thrown away. Clicking docks the crop
 * into the composer.
 *
 * Block boundaries rather than arbitrary offsets, because cutting a response
 * mid-sentence produces a malformed prompt, and blocks are the natural unit of
 * "I stopped following here".
 *
 * Positions are measured from the rendered DOM using the `data-src-end`
 * attributes the markdown renderer emits, so a cut line is always drawn at the
 * bottom edge of the block it actually keeps — no guessing from line heights.
 */

interface CropRailProps {
  node: ConversationNode;
  contentRef: React.RefObject<HTMLDivElement | null>;
}

interface PlacedCut extends CropBoundary {
  y: number;
}

export function CropRail({ node, contentRef }: CropRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [cuts, setCuts] = useState<PlacedCut[]>([]);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const setCropHover = useUI((s) => s.setCropHover);
  const startGesture = useStartGesture();
  // A crop now lands in a window, so "this crop is docked somewhere" is a
  // question about the open windows rather than about the composer.
  const pendingIsThisCrop = useUI((s) =>
    s.windows.some(
      (w) => w.pending?.kind === "crop" && w.pending.sourceNodeId === node.id,
    ),
  );

  const boundaries = useMemo(() => cropBoundaries(node.content), [node.content]);

  const measure = useCallback(() => {
    const root = contentRef.current;
    const rail = railRef.current;
    if (!root || !rail || boundaries.length === 0) {
      setCuts([]);
      return;
    }
    // Measured against the *rail*, not the content: the rail spans the whole
    // message row including the role header, and it is the positioned ancestor
    // the cut line is offset from. Using the content's top instead puts every
    // cut line a header's height above the boundary it claims to be at.
    const railTop = rail.getBoundingClientRect().top;
    const placed: PlacedCut[] = [];
    for (const boundary of boundaries) {
      const el = root.querySelector(`[data-src-end="${boundary.charOffset}"]`);
      if (!el) continue;
      placed.push({
        ...boundary,
        y: el.getBoundingClientRect().bottom - railTop,
      });
    }
    setCuts(placed);
  }, [boundaries, contentRef]);

  useLayoutEffect(measure, [measure]);

  // Reflow on width changes and on font load, both of which move every block.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [measure, contentRef]);

  // Leaving the rail must clear the dimming, including when the pointer leaves
  // via a route that fires no mouseleave (scroll, re-render).
  useEffect(() => {
    return () => setCropHover(null);
  }, [setCropHover]);

  const nearest = (clientY: number): number | null => {
    const rail = railRef.current;
    if (!rail || cuts.length === 0) return null;
    const y = clientY - rail.getBoundingClientRect().top;
    let best = 0;
    let bestDistance = Infinity;
    cuts.forEach((cut, i) => {
      const distance = Math.abs(cut.y - y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    return best;
  };

  /**
   * The rail renders whether or not it has cut points, because its own element
   * is one of the things `measure()` needs: returning null until there were
   * cuts meant `railRef` never mounted, so the measurement that produces the
   * cuts could never run and the rail never appeared at all. What is
   * conditional is the marks on it.
   */
  const active = hoverIndex !== null ? cuts[hoverIndex] : null;
  const hasCuts = cuts.length > 0;

  return (
    <div
      ref={railRef}
      className={`croprail${active ? " croprail--active" : ""}${
        pendingIsThisCrop ? " croprail--pending" : ""
      }${hasCuts ? "" : " croprail--empty"}`}
      onMouseMove={(e) => {
        const index = nearest(e.clientY);
        if (index === null || index === hoverIndex) return;
        setHoverIndex(index);
        setCropHover({ nodeId: node.id, charOffset: cuts[index].charOffset });
      }}
      onMouseLeave={() => {
        setHoverIndex(null);
        setCropHover(null);
      }}
      onClick={(e) => {
        if (hoverIndex === null) return;
        const cut = cuts[hoverIndex];
        // The rail is a thin gutter, so the cut line itself is the rect the
        // window should appear beside.
        const rail = e.currentTarget.getBoundingClientRect();
        startGesture(
          {
            kind: "crop",
            sourceNodeId: node.id,
            charOffset: cut.charOffset,
            blockPath: cut.blockPath,
            discardedChars: node.content.length - cut.charOffset,
          },
          {
            near: {
              top: rail.top + cut.y,
              bottom: rail.top + cut.y,
              left: rail.left,
              right: rail.right,
            },
          },
        );
        setCropHover(null);
        setHoverIndex(null);
      }}
      aria-hidden
    >
      {hasCuts ? <span className="croprail__spine" /> : null}

      {cuts.map((cut, i) => (
        <span
          key={cut.charOffset}
          className={`croprail__tick${i === hoverIndex ? " croprail__tick--on" : ""}`}
          style={{ top: cut.y }}
        />
      ))}

      {active ? (
        <>
          <span className="croprail__line" style={{ top: active.y }}>
            <span className="croprail__scissor" aria-hidden>
              ✂
            </span>
            <span className="croprail__label">
              Branch from here, ignoring everything below
              <em>
                {node.content.length - active.charOffset} chars withheld · next:{" "}
                {active.nextPreview || "end of message"}
              </em>
            </span>
          </span>
        </>
      ) : null}

      {/* Keyboard route to the same gesture, since the rail is pointer-driven. */}
      {hasCuts ? (
      <button
        type="button"
        className="croprail__kb"
        aria-label={`Crop this answer — ${cuts.length} cut points`}
        onClick={(e) => {
          e.stopPropagation();
          const cut = cuts[Math.max(0, Math.floor(cuts.length / 2))];
          startGesture({
            kind: "crop",
            sourceNodeId: node.id,
            charOffset: cut.charOffset,
            blockPath: cut.blockPath,
            discardedChars: node.content.length - cut.charOffset,
          });
        }}
      >
        ✂
      </button>
      ) : null}
    </div>
  );
}
