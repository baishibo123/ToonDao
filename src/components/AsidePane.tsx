import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type AsideFrame } from "@/store/useUI";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { SurfaceProvider } from "@/components/Surface";
import { BRANCH_META, branchKindForGesture } from "@/lib/policyMeta";
import { pathToRoot, turnNumbers, type NodeMap } from "@/lib/tree";
import { branchLabel, spineLeaf } from "@/lib/outline";
import { asideBasis, clampShare, placeOf, type PanePlace } from "@/lib/panes";
import { focusNode } from "@/store/focusNode";
import type { BranchKind } from "@/types";

/**
 * The side conversations: the innermost on the right, beside the line it left.
 *
 * A lens, a crop or an isolation is a second thing you are doing while the first
 * is unfinished. It opens on the right, beside the passage it came from, so the
 * passage stays readable while you read the answer to it — a margin never covers
 * the text. A question raised inside an aside opens a deeper one on the right,
 * and the aside it was asked in moves to the centre (P-49): the line you are
 * branching from is the one worth the wide column.
 *
 * Every frame is a sibling of the thread in `.main` and stays mounted; moving
 * between the centre and the right is a class change, so a half-typed follow-up
 * and a scroll position survive the move and a trip down the breadcrumb.
 */
export function AsidePane() {
  const conversationId = useStore((s) => s.conversationId);
  const asides = useUI((s) => s.asides);
  const closeAsides = useUI((s) => s.closeAsides);
  const wide = useUI((s) => s.wideAsideId !== null && s.wideAsideId === s.asides.at(-1)?.id);

  // Switching conversations empties the node map, so an aside from the other
  // one would have nothing to show.
  const stale = asides.some((f) => f.conversationId !== conversationId);
  useEffect(() => {
    if (stale) closeAsides();
  }, [stale, closeAsides]);

  if (asides.length === 0 || stale) return null;

  return (
    <>
      {asides.map((frame, i) => {
        const place = placeOf(i, asides.length);
        return (
          <div key={frame.id} className={`asideslot asideslot--${place}`} hidden={place === "hidden"}>
            <AsideView frame={frame} trail={asides.slice(0, i)} place={place} />
          </div>
        );
      })}
      {wide ? null : <Divider />}
    </>
  );
}

function AsideView({
  frame,
  trail,
  place,
}: {
  frame: AsideFrame;
  /** The frames above this one, outermost first. */
  trail: AsideFrame[];
  place: PanePlace;
}) {
  const ref = useRef<HTMLElement>(null);
  const nodes = useStore((s) => s.nodes);
  const closeAsides = useUI((s) => s.closeAsides);
  const popAsidesTo = useUI((s) => s.popAsidesTo);
  const toggleWide = useUI((s) => s.toggleWide);
  const wide = useUI((s) => s.wideAsideId === frame.id) && place === "side";

  const surface = useMemo(() => ({ asideId: frame.id }), [frame.id]);
  const about = useMemo(() => describeFrame(frame, nodes), [frame, nodes]);
  const root = frame.rootNodeId ? nodes[frame.rootNodeId] : undefined;
  const leaf =
    frame.activeNodeId && nodes[frame.activeNodeId] ? frame.activeNodeId : frame.rootNodeId;

  // An aside takes the keyboard when it arrives on the right, because the next
  // act is to type into it. Focus lands on the section so a screen reader
  // announces what opened; the composer takes it from there.
  useEffect(() => {
    if (place === "side") ref.current?.focus({ preventScroll: true });
  }, [place]);

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

  /** ✕ backs out one level: the reverse of opening, so the centre slides back. */
  const close = () => (parent ? popAsidesTo(parent.id) : closeAsides());

  return (
    <section
      ref={ref}
      className="aside"
      data-aside-id={frame.id}
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
          onClick={() => showSource(frame, parent, place)}
          title="Show the passage this came from"
          aria-label="Show the passage this came from"
        >
          ↖
        </button>
        {place === "side" ? (
          <>
            <button
              type="button"
              className="aside__btn"
              onClick={() => toggleWide(frame.id)}
              aria-pressed={wide}
              title={wide ? "Back beside the conversation (Esc)" : "Fill the canvas"}
              aria-label={wide ? "Back beside the conversation" : "Fill the canvas"}
            >
              {wide ? "⤡" : "⤢"}
            </button>
            <button
              type="button"
              className="aside__btn"
              onClick={close}
              title={parent ? "Close, back one level (Esc)" : "Close (Esc)"}
              aria-label="Close"
            >
              ✕
            </button>
          </>
        ) : null}
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

/**
 * ↖ on the right: the passage is in the pane beside it — the centre aside, or
 * the thread — so it is scrolled to there, moving that aside's leaf onto it if
 * it is on another variant, without folding the chain the way `focusNode()`
 * would. From the centre the passage is off screen, so the router decides.
 */
function showSource(frame: AsideFrame, parent: AsideFrame | undefined, place: PanePlace): void {
  if (place !== "side" || !parent) return void focusNode(frame.sourceNodeId);
  const { nodes, preferredChild } = useStore.getState();
  const { setAsideActive, requestScrollTo } = useUI.getState();
  const shown = parent.activeNodeId ? pathToRoot(nodes, parent.activeNodeId) : [];
  if (!shown.some((n) => n.id === frame.sourceNodeId)) {
    setAsideActive(parent.id, spineLeaf(nodes, frame.sourceNodeId, preferredChild));
  }
  requestScrollTo(frame.sourceNodeId);
}

/**
 * The line between the centre and the right. Dragging it sets the side pane's
 * share of the canvas, inside `PANE_LIMITS` on both sides; the arrow keys move
 * it too, and a double click puts it back. The share is a setting, so it holds
 * across reloads, and it is written once, when the drag ends.
 */
function Divider() {
  const updateSettings = useStore((s) => s.updateSettings);
  const share = useStore((s) => s.settings.asideShare);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; share: number | null } | null>(null);

  const measure = (el: Element) => {
    const main = el.closest(".main");
    const side = main?.querySelector(".asideslot--side");
    return main && side ? { main: main as HTMLElement, canvas: main.clientWidth, side: side.getBoundingClientRect().width } : null;
  };
  const apply = (main: HTMLElement, next: number) => main.style.setProperty("--aside-basis", asideBasis(next));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const m = measure(e.currentTarget);
    if (!m) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: m.side, share: null };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const m = d && measure(e.currentTarget);
    if (!d || !m) return;
    // The side pane is on the right, so moving left widens it.
    d.share = clampShare(d.startWidth + (d.startX - e.clientX), m.canvas);
    apply(m.main, d.share);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d?.share != null) void updateSettings({ asideShare: d.share });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? 1 : e.key === "ArrowRight" ? -1 : 0;
    if (!step) return;
    const m = measure(e.currentTarget);
    if (!m) return;
    e.preventDefault();
    void updateSettings({ asideShare: clampShare(m.side + step * 0.03 * m.canvas, m.canvas) });
  };

  return (
    <div
      className={`panedivider${dragging ? " panedivider--dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side conversation"
      aria-valuenow={share === undefined ? undefined : Math.round(share * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => void updateSettings({ asideShare: undefined })}
      onKeyDown={onKeyDown}
    />
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
