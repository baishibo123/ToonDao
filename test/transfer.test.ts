import { describe, expect, it } from "vitest";
import {
  BUNDLE_VERSION,
  ImportError,
  buildBundle,
  parseBundle,
} from "@/lib/transfer";
import { assembleContext } from "@/lib/assembleContext";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { DEFAULT_SETTINGS } from "@/db/db";
import { TreeFixture } from "./helpers";
import type { Conversation, ConversationNode, NodeStore } from "@/types";

const T = DEFAULT_TEMPLATES;

function storeOf(nodes: ConversationNode[]): NodeStore {
  const map = new Map(nodes.map((n) => [n.id, n]));
  return { get: (id) => map.get(id) };
}

/** A tree with all five policies and four branches off one node. */
function richFixture() {
  const t = new TreeFixture();
  t.linear(6);
  const src = t.all().at(-1)!;

  const quote = t.add(
    "user", "why?", src.id,
    { kind: "quoted", quote: "that step", base: "full-ancestry" }, "quote-reply",
  );
  t.add("assistant", "because", quote.id);

  const lens = t.add(
    "user", "monotonicity", src.id,
    { kind: "windowed", turns: 2, upToNodeId: src.id }, "concept-lens",
  );
  lens.origin!.anchor = { start: 3, end: 9, text: "answer", blockPath: "0" };
  t.add("assistant", "about monotonicity", lens.id);

  const crop = t.add(
    "user", "", src.id,
    { kind: "truncated", upToNodeId: src.id, charOffset: 6 }, "structural-crop",
  );
  crop.origin!.anchor = { start: 6, end: 6, text: "", blockPath: "0" };
  t.add("assistant", "picking up", crop.id);

  const iso = t.add(
    "user", "", src.id,
    { kind: "isolated", payload: "a sentence" }, "isolated-selection",
  );
  iso.origin!.anchor = { start: 0, end: 10, text: "answer tur", blockPath: "0" };
  const isoReply = t.add("assistant", "about it", iso.id);
  t.add("user", "and then?", isoReply.id);

  // A retry sibling.
  t.add("assistant", "second attempt", quote.id, { kind: "full-ancestry" }, "regenerate");

  const conversation: Conversation = {
    id: t.conversationId,
    title: "Rich tree",
    createdAt: 1,
    updatedAt: 2,
    rootId: t.all()[0].id,
    activeNodeId: t.all().at(-1)!.id,
  };
  return { t, conversation, nodes: t.all() };
}

describe("ACCEPTANCE 6: nothing is ever lost", () => {
  it("round-trips four branches off one node with identical payloads", () => {
    const { t, conversation, nodes } = richFixture();
    const src = t.all()[11];
    expect(src.childrenIds).toHaveLength(4);

    const bundle = buildBundle({
      conversations: [conversation],
      nodes,
      templates: T,
      settings: DEFAULT_SETTINGS,
    });
    const parsed = parseBundle(JSON.stringify(bundle));

    expect(parsed.remapped).toBe(false);
    expect(parsed.nodes).toHaveLength(nodes.length);
    expect(parsed.conversations).toHaveLength(1);

    // All four branches present, with their origin kinds and anchors intact.
    const reimportedSrc = parsed.nodes.find((n) => n.id === src.id)!;
    expect(reimportedSrc.childrenIds).toEqual(src.childrenIds);

    const after = storeOf(parsed.nodes);
    for (const before of nodes) {
      const node = parsed.nodes.find((n) => n.id === before.id)!;
      expect(node.origin).toEqual(before.origin);
      expect(node.contextPolicy).toEqual(before.contextPolicy);
      expect(node.content).toBe(before.content);
      expect(node.parentId).toBe(before.parentId);
      // The payload is the real test: both graphs have to survive for this to
      // come out the same.
      expect(assembleContext(node, after, T)).toEqual(
        assembleContext(before, t, T),
      );
    }
  });

  it("survives a second round trip byte for byte", () => {
    const { conversation, nodes } = richFixture();
    const first = buildBundle({
      conversations: [conversation],
      nodes,
      templates: T,
      settings: DEFAULT_SETTINGS,
    });
    const parsed = parseBundle(JSON.stringify(first));
    const second = buildBundle({
      conversations: parsed.conversations,
      nodes: parsed.nodes,
      templates: T,
      settings: DEFAULT_SETTINGS,
    });
    expect(JSON.stringify(second.nodes)).toBe(JSON.stringify(first.nodes));
  });

  it("preserves exact anchor offsets, including a zero-length crop anchor", () => {
    const { conversation, nodes } = richFixture();
    const parsed = parseBundle(
      JSON.stringify(
        buildBundle({ conversations: [conversation], nodes, templates: T, settings: DEFAULT_SETTINGS }),
      ),
    );
    const crop = parsed.nodes.find((n) => n.origin?.kind === "structural-crop")!;
    expect(crop.origin!.anchor).toEqual({ start: 6, end: 6, text: "", blockPath: "0" });
    const lens = parsed.nodes.find((n) => n.origin?.kind === "concept-lens")!;
    expect(lens.origin!.anchor).toEqual({ start: 3, end: 9, text: "answer", blockPath: "0" });
  });
});

