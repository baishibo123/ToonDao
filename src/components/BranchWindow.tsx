import { useEffect, useMemo, useRef } from "react";
import { useStore } from "@/store/useStore";
import { useUI, type BranchWindowState } from "@/store/useUI";
import { Transcript } from "@/components/Transcript";
import { Composer } from "@/components/Composer";
import { SurfaceProvider } from "@/components/Surface";
import { BRANCH_META, branchKindForGesture } from "@/lib/policyMeta";
import { pathToRoot, turnNumbers } from "@/lib/tree";
import { focusNode } from "@/store/focusNode";
import { branchLabel } from "@/lib/outline";
import { clamp, viewportSize } from "@/lib/viewport";
import type { BranchKind } from "@/types";

/**
 * A branch, in front of the thread it came from (requirement 2).
 *
 * The window is a *view* over the same tree, not a container: the nodes inside
 * it are ordinary nodes with ordinary policies, and closing it destroys nothing.
 * What the window adds is simultaneity — the passage you branched off stays
 * readable behind it, and the payload the branch carries is shown in the window
 * before the first message is sent, which is the only moment at which knowing
 * what will be carried can still change what you type.
 *
 * Deliberately not a browser window. A popup would lose the shared store, the
 * shared IndexedDB connection and the tree behind it, and the browser would put
 * chrome around something that is one view of one document.
 */
