import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type AsideFrame } from "@/store/useUI";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { SurfaceProvider } from "@/components/Surface";
import { BRANCH_META, branchKindForGesture } from "@/lib/policyMeta";
import { pathToRoot, turnNumbers, type NodeMap } from "@/lib/tree";
import { branchLabel } from "@/lib/outline";
import { focusNode } from "@/store/focusNode";
import type { BranchKind } from "@/types";

/**
 * The margin: side conversations, docked beside the thread.
 *
 * A lens, a crop or an isolation is a second thing you are doing while the first
 * is unfinished. It opens here, beside the passage it came from, so the passage
 * stays readable while you read the answer to it — a margin never covers the
 * text. One side conversation is shown at a time; a question raised inside one
 * opens a deeper one in its place, and the frames above it become the
 * breadcrumb home.
 *
 * Every frame stays mounted and only the innermost is shown, so a half-typed
 * follow-up survives a trip down the breadcrumb and back.
 */
export function AsidePane() {
  const conversationId = useStore((s) => s.conversationId);
  const asides = useUI((s) => s.asides);
  const closeAsides = useUI((s) => s.closeAsides);

  // Switching conversations empties the node map, so an aside from the other
  // one would have nothing to show.
  const stale = asides.some((f) => f.conversationId !== conversationId);
  useEffect(() => {
    if (stale) closeAsides();
  }, [stale, closeAsides]);

  if (asides.length === 0 || stale) return null;
  const top = asides[asides.length - 1];

  return (
    <div className="asidepane">
      {asides.map((frame, i) => (
        <AsideView
          key={frame.id}
          frame={frame}
          trail={asides.slice(0, i)}
          visible={frame.id === top.id}
        />
      ))}
    </div>
  );
}

function AsideView({
  frame,
  trail,
  visible,
}: {
  frame: AsideFrame;
  /** The frames above this one, outermost first. */
  trail: AsideFrame[];
  visible: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const nodes = useStore((s) => s.nodes);
  const closeAsides = useUI((s) => s.closeAsides);
  const popAsidesTo = useUI((s) => s.popAsidesTo);

  const surface = useMemo(() => ({ asideId: frame.id }), [frame.id]);
  const about = useMemo(() => describeFrame(frame, nodes), [frame, nodes]);
  const root = frame.rootNodeId ? nodes[frame.rootNodeId] : undefined;
  const leaf =
    frame.activeNodeId && nodes[frame.activeNodeId] ? frame.activeNodeId : frame.rootNodeId;

  // An aside takes the keyboard when it appears, because the next act is to
  // type into it. Focus lands on the section so a screen reader announces what
  // opened; the composer takes it from there.
  useEffect(() => {
    if (visible) ref.current?.focus({ preventScroll: true });
  }, [visible]);

  /**
   * A frame is a view over nodes it does not own, and they can be deleted from
   * under it — by its own delete button, or by deleting the source turn from the
   * thread. A view of nothing is worse than no view, so it backs out to the frame
   * above it.
   */
  const orphaned = frame.rootNodeId ? !root : !nodes[frame.sourceNodeId];
  const parent = trail.at(-1);
  useEffect(() => {
    if (!orphaned) return;
    if (parent) popAsidesTo(parent.id);
    else closeAsides();
  }, [orphaned, parent, popAsidesTo, closeAsides]);

  return (
    <section
      ref={ref}
      className="aside"
      data-aside-id={frame.id}
      hidden={!visible}
      tabIndex={-1}
      aria-label={`${about.meta.label}: ${about.title}`}
      // The aside carries its gesture's hue, so which kind of side conversation
      // you are in is answerable without reading the title.
      style={{ ["--kind" as string]: `var(${about.meta.cssVar})` }}
    >
      <header className="aside__head">
        <nav className="crumbs" aria-label="Back to">
          <button
            type="button"
            className="crumb"
            onClick={closeAsides}
            title="Back to the thread"
          >
            Thread
          </button>
          {trail.map((above) => (
            <span key={above.id} className="crumbs__step">
              <span className="crumbs__sep" aria-hidden>
                ›
              </span>
              <button
                type="button"
                className="crumb"
                onClick={() => popAsidesTo(above.id)}
                title={describeFrame(above, nodes).title}
              >
                {describeFrame(above, nodes).title}
              </button>
            </span>
          ))}
        </nav>
        <button
          type="button"
          className="aside__btn"
          onClick={() => focusNode(frame.sourceNodeId)}
          title="Show the passage this came from"
          aria-label="Show the passage this came from"
        >
          ↖
        </button>
        <button
          type="button"
          className="aside__btn"
          onClick={closeAsides}
          title="Close (Esc goes back one level)"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div className="aside__about">
        <h2 className="aside__title">
          <span className="aside__glyph" aria-hidden title={about.meta.blurb}>
            {about.meta.glyph}
          </span>
          {about.title}
        </h2>
        <p className="aside__source">
          {about.meta.label}
          {about.sourceTurn ? <> · from turn {about.sourceTurn}</> : null}
          {about.withheld !== null ? <> · {about.withheld} characters withheld</> : null}
        </p>
      </div>

      <SurfaceProvider value={surface}>
        <Transcript
          fromNodeId={frame.rootNodeId}
          // A leaf can go while the root stays — deleting one reply of a
          // retried pair, say. Falling back to the root keeps the aside on
          // screen instead of blanking it.
          leafId={leaf}
          empty={
            <p className="aside__pending">
              Nothing sent yet. What this will carry is shown above the box
              below — {about.meta.blurb.toLowerCase()}
            </p>
          }
        />
        <div className="aside__composer">
          <Composer />
        </div>
      </SurfaceProvider>
    </section>
  );
}

/** What one frame is about, for its header and for the breadcrumb. */
function describeFrame(frame: AsideFrame, nodes: NodeMap) {
  const source = nodes[frame.sourceNodeId];
  const root = frame.rootNodeId ? nodes[frame.rootNodeId] : undefined;
  const pending = frame.pending;

  const kind: BranchKind = pending
    ? branchKindForGesture(pending.kind)
    : (root?.origin?.kind ?? "continuation");
  const meta = BRANCH_META[kind];

  // A crop points at a cut line rather than a passage, so it has none to quote.
  const excerpt = flatten(
    pending && "anchor" in pending ? pending.anchor.text : (root?.origin?.anchor?.text ?? ""),
  );

  const cut =
    pending?.kind === "crop"
      ? pending.charOffset
      : root?.origin?.kind === "structural-crop"
        ? root.origin.anchor?.start
        : undefined;
  const withheld = cut !== undefined && source ? source.content.length - cut : null;

  // Once the aside exists it names itself, the same way its sidebar row does.
  const title = root
    ? branchLabel(root)
    : excerpt
      ? truncate(excerpt, 64)
      : withheld !== null
        ? "Lost me here"
        : meta.label;

  const sourceTurn = source
    ? (turnNumbers(pathToRoot(nodes, source.id)).get(source.id) ?? null)
    : null;

  return { kind, meta, title, excerpt, withheld, sourceTurn };
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