describe("secrets", () => {
  it("never writes an API key into an export", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, apiKey: "sk-secret-123" })),
    };
    const bundle = buildBundle({
      conversations: [],
      nodes: [],
      templates: T,
      settings,
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("sk-secret-123");
    expect(text).not.toContain("apiKey");
    // Base URLs and model names do come along, so an import is one paste away.
    expect(text).toContain("https://api.openai.com/v1");
  });
});

describe("id collisions", () => {
  it("remaps every id together when any of them collides", () => {
    const { conversation, nodes } = richFixture();
    const raw = JSON.stringify(
      buildBundle({ conversations: [conversation], nodes, templates: T, settings: DEFAULT_SETTINGS }),
    );
    const parsed = parseBundle(raw, {
      conversations: new Set([conversation.id]),
      nodes: new Set(nodes.map((n) => n.id)),
    });

    expect(parsed.remapped).toBe(true);
    // Not one original id survives...
    const originals = new Set(nodes.map((n) => n.id));
    expect(parsed.nodes.every((n) => !originals.has(n.id))).toBe(true);
    // ...and yet the shape is identical.
    expect(parsed.nodes).toHaveLength(nodes.length);
    const store = storeOf(parsed.nodes);
    for (const node of parsed.nodes) {
      if (node.parentId) expect(store.get(node.parentId)).toBeDefined();
      for (const child of node.childrenIds) {
        expect(store.get(child)!.parentId).toBe(node.id);
      }
    }
    // Payload shapes survive the rename.
    const before = storeOf(nodes);
    const pairs = nodes.map((n, i) => [n, parsed.nodes[i]] as const);
    for (const [original, imported] of pairs) {
      expect(assembleContext(imported, store, T).map((m) => m.content)).toEqual(
        assembleContext(original, before, T).map((m) => m.content),
      );
    }
  });

  it("remaps policy and origin references too, not just parent pointers", () => {
    const { conversation, nodes } = richFixture();
    const raw = JSON.stringify(
      buildBundle({ conversations: [conversation], nodes, templates: T, settings: DEFAULT_SETTINGS }),
    );
    const parsed = parseBundle(raw, {
      conversations: new Set([conversation.id]),
      nodes: new Set(nodes.map((n) => n.id)),
    });
    const ids = new Set(parsed.nodes.map((n) => n.id));
    for (const node of parsed.nodes) {
      if (node.origin) expect(ids.has(node.origin.sourceNodeId)).toBe(true);
      const policy = node.contextPolicy;
      if (policy.kind === "windowed" || policy.kind === "truncated") {
        expect(ids.has(policy.upToNodeId)).toBe(true);
      }
    }
  });

  it("keeps the original ids when nothing collides", () => {
    const { conversation, nodes } = richFixture();
    const raw = JSON.stringify(
      buildBundle({ conversations: [conversation], nodes, templates: T, settings: DEFAULT_SETTINGS }),
    );
    const parsed = parseBundle(raw, {
      conversations: new Set(["some-other-conversation"]),
      nodes: new Set(["some-other-node"]),
    });
    expect(parsed.remapped).toBe(false);
    expect(parsed.nodes[0].id).toBe(nodes[0].id);
  });
});

describe("the Later list", () => {
  function parked() {
    const { conversation, nodes, t } = richFixture();
    const source = t.all()[3]; // an assistant reply on the trunk
    const withLater: Conversation = {
      ...conversation,
      later: [
        {
          id: "l1",
          sourceNodeId: source.id,
          anchor: { start: 0, end: 6, text: "answer", blockPath: "0" },
          createdAt: 5,
        },
        {
          id: "l2",
          sourceNodeId: "gone",
          anchor: { start: 0, end: 1, text: "x" },
          createdAt: 6,
        },
      ],
    };
    return { withLater, nodes, source };
  }

  it("survives a round trip, and drops a passage whose message is not in it", () => {
    const { withLater, nodes, source } = parked();
    const raw = JSON.stringify(
      buildBundle({ conversations: [withLater], nodes, templates: T, settings: DEFAULT_SETTINGS }),
    );
    const [conversation] = parseBundle(raw).conversations;
    expect(conversation.later).toEqual([
      {
        id: "l1",
        sourceNodeId: source.id,
        anchor: { start: 0, end: 6, text: "answer", blockPath: "0" },
        createdAt: 5,
      },
    ]);
  });

  it("follows its message through an id remap", () => {
    const { withLater, nodes, source } = parked();
    const raw = JSON.stringify(
      buildBundle({ conversations: [withLater], nodes, templates: T, settings: DEFAULT_SETTINGS }),
    );
    const parsed = parseBundle(raw, {
      conversations: new Set([withLater.id]),
      nodes: new Set(nodes.map((n) => n.id)),
    });
    const index = nodes.findIndex((n) => n.id === source.id);
    const [conversation] = parsed.conversations;
    expect(conversation.later?.map((i) => i.sourceNodeId)).toEqual([parsed.nodes[index].id]);
  });

  it("is simply absent on a conversation that never parked anything", () => {
    const { conversation, nodes } = richFixture();
    const raw = JSON.stringify(
      buildBundle({ conversations: [conversation], nodes, templates: T, settings: DEFAULT_SETTINGS }),
    );
    expect(parseBundle(raw).conversations[0]).not.toHaveProperty("later");
  });
});

