// @vitest-environment jsdom
/**
 * Copying out of a reply. A block's copy holds its source; a whole reply's
 * formatted copy carries what was rendered and none of the page's own controls.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/Markdown";
import { pastableHtml } from "@/lib/clipboard";
import { loadKatex } from "@/lib/math";

function mount(source: string): Element {
  document.body.innerHTML = renderToStaticMarkup(<Markdown source={source} />);
  return document.body.firstElementChild!;
}

const SOURCE = [
  "Intro with **bold**.",
  "",
  "```python",
  "print(1)",
  "```",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
].join("\n");

beforeAll(async () => {
  await loadKatex();
});

describe("a block's copy", () => {
  it("sits on code, display formulas and tables, and nowhere else", () => {
    const root = mount(SOURCE);
    const holders = [...root.querySelectorAll(".md-copyable")].map((el) => el.lastElementChild!.tagName);
    expect(holders).toEqual(["PRE", "DIV", "DIV"]);
    expect(root.querySelector("p .copybtn")).toBeNull();
  });

  it("is not text the reading moves can quote", () => {
    const root = mount(SOURCE);
    for (const button of root.querySelectorAll(".copybtn")) {
      expect(button.closest("[data-leaf-index]")).toBeNull();
      expect(button.querySelector("[data-leaf-index]")).toBeNull();
    }
  });
});

describe("a reply's formatted copy", () => {
  it("keeps what was rendered and leaves out the page's controls and attributes", () => {
    const html = pastableHtml(mount(SOURCE));
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("print(1)");
    expect(html).toContain("<table>");
    expect(html).toContain("<math");
    expect(html).not.toContain("copy</button>");
    expect(html).not.toContain("python</span>");
    expect(html).not.toMatch(/data-|class=|katex-html/);
  });
});
