/**
 * Where panes sit, and how far the divider moves (P-49).
 */
import { describe, expect, it } from "vitest";
import { asideBasis, clampShare, PANE_LIMITS, placeOf, threadPlace } from "@/lib/panes";

describe("placement", () => {
  it("keeps the thread in the centre while one aside is open", () => {
    expect(threadPlace(0)).toBe("center");
    expect(threadPlace(1)).toBe("center");
    expect(placeOf(0, 1)).toBe("side");
  });

  it("moves the aside a new one was opened from into the centre", () => {
    expect(threadPlace(2)).toBe("hidden");
    expect([0, 1].map((i) => placeOf(i, 2))).toEqual(["center", "side"]);
    expect([0, 1, 2].map((i) => placeOf(i, 3))).toEqual(["hidden", "center", "side"]);
  });

  it("gives every chain exactly one centre and one side", () => {
    for (let n = 1; n <= 6; n++) {
      const places = Array.from({ length: n }, (_, i) => placeOf(i, n));
      if (threadPlace(n) === "center") places.push("center");
      expect(places.filter((p) => p === "center")).toHaveLength(1);
      expect(places.filter((p) => p === "side")).toHaveLength(1);
    }
  });
});

describe("the divider", () => {
  it("keeps both panes readable", () => {
    const canvas = 1400;
    expect(clampShare(100, canvas) * canvas).toBeCloseTo(PANE_LIMITS.sideMin);
    expect(clampShare(1300, canvas) * canvas).toBeCloseTo(canvas - PANE_LIMITS.centerMin);
    expect(clampShare(700, canvas)).toBeCloseTo(0.5);
  });

  it("favours the side pane's minimum when the canvas cannot hold both", () => {
    expect(clampShare(500, 600) * 600).toBeCloseTo(PANE_LIMITS.sideMin);
  });

  it("states the same limits in CSS, for a window resized after the drag", () => {
    expect(asideBasis(0.4)).toBe("clamp(320px, 40%, calc(100% - 420px))");
  });
});
