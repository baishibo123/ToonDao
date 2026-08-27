// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/Markdown";
import {
  LEAF_ATTR,
  clearMarkdownCache,
  expandToTerm,
  parseMarkdown,
  resolveRange,
  type SourceLeaf,
} from "@/lib/anchor";

/* ------------------------------------------------------------------ */
/* Harness: render the real component, then drive real DOM Ranges      */
/* ------------------------------------------------------------------ */

interface Mounted {
  root: Element;
  leaves: SourceLeaf[];
  source: string;
}

function mount(source: string): Mounted {
  document.body.innerHTML = renderToStaticMarkup(<Markdown source={source} />);
  const root = document.body.firstElementChild!;
  return { root, leaves: parseMarkdown(source).leaves, source };
}

function leafElement(root: Element, index: number): Element {
  const el = root.querySelector(`[${LEAF_ATTR}="${index}"]`);
  if (!el) throw new Error(`no rendered element for leaf ${index}`);
  return el;
}

/** Locate the (textNode, offset) pair for a rendered offset inside a leaf. */
function pointInLeaf(
  leafEl: Element,
  renderedOffset: number,
): { node: Node; offset: number } {
  let remaining = renderedOffset;
  const walker = document.createTreeWalker(leafEl, NodeFilter.SHOW_TEXT);
  let last: Node | null = null;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    last = node;
    node = walker.nextNode();
  }
  if (last) return { node: last, offset: last.textContent?.length ?? 0 };
  return { node: leafEl, offset: 0 };
}

