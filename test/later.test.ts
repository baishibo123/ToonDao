/**
 * The Later list. The claims worth pinning down are the ones that keep it a
 * queue rather than a pile: parking the same passage twice does not double it,
 * asking about a passage finds exactly that passage, and deleting a message
 * takes its parked passages with it.
 */
import { describe, expect, it } from "vitest";
import { findParked, parkPassage, pruneParked } from "@/lib/later";
import type { LaterItem } from "@/types";

function item(id: string, sourceNodeId: string, start: number, end: number): LaterItem {
  return {
    id,
    sourceNodeId,
    anchor: { start, end, text: "x".repeat(end - start) },
    createdAt: Number(id.replace(/\D/g, "")) || 0,
  };
}

describe("the Later list", () => {
  it("parks a passage at the end, oldest first", () => {
    const one = parkPassage([], item("l1", "n1", 0, 4));
    const two = parkPassage(one, item("l2", "n3", 10, 20));
    expect(two.map((i) => i.id)).toEqual(["l1", "l2"]);
  });

  it("does not park the same passage twice", () => {
    const once = parkPassage([], item("l1", "n1", 0, 4));
    const twice = parkPassage(once, item("l2", "n1", 0, 4));
    expect(twice.map((i) => i.id)).toEqual(["l1"]);
  });

  it("treats an overlapping but different range as a different passage", () => {
    const items = parkPassage(parkPassage([], item("l1", "n1", 0, 4)), item("l2", "n1", 0, 5));
    expect(items).toHaveLength(2);
  });

  it("finds exactly the passage asked about, in exactly that message", () => {
    const items = [item("l1", "n1", 0, 4), item("l2", "n2", 0, 4)];
    expect(findParked(items, "n2", { start: 0, end: 4 })?.id).toBe("l2");
    expect(findParked(items, "n2", { start: 0, end: 3 })).toBeUndefined();
    expect(findParked(items, "n9", { start: 0, end: 4 })).toBeUndefined();
  });

  it("drops the passages of deleted messages and keeps the rest", () => {
    const items = [item("l1", "n1", 0, 4), item("l2", "n2", 0, 4), item("l3", "n3", 1, 2)];
    expect(pruneParked(items, new Set(["n2", "n3"])).map((i) => i.id)).toEqual(["l1"]);
  });

  it("never mutates the list it is given", () => {
    const items = Object.freeze([item("l1", "n1", 0, 4)]);
    expect(() => parkPassage(items, item("l2", "n2", 0, 1))).not.toThrow();
    expect(items).toHaveLength(1);
  });
});
