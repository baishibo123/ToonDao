/**
 * The viewport, as a number you can safely do arithmetic with.
 *
 * A hidden or backgrounded tab reports `innerWidth`/`innerHeight` as 0. Anything
 * that places or clamps a floating window against those values silently pins it
 * to a corner at its minimum size and leaves it there, because the geometry is
 * then stored. Treating a non-positive reading as "not measurable yet" and
 * falling back to a plausible desktop is the difference between a window that
 * comes back wrong after a background reload and one that does not.
 */

const FALLBACK = { width: 1440, height: 900 };

export function viewportSize(): { width: number; height: number } {
  if (typeof window === "undefined") return FALLBACK;
  return {
    width: window.innerWidth > 0 ? window.innerWidth : FALLBACK.width,
    height: window.innerHeight > 0 ? window.innerHeight : FALLBACK.height,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