export function BranchWindow({ win }: { win: BranchWindowState }) {
  const ref = useRef<HTMLDivElement>(null);
  const nodes = useStore((s) => s.nodes);

  const close = useUI((s) => s.closeBranchWindow);
  const focus = useUI((s) => s.focusBranchWindow);
  const move = useUI((s) => s.moveBranchWindow);
  const resize = useUI((s) => s.resizeBranchWindow);
  const setMinimized = useUI((s) => s.setBranchWindowMinimized);

  const surface = useMemo(() => ({ windowId: win.id }), [win.id]);
  const source = nodes[win.sourceNodeId];
  const root = win.rootNodeId ? nodes[win.rootNodeId] : undefined;

  /** Where in the conversation this branch left from. */
  const sourceTurn = useMemo(() => {
    if (!source) return null;
    const path = pathToRoot(nodes, source.id);
    return turnNumbers(path).get(source.id) ?? null;
  }, [nodes, source]);

  const kind: BranchKind = win.pending
    ? branchKindForGesture(win.pending.kind)
    : (root?.origin?.kind ?? "continuation");
  const meta = BRANCH_META[kind];

  const excerpt = useMemo(() => {
    const pending = win.pending;
    // A crop points at a cut line and a fork at a whole message, so neither has
    // a passage to quote.
    const anchor =
      pending && "anchor" in pending
        ? pending.anchor.text
        : pending
          ? ""
          : (root?.origin?.anchor?.text ?? "");
    return flatten(anchor);
  }, [win.pending, root]);

  const withheld =
    win.pending?.kind === "crop" && source
      ? source.content.length - win.pending.charOffset
      : root?.origin?.kind === "structural-crop" && source && root.origin.anchor
        ? source.content.length - root.origin.anchor.start
        : null;

  // Once the branch exists it names itself, the same way its sidebar row does.
  const title = root
    ? branchLabel(root)
    : excerpt || (withheld !== null ? "Cropped answer" : meta.label);
  const leaf =
    win.activeNodeId && nodes[win.activeNodeId] ? win.activeNodeId : win.rootNodeId;

  // A new window takes the keyboard, because the user's next act is to type
  // into it. Focus lands on the panel rather than the textarea so screen
  // readers announce what opened; the composer takes it from there.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  /**
   * The window is a view over nodes it does not own, and those nodes can be
   * deleted from under it — the delete button in its own transcript is one way,
   * deleting the source turn from the thread behind it is another. A view of
   * nothing is worse than no view, so it closes itself.
   */
  const orphaned = win.rootNodeId ? !root : !source;
  useEffect(() => {
    if (orphaned) close(win.id);
  }, [orphaned, close, win.id]);

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    // Buttons inside the title bar keep their own clicks.
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    focus(win.id);
    const originX = win.x;
    const originY = win.y;
    drag(event, (dx, dy) => {
      // The title bar has to stay grabbable, so a window can hang off the right
      // edge but never be pushed entirely past it.
      const { width: vw, height: vh } = viewportSize();
      move(
        win.id,
        clamp(originX + dx, 96 - win.width, vw - 80),
        clamp(originY + dy, 0, vh - 40),
      );
    });
  };

  const startResize = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    focus(win.id);
    const originW = win.width;
    const originH = win.height;
    drag(event, (dx, dy) => resize(win.id, originW + dx, originH + dy));
  };

  /**
   * Where this branch came from. Not "show this branch in the thread" — the
   * thread is a spine and this is a different one, so it cannot be shown there.
   * What is useful is the other direction: take me back to the passage I
   * branched off, in whichever surface owns it.
   */
  const revealSource = () => focusNode(win.sourceNodeId);

  return (
    <section
      ref={ref}
      className={`branchwin${win.minimized ? " branchwin--min" : ""}`}
      data-window-id={win.id}
      tabIndex={-1}
      role="dialog"
      aria-label={`${meta.label}: ${title}`}
      style={{
        left: win.x,
        top: win.y,
        width: win.width,
        height: win.minimized ? undefined : win.height,
        zIndex: win.z,
        // Each window carries its gesture's hue, so which branch you are typing
        // into is answerable without reading the title.
        ["--kind" as string]: `var(${meta.cssVar})`,
      }}
      onPointerDownCapture={() => focus(win.id)}
    >
      <header className="branchwin__bar" onPointerDown={startDrag}>
        <span className="branchwin__glyph" aria-hidden title={meta.blurb}>
          {meta.glyph}
        </span>
        <span className="branchwin__title" title={excerpt || meta.blurb}>
          {title}
        </span>
        <span className="branchwin__buttons">
          <button
            type="button"
            className="branchwin__btn"
            onClick={revealSource}
            title="Go to the passage this branch came from"
            aria-label="Go to the passage this branch came from"
          >
            ↖
          </button>
          <button
            type="button"
            className="branchwin__btn"
            onClick={() => setMinimized(win.id, !win.minimized)}
            title={win.minimized ? "Expand" : "Collapse"}
            aria-label={win.minimized ? "Expand" : "Collapse"}
            aria-expanded={!win.minimized}
          >
            {win.minimized ? "▢" : "—"}
          </button>
          <button
            type="button"
            className="branchwin__btn branchwin__btn--close"
            onClick={() => close(win.id)}
            title="Close this window — the branch stays in the tree"
            aria-label="Close"
          >
            ✕
          </button>
        </span>
      </header>

      {/* Kept mounted while collapsed so a half-typed message survives. */}
      <div className="branchwin__body">
        <p className="branchwin__source">
          <span className="branchwin__origin">{meta.label}</span>
          {sourceTurn ? <> off turn {sourceTurn}</> : null}
          {excerpt ? <> · “{truncate(excerpt, 120)}”</> : null}
          {withheld !== null ? <> · {withheld} characters withheld</> : null}
        </p>

        <SurfaceProvider value={surface}>
          <Transcript
            fromNodeId={win.rootNodeId}
            // A leaf can go while the branch root stays — deleting one reply of
            // a retried pair, say. Falling back to the root keeps the branch on
            // screen instead of blanking the window.
            leafId={leaf}
            empty={
              <p className="branchwin__pending">
                Nothing sent yet. The payload below is exactly what this branch
                will carry — {meta.blurb.toLowerCase()}
              </p>
            }
          />
          <div className="branchwin__composer">
            <Composer />
          </div>
        </SurfaceProvider>
      </div>

      <span
        className="branchwin__grip"
        onPointerDown={startResize}
        role="presentation"
        aria-hidden
      />
    </section>
  );
}

/**
 * Pointer drag on window listeners rather than pointer capture: capture on the
 * title bar loses the drag the moment React re-renders it, which it does on
 * every move.
 */
function drag(event: React.PointerEvent, onMove: (dx: number, dy: number) => void): void {
  const startX = event.clientX;
  const startY = event.clientY;
  const move = (e: PointerEvent) => onMove(e.clientX - startX, e.clientY - startY);
  const done = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
    document.body.classList.remove("is-dragging");
  };
  document.body.classList.add("is-dragging");
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
