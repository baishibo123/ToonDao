import { describe, expect, it } from "vitest";
import {
  alignValueToSource,
  capitalizedRunAround,
  cropBoundaries,
  parseMarkdown,
  wordAt,
} from "@/lib/anchor";

describe("leaf map", () => {
  it("gives every leaf a source range that slices back to its rendered value", () => {
    const src = "Hello **world** and `code` too.";
    const { leaves } = parseMarkdown(src);
    for (const leaf of leaves) {
      const from = leaf.map[0];
      const to = leaf.map[leaf.value.length];
      expect(src.slice(from, to)).toBe(leaf.value);
    }
  });

  it("distinguishes six occurrences of the same word by position, not by search", () => {
    const src = [
      "The model is a model of a model.",
      "",
      "```python",
      "model = load_model()  # model",
      "```",
      "",
      "One more model here.",
    ].join("\n");

    const { leaves } = parseMarkdown(src);
    const occurrences: number[] = [];
    for (const leaf of leaves) {
      for (let i = 0; i <= leaf.value.length - 5; i++) {
        if (leaf.value.startsWith("model", i)) occurrences.push(leaf.map[i]);
      }
    }
    // Every occurrence resolves to a distinct, correct source offset.
    expect(occurrences.length).toBe(7);
    expect(new Set(occurrences).size).toBe(7);
    for (const off of occurrences) {
      expect(src.slice(off, off + 5)).toBe("model");
    }
    // ACCEPTANCE 5: the fifth occurrence is the one inside the code fence.
    expect(occurrences[4]).toBeGreaterThan(src.indexOf("```python"));
    expect(occurrences[4]).toBeLessThan(src.lastIndexOf("```"));
  });

  it("maps fenced code bodies past the fence marker", () => {
    const src = "text\n\n```ts\nconst x = 1;\n```\n";
    const { leaves } = parseMarkdown(src);
    const code = leaves.find((l) => l.type === "code")!;
    expect(code.value).toBe("const x = 1;");
    expect(src.slice(code.map[0], code.map[code.value.length])).toBe("const x = 1;");
    expect(src.slice(code.map[0] - 1, code.map[0])).toBe("\n");
  });

  it("maps inline code past its backticks", () => {
    const src = "use `slice(0, n)` here";
    const { leaves } = parseMarkdown(src);
    const code = leaves.find((l) => l.type === "inlineCode")!;
    expect(code.value).toBe("slice(0, n)");
    expect(src.slice(code.map[0], code.map[code.value.length])).toBe("slice(0, n)");
    expect(src[code.map[0] - 1]).toBe("`");
  });

  it("handles nested lists", () => {
    const src = [
      "- outer one",
      "  - inner a",
      "  - inner b",
      "- outer two",
    ].join("\n");
    const { leaves } = parseMarkdown(src);
    const values = leaves.map((l) => l.value);
    expect(values).toEqual(["outer one", "inner a", "inner b", "outer two"]);
    for (const leaf of leaves) {
      expect(src.slice(leaf.map[0], leaf.map[leaf.value.length])).toBe(leaf.value);
    }
  });

  it("survives escapes, where source and rendered text differ in length", () => {
    const src = String.raw`a \* b \_ c`;
    const { leaves } = parseMarkdown(src);
    for (const leaf of leaves) {
      for (let i = 0; i < leaf.value.length; i++) {
        expect(src[leaf.map[i]]).toBe(leaf.value[i]);
      }
    }
  });

  it("keeps leaf ranges non-overlapping and in document order", () => {
    const src = [
      "# Title",
      "",
      "Para with **bold** and *italic* and [a link](https://x.test).",
      "",
      "> quoted line",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");
    const { leaves } = parseMarkdown(src);
    let cursor = -1;
    for (const leaf of leaves) {
      expect(leaf.srcStart).toBeGreaterThanOrEqual(cursor);
      cursor = leaf.srcEnd;
    }
    expect(leaves.length).toBeGreaterThan(5);
  });

  it("is cached by source string identity", () => {
    const src = "same string";
    expect(parseMarkdown(src)).toBe(parseMarkdown(src));
  });
});

describe("alignValueToSource", () => {
  it("takes the fast path when the value appears verbatim", () => {
    expect(alignValueToSource("`abc`", "abc", 10)).toEqual([11, 12, 13, 14]);
  });

  it("skips dropped source characters on the slow path", () => {
    // Source has a backslash the rendered value does not.
    const map = alignValueToSource(String.raw`a\*b`, "a*b", 0);
    expect(map).toEqual([0, 2, 3, 4]);
  });

  it("pins the tail when the source runs out", () => {
    const map = alignValueToSource("ab", "abcd", 0);
    expect(map[0]).toBe(0);
    expect(map[map.length - 1]).toBe(2);
  });

  it("returns a map of length value.length + 1", () => {
    for (const [slice, value] of [["hello", "hello"], ["`x`", "x"], ["", ""]] as const) {
      expect(alignValueToSource(slice, value, 0)).toHaveLength(value.length + 1);
    }
  });
});

describe("cropBoundaries (§5.2)", () => {
  const FIVE = [
    "Paragraph one.",
    "Paragraph two.",
    "Paragraph three.",
    "Paragraph four.",
    "Paragraph five.",
  ].join("\n\n");

  it("offers one cut per block except the last", () => {
    const cuts = cropBoundaries(FIVE);
    expect(cuts).toHaveLength(4);
    expect(cuts.map((c) => c.blockType)).toEqual(
      Array(4).fill("paragraph"),
    );
  });

  it("cuts on block boundaries so the kept text is never mid-sentence", () => {
    for (const cut of cropBoundaries(FIVE)) {
      const kept = FIVE.slice(0, cut.charOffset);
      expect(kept.endsWith(".")).toBe(true);
    }
  });

  it("keeps exactly paragraphs 1-2 at the second cut", () => {
    const cut = cropBoundaries(FIVE)[1];
    const kept = FIVE.slice(0, cut.charOffset);
    expect(kept).toBe("Paragraph one.\n\nParagraph two.");
    expect(cut.nextPreview).toBe("Paragraph three.");
  });

  it("snaps to headings, list items and code fences", () => {
    const src = [
      "# Heading",
      "",
      "Intro paragraph.",
      "",
      "- item one",
      "- item two",
      "",
      "```js",
      "code();",
      "```",
      "",
      "Closing paragraph.",
    ].join("\n");
    const types = cropBoundaries(src).map((c) => c.blockType);
    expect(types).toEqual(["heading", "paragraph", "listItem", "listItem", "code"]);
  });

  it("never emits a cut for a single-block message", () => {
    expect(cropBoundaries("Only one paragraph here.")).toHaveLength(0);
    expect(cropBoundaries("")).toHaveLength(0);
  });

  it("prefers the list item over its inner paragraph", () => {
    const src = "- alpha\n- beta\n- gamma";
    const cuts = cropBoundaries(src);
    expect(cuts).toHaveLength(2);
    expect(src.slice(0, cuts[0].charOffset)).toBe("- alpha");
  });
});

describe("wordAt", () => {
  it("finds the word under an offset", () => {
    const text = "the quick brown fox";
    expect(wordAt(text, 6)).toEqual({ start: 4, end: 9 });
    expect(text.slice(4, 9)).toBe("quick");
  });

  it("snaps back off a trailing space", () => {
    expect(wordAt("alpha beta", 5)).toEqual({ start: 0, end: 5 });
  });

  it("includes hyphens and apostrophes", () => {
    const text = "the well-known don't case";
    expect(text.slice(...Object.values(wordAt(text, 8)!) as [number, number])).toBe(
      "well-known",
    );
    expect(text.slice(...Object.values(wordAt(text, 17)!) as [number, number])).toBe(
      "don't",
    );
  });

  it("returns null on empty input or a lone separator", () => {
    expect(wordAt("", 0)).toBeNull();
    expect(wordAt("   ", 1)).toBeNull();
  });

  it("clamps an out-of-range offset", () => {
    expect(wordAt("abc", 99)).toEqual({ start: 0, end: 3 });
    expect(wordAt("abc", -5)).toEqual({ start: 0, end: 3 });
  });
});

describe("capitalizedRunAround (§5.1 term expansion)", () => {
  it("joins a multi-word proper noun", () => {
    const text = "we use the Central Limit Theorem here";
    const word = wordAt(text, 12)!;
    const run = capitalizedRunAround(text, word.start, word.end)!;
    expect(text.slice(run.start, run.end)).toBe("Central Limit Theorem");
  });

  it("leaves a single capitalized word alone", () => {
    const text = "Gradients vanish here";
    const word = wordAt(text, 2)!;
    expect(capitalizedRunAround(text, word.start, word.end)).toBeNull();
  });

  it("ignores lowercase words", () => {
    const text = "the quick brown fox";
    const word = wordAt(text, 6)!;
    expect(capitalizedRunAround(text, word.start, word.end)).toBeNull();
  });

  it("does not jump across punctuation or newlines", () => {
    const text = "Alpha. Beta";
    const word = wordAt(text, 8)!;
    expect(capitalizedRunAround(text, word.start, word.end)).toBeNull();
  });
});
