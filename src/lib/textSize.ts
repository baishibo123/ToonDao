import type { TextSize } from "@/types";

/**
 * The text sizes Settings offers (P-38): a few steps, not a slider. Each is a
 * multiplier on every font size in the stylesheets, through `--text-scale`.
 */
export const TEXT_SIZES: ReadonlyArray<{ id: TextSize; label: string; scale: number }> = [
  { id: "small", label: "Small", scale: 0.92 },
  { id: "default", label: "Default", scale: 1 },
  { id: "large", label: "Large", scale: 1.12 },
  { id: "larger", label: "Larger", scale: 1.25 },
];

export function textScale(size: TextSize | undefined): number {
  return TEXT_SIZES.find((s) => s.id === size)?.scale ?? 1;
}