function selectAcross(
  m: Mounted,
  startLeaf: number,
  startOffset: number,
  endLeaf: number,
  endOffset: number,
): Range {
  const a = pointInLeaf(leafElement(m.root, startLeaf), startOffset);
  const b = pointInLeaf(leafElement(m.root, endLeaf), endOffset);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

function collapsedAt(m: Mounted, leafIndex: number, renderedOffset: number): Range {
  const p = pointInLeaf(leafElement(m.root, leafIndex), renderedOffset);
  const range = document.createRange();
  range.setStart(p.node, p.offset);
  range.collapse(true);
  return range;
}

/** Deterministic PRNG so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/* ------------------------------------------------------------------ */

const CORPUS: Array<[name: string, source: string]> = [
  ["duplicate phrases", "the model is a model of a model, said the model"],
  [
    "duplicates plus a code fence",
    [
      "The model is a model of a model.",
      "",
      "```python",
      "model = load_model()  # model",
      "```",
      "",
      "One more model here.",
    ].join("\n"),
  ],
  [
    "nested lists",
    ["- outer one", "  - inner a", "  - inner b", "- outer two", "", "done"].join("\n"),
  ],
  [
    "inline formatting soup",
    "A **bold** and *italic* and `inline code` and [link text](https://x.test) mix.",
  ],
  [
    "repeated inline code",
    "Compare `slice` with `slice` and then `slice` once more.",
  ],
  [
    "headings and quotes",
    ["# Title", "", "> quoted line", "> second quoted line", "", "## Title", "", "body"].join("\n"),
  ],
  ["escapes", String.raw`a \* b \_ c \# d`],
  [
    "table",
    ["| model | score |", "| --- | --- |", "| model | 1 |", "| model | 2 |"].join("\n"),
  ],
  [
    "adjacent identical paragraphs",
    ["same paragraph", "", "same paragraph", "", "same paragraph"].join("\n"),
  ],
  [
    "code fence containing markdown",
    ["prose", "", "````md", "**not bold** and `not code`", "````", "", "prose"].join("\n"),
  ],
];

describe("DOM selection → source offsets: exhaustive within-leaf round-trip", () => {
  for (const [name, source] of CORPUS) {
    it(`round-trips every offset pair in "${name}"`, () => {
      const m = mount(source);
      expect(m.leaves.length).toBeGreaterThan(0);

      for (const leaf of m.leaves) {
        const len = leaf.value.length;
        if (len === 0) continue;
        const step = len > 24 ? Math.ceil(len / 12) : 1;
        for (let a = 0; a <= len; a += step) {
          for (let b = a; b <= len; b += step) {
            const range = selectAcross(m, leaf.index, a, leaf.index, b);
            const anchor = resolveRange(range, m.root, source)!;
            expect(anchor).not.toBeNull();
            expect(anchor.start).toBe(leaf.map[a]);
            expect(anchor.end).toBe(leaf.map[b]);
            expect(anchor.text).toBe(source.slice(leaf.map[a], leaf.map[b]));
            // Every rendered character in the range is present at its mapped
            // source offset. This is the invariant that textContent.indexOf()
            // violates on duplicate substrings.
            for (let i = a; i < b; i++) {
              expect(source[leaf.map[i]]).toBe(leaf.value[i]);
            }
          }
        }
      }
    });
  }
});

describe("DOM selection → source offsets: cross-leaf drags", () => {
  for (const [name, source] of CORPUS) {
    it(`round-trips random cross-leaf drags in "${name}"`, () => {
      const m = mount(source);
      if (m.leaves.length < 2) return;
      const rand = rng(0xc0ffee);

      for (let trial = 0; trial < 200; trial++) {
        const i = Math.floor(rand() * m.leaves.length);
        const j = Math.min(
          m.leaves.length - 1,
          i + Math.floor(rand() * (m.leaves.length - i)),
        );
        const li = m.leaves[i];
        const lj = m.leaves[j];
        let a = Math.floor(rand() * (li.value.length + 1));
        let b = Math.floor(rand() * (lj.value.length + 1));
        // A DOM Range is always forward-ordered: setEnd() with a point before
        // the start collapses it. Build the endpoints in document order.
        if (i === j && a > b) [a, b] = [b, a];

        const anchor = resolveRange(
          selectAcross(m, li.index, a, lj.index, b),
          m.root,
          source,
        )!;
        const lo = Math.min(li.map[a], lj.map[b]);
        const hi = Math.max(li.map[a], lj.map[b]);
        expect(anchor.start).toBe(lo);
        expect(anchor.end).toBe(hi);
        expect(anchor.text).toBe(source.slice(lo, hi));
      }
    });
  }
});

describe("ACCEPTANCE 5: anchor integrity on six occurrences of one word", () => {
  const SOURCE = [
    "The model is a model of a model.",
    "",
    "```python",
    "model = load_model()  # model",
    "```",
    "",
    "One more model here.",
  ].join("\n");

  /** Every occurrence of `word`, as (leafIndex, renderedOffset) pairs. */
  function occurrences(m: Mounted, word: string) {
    const out: Array<{ leaf: SourceLeaf; offset: number; sourceOffset: number }> = [];
    for (const leaf of m.leaves) {
      for (let i = 0; i + word.length <= leaf.value.length; i++) {
        if (leaf.value.startsWith(word, i)) {
          out.push({ leaf, offset: i, sourceOffset: leaf.map[i] });
        }
      }
    }
    return out.sort((x, y) => x.sourceOffset - y.sourceOffset);
  }

  it("resolves the fifth occurrence to the fifth occurrence", () => {
    const m = mount(SOURCE);
    const hits = occurrences(m, "model");
    expect(hits).toHaveLength(7); // 3 prose + 3 in the fence + 1 trailing

    const fifth = hits[4];
    const range = selectAcross(
      m,
      fifth.leaf.index,
      fifth.offset,
      fifth.leaf.index,
      fifth.offset + 5,
    );
    const anchor = resolveRange(range, m.root, SOURCE)!;

    expect(anchor.text).toBe("model");
    expect(anchor.start).toBe(fifth.sourceOffset);

    // The naive implementation would land on the first occurrence.
    expect(anchor.start).not.toBe(SOURCE.indexOf("model"));

    // It is genuinely the fifth: exactly four earlier occurrences precede it.
    const earlier = hits.filter((h) => h.sourceOffset < anchor.start);
    expect(earlier).toHaveLength(4);

    // And it is inside the code fence.
    expect(anchor.start).toBeGreaterThan(SOURCE.indexOf("```python"));
    expect(anchor.start).toBeLessThan(SOURCE.lastIndexOf("```"));
  });

  it("round-trips identically after a reload (cache dropped, source re-parsed)", () => {
    const before = mount(SOURCE);
    const hits = occurrences(before, "model");
    const fifthOffset = hits[4].sourceOffset;

    // Simulate a reload: nothing survives but the stored markdown and offsets.
    clearMarkdownCache();
    document.body.innerHTML = "";

    const after = mount(SOURCE);
    const rehits = occurrences(after, "model");
    expect(rehits[4].sourceOffset).toBe(fifthOffset);
    expect(SOURCE.slice(fifthOffset, fifthOffset + 5)).toBe("model");

    const range = selectAcross(
      after,
      rehits[4].leaf.index,
      rehits[4].offset,
      rehits[4].leaf.index,
      rehits[4].offset + 5,
    );
    expect(resolveRange(range, after.root, SOURCE)!.start).toBe(fifthOffset);
  });
});

describe("expandToTerm (§5.1)", () => {
  it("expands a click to the word under the cursor", () => {
    const source = "the quick brown fox jumps";
    const m = mount(source);
    const anchor = expandToTerm(collapsedAt(m, 0, 6), m.root, source)!;
    expect(anchor.text).toBe("quick");
  });

  it("expands to the enclosing inline code span", () => {
    const source = "call `assembleContext(node)` before rendering";
    const m = mount(source);
    const codeLeaf = m.leaves.find((l) => l.type === "inlineCode")!;
    const anchor = expandToTerm(
      collapsedAt(m, codeLeaf.index, 3),
      m.root,
      source,
    )!;
    expect(anchor.text).toBe("`assembleContext(node)`");
  });

  it("expands to the enclosing bold span", () => {
    const source = "this is **structurally load bearing** here";
    const m = mount(source);
    const inner = m.leaves.find((l) => l.value.includes("load bearing"))!;
    const anchor = expandToTerm(collapsedAt(m, inner.index, 4), m.root, source)!;
    expect(anchor.text).toBe("**structurally load bearing**");
  });

  it("expands to the enclosing link text", () => {
    const source = "see [the Reingold-Tilford paper](https://x.test) for detail";
    const m = mount(source);
    const inner = m.leaves.find((l) => l.value.includes("Reingold"))!;
    const anchor = expandToTerm(collapsedAt(m, inner.index, 5), m.root, source)!;
    expect(anchor.text).toBe("[the Reingold-Tilford paper](https://x.test)");
  });

  it("joins a capitalized run into one term", () => {
    const source = "we apply the Central Limit Theorem to the residuals";
    const m = mount(source);
    const anchor = expandToTerm(collapsedAt(m, 0, 22), m.root, source)!;
    expect(anchor.text).toBe("Central Limit Theorem");
  });

  it("does not expand a whole code fence to a term", () => {
    const source = "prose\n\n```js\nconst modelName = 1;\n```\n";
    const m = mount(source);
    const codeLeaf = m.leaves.find((l) => l.type === "code")!;
    const anchor = expandToTerm(collapsedAt(m, codeLeaf.index, 8), m.root, source)!;
    expect(anchor.text).toBe("modelName");
  });

  it("preserves an existing drag selection instead of expanding it", () => {
    const source = "the quick brown fox";
    const m = mount(source);
    const anchor = expandToTerm(selectAcross(m, 0, 4, 0, 15), m.root, source)!;
    expect(anchor.text).toBe("quick brown");
  });
});

describe("degenerate ranges", () => {
  it("returns the whole message when the selection is the container itself", () => {
    const source = "alpha\n\nbeta";
    const m = mount(source);
    const range = document.createRange();
    range.selectNodeContents(m.root);
    const anchor = resolveRange(range, m.root, source)!;
    expect(anchor.start).toBe(0);
    expect(anchor.end).toBe(source.length);
  });

  it("returns null for a range entirely outside the message", () => {
    const source = "alpha";
    const m = mount(source);
    const outside = document.createElement("div");
    outside.textContent = "not part of the message";
    document.body.appendChild(outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(resolveRange(range, m.root, source)).toBeNull();
  });

  it("handles a click on a list bullet, outside any leaf", () => {
    const source = "- alpha\n- beta";
    const m = mount(source);
    const li = m.root.querySelector("li")!;
    const range = document.createRange();
    range.setStart(li, 0);
    range.collapse(true);
    const anchor = resolveRange(range, m.root, source)!;
    expect(anchor.start).toBe(0);
  });

  it("handles an empty message", () => {
    const m = mount("");
    const range = document.createRange();
    range.selectNodeContents(m.root);
    const anchor = resolveRange(range, m.root, "")!;
    expect(anchor).toEqual({ start: 0, end: 0, text: "", blockPath: undefined });
  });
});

describe("rendered markup carries the anchoring contract", () => {
  it("emits data-src-start / data-src-end on every block", () => {
    const source = "# H\n\npara\n\n- item\n\n```js\nx\n```";
    const m = mount(source);
    for (const tag of ["h1", "p", "li", "pre"]) {
      const el = m.root.querySelector(tag)!;
      expect(el.hasAttribute("data-src-start")).toBe(true);
      expect(el.hasAttribute("data-src-end")).toBe(true);
      expect(el.hasAttribute("data-block-path")).toBe(true);
    }
  });

  it("emits one element per leaf, in document order", () => {
    const source = "a **b** c `d` e";
    const m = mount(source);
    const els = [...m.root.querySelectorAll(`[${LEAF_ATTR}]`)];
    expect(els).toHaveLength(m.leaves.length);
    els.forEach((el, i) => {
      expect(Number(el.getAttribute(LEAF_ATTR))).toBe(i);
      expect(el.textContent).toBe(m.leaves[i].value);
    });
  });

  it("renders raw HTML in the source as literal text, never as markup", () => {
    const source = 'before <img src=x onerror="boom()"> after';
    const m = mount(source);
    expect(m.root.querySelector("img")).toBeNull();
    expect(m.root.textContent).toContain('<img src=x onerror="boom()">');
  });
});
