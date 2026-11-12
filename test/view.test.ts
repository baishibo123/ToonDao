/**
 * A conversation's view (P-50). The claims: an empty box is not written, a view
 * reopened over a tree that lost messages keeps only what still has them (and
 * nothing opened from inside what was lost), and a reload reopens the
 * conversation that was on screen rather than the newest.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, lastOpened, restoreView, snapshotView, type ConversationView } from "@/lib/view";
import type { AsideFrame } from "@/store/useUI";
import type { Conversation, ConversationNode } from "@/types";
import type { NodeMap } from "@/lib/tree";

function nodes(...ids: string[]): NodeMap {
  const map: NodeMap = {};
  for (const id of ids) {
    map[id] = { id, conversationId: "c1", parentId: null, childrenIds: [], role: "user", content: "", createdAt: 0, status: "complete", origin: null, contextPolicy: { kind: "full-ancestry" } } as ConversationNode;
  }
  return map;
}

function frame(id: string, sourceNodeId: string, rootNodeId: string | null): AsideFrame {
  return {
    id,
    conversationId: "c1",
    sourceNodeId,
    rootNodeId,
    activeNodeId: rootNodeId,
    pending: rootNodeId ? null : { kind: "isolated", sourceNodeId, anchor: { start: 0, end: 1, text: "x" } },
  };
}

function view(over: Partial<ConversationView>): ConversationView {
  return { savedAt: 1, asides: [], wideAsideId: null, pending: null, drafts: {}, scroll: {}, ...over };
}

describe("writing a view", () => {
  it("leaves out a box with nothing in it", () => {
    const v = snapshotView(
      { asides: [], wideAsideId: null, pending: null, drafts: { __draft__: EMPTY_DRAFT, "__draft__:s1": { ...EMPTY_DRAFT, text: "half a" } } },
      {},
      5,
    );
    expect(Object.keys(v.drafts)).toEqual(["__draft__:s1"]);
    expect(v.savedAt).toBe(5);
  });
});

describe("restoring a view", () => {
  it("puts back asides, the wide one, drafts and scroll marks that still hold", () => {
    const v = view({
      asides: [frame("s1", "a", "b"), frame("s2", "b", "d")],
      wideAsideId: "s2",
      drafts: { __draft__: { ...EMPTY_DRAFT, text: "t" }, "__draft__:s2": { ...EMPTY_DRAFT, text: "u" } },
      scroll: { __draft__: { nodeId: "a", offset: 40 }, "__draft__:s2": { nodeId: "d", offset: 0 } },
    });
    const r = restoreView(v, nodes("a", "b", "d"), "c1");
    expect(r.asides.map((f) => f.id)).toEqual(["s1", "s2"]);
    expect(r.wideAsideId).toBe("s2");
    expect(Object.keys(r.drafts).sort()).toEqual(["__draft__", "__draft__:s2"]);
    expect(r.scroll.__draft__).toEqual({ nodeId: "a", offset: 40 });
  });

  it("closes an aside whose messages are gone, and every aside opened inside it", () => {
    const v = view({
      asides: [frame("s1", "a", "b"), frame("s2", "b", "gone"), frame("s3", "gone", "e")],
      wideAsideId: "s3",
      drafts: { "__draft__:s1": { ...EMPTY_DRAFT, text: "x" }, "__draft__:s3": { ...EMPTY_DRAFT, text: "y" } },
      scroll: { "__draft__:s3": { nodeId: "e", offset: 0 } },
    });
    const r = restoreView(v, nodes("a", "b", "e"), "c1");
    expect(r.asides.map((f) => f.id)).toEqual(["s1"]);
    expect(r.wideAsideId).toBeNull();
    expect(Object.keys(r.drafts)).toEqual(["__draft__:s1"]);
    expect(r.scroll).toEqual({});
  });

  it("keeps an unsent aside only while the passage it is about exists", () => {
    const v = view({ asides: [frame("s1", "a", null)] });
    expect(restoreView(v, nodes("a"), "c1").asides).toHaveLength(1);
    expect(restoreView(v, nodes("b"), "c1").asides).toHaveLength(0);
  });

  it("drops the thread's gesture about a deleted message, and a mark on one", () => {
    const v = view({
      pending: { kind: "rewind", nodeId: "q", parentId: "r" },
      scroll: { __draft__: { nodeId: "q", offset: 10 } },
    });
    expect(restoreView(v, nodes("q", "r"), "c1").pending?.kind).toBe("rewind");
    const lost = restoreView(v, nodes("r"), "c1");
    expect(lost.pending).toBeNull();
    expect(lost.scroll).toEqual({});
  });

  it("never shows another conversation's asides, and survives no view at all", () => {
    const v = view({ asides: [frame("s1", "a", "b")] });
    expect(restoreView(v, nodes("a", "b"), "c2").asides).toHaveLength(0);
    expect(restoreView(undefined, nodes("a"), "c1")).toEqual({ asides: [], wideAsideId: null, pending: null, drafts: {}, scroll: {} });
  });
});

describe("the conversation a reload opens", () => {
  const conv = (id: string, savedAt?: number): Conversation => ({
    id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    rootId: null,
    activeNodeId: null,
    ...(savedAt === undefined ? {} : { view: view({ savedAt }) }),
  });

  it("is the one on screen last, not the newest", () => {
    expect(lastOpened([conv("newest"), conv("viewed", 9), conv("older", 3)])?.id).toBe("viewed");
  });

  it("is the newest when none was ever viewed", () => {
    expect(lastOpened([conv("newest"), conv("older")])?.id).toBe("newest");
  });
});