describe("hostile and damaged input", () => {
  it("rejects non-JSON", () => {
    expect(() => parseBundle("not json")).toThrow(ImportError);
  });

  it("rejects a file that is not a ToonDao export", () => {
    expect(() => parseBundle('{"hello":"world"}')).toThrow(/not a ToonDao export/);
  });

  it("rejects a future format version", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({ format: "toondao.export", version: BUNDLE_VERSION + 5, nodes: [] }),
      ),
    ).toThrow(/this build reads up to/);
  });

  it("rejects an empty export", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({ format: "toondao.export", version: 1, conversations: [], nodes: [] }),
      ),
    ).toThrow(/no conversations/);
  });

  it("drops a dangling parentId rather than importing a broken tree", () => {
    const parsed = parseBundle(
      JSON.stringify({
        format: "toondao.export",
        version: 1,
        conversations: [],
        nodes: [
          { id: "a", conversationId: "c", parentId: "ghost", role: "user", content: "hi", childrenIds: [] },
        ],
      }),
    );
    expect(parsed.nodes[0].parentId).toBeNull();
  });

  it("rebuilds childrenIds a hand-edited file left out", () => {
    const parsed = parseBundle(
      JSON.stringify({
        format: "toondao.export",
        version: 1,
        conversations: [],
        nodes: [
          { id: "a", conversationId: "c", parentId: null, role: "user", content: "q", childrenIds: [] },
          { id: "b", conversationId: "c", parentId: "a", role: "assistant", content: "a", childrenIds: [] },
        ],
      }),
    );
    expect(parsed.nodes.find((n) => n.id === "a")!.childrenIds).toEqual(["b"]);
  });

  it("invents a conversation for orphaned nodes rather than losing the tree", () => {
    const parsed = parseBundle(
      JSON.stringify({
        format: "toondao.export",
        version: 1,
        conversations: [],
        nodes: [
          { id: "a", conversationId: "lost", parentId: null, role: "user", content: "q", childrenIds: [] },
        ],
      }),
    );
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0].id).toBe("lost");
    expect(parsed.conversations[0].rootId).toBe("a");
  });

  it("brings a node caught mid-stream back as its complete partial answer", () => {
    const parsed = parseBundle(
      JSON.stringify({
        format: "toondao.export",
        version: 1,
        conversations: [],
        nodes: [
          { id: "a", conversationId: "c", parentId: null, role: "user", content: "q", childrenIds: [] },
          { id: "b", conversationId: "c", parentId: "a", role: "assistant", content: "half an ans", childrenIds: [], status: "streaming" },
        ],
      }),
    );
    const node = parsed.nodes.find((n) => n.id === "b")!;
    expect(node.status).toBe("complete");
    expect(node.content).toBe("half an ans");
  });

  it("falls back to full-ancestry for an unrecognised policy", () => {
    const parsed = parseBundle(
      JSON.stringify({
        format: "toondao.export",
        version: 1,
        conversations: [],
        nodes: [
          {
            id: "a", conversationId: "c", parentId: null, role: "user", content: "q",
            childrenIds: [], contextPolicy: { kind: "invented-by-a-future-version" },
          },
        ],
      }),
    );
    expect(parsed.nodes[0].contextPolicy).toEqual({ kind: "full-ancestry" });
  });

  it("refuses a node with no content string", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({
          format: "toondao.export",
          version: 1,
          conversations: [],
          nodes: [{ id: "a", conversationId: "c", role: "user" }],
        }),
      ),
    ).toThrow(/no content string/);
  });

  it("imports only the templates it recognises", () => {
    const parsed = parseBundle(
      JSON.stringify({
        format: "toondao.export",
        version: 1,
        conversations: [],
        nodes: [{ id: "a", conversationId: "c", parentId: null, role: "user", content: "q", childrenIds: [] }],
        templates: [
          { id: "concept_lens", body: "custom" },
          { id: "made_up", body: "ignored" },
        ],
      }),
    );
    expect(parsed.templates).toEqual({ concept_lens: "custom" });
  });
});
