/**
 * Where each pane sits (P-49). The open asides are a chain from the thread
 * outwards; the innermost is on the right, and the one it was opened from is in
 * the centre, so a branch that has grown into its own line of thought is read
 * in the wide column the moment you branch from it. Pure, so the rule is tested
 * without a DOM.
 */

export type PanePlace = "center" | "side" | "hidden";

/** Where the aside at `index` of a chain of `count` sits. */
export function placeOf(index: number, count: number): PanePlace {
  if (index === count - 1) return "side";
  if (index === count - 2) return "center";
  return "hidden";
}

/** The thread holds the centre until an aside is opened from an aside. */
export function threadPlace(count: number): Exclude<PanePlace, "side"> {
  return count <= 1 ? "center" : "hidden";
}

/**
 * The divider's limits, in CSS pixels: a side pane narrower than this cannot
 * hold a code block or a drawing, and a centre narrower than this cannot hold
 * a paragraph.
 */
export const PANE_LIMITS = { sideMin: 320, centerMin: 420 } as const;

/** The side pane's share of the canvas for a width, kept inside the limits. */
export function clampShare(sideWidth: number, canvasWidth: number): number {
  if (canvasWidth <= 0) return 0.5;
  const min = PANE_LIMITS.sideMin / canvasWidth;
  const max = Math.max(min, (canvasWidth - PANE_LIMITS.centerMin) / canvasWidth);
  return Math.min(max, Math.max(min, sideWidth / canvasWidth));
}

/**
 * The side pane's flex-basis for a stored share. The same limits hold again in
 * CSS, so a window made narrower after the drag still keeps both panes readable.
 */
export function asideBasis(share: number): string {
  const pct = Math.round(share * 10000) / 100;
  return `clamp(${PANE_LIMITS.sideMin}px, ${pct}%, calc(100% - ${PANE_LIMITS.centerMin}px))`;
}
