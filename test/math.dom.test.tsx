// @vitest-environment jsdom
/**
 * Formulas in a reply (P-48): parsed as math, typeset by KaTeX with nothing
 * that can reach the page, and quoted whole.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import katex from "katex";
import { Markdown } from "@/components/Markdown";
import { expandToTerm, parseMarkdown, resolveRange } from "@/lib/anchor";
import { rangeForAnchor } from "@/lib/selection";
import { renderTex } from "@/lib/math";

function mount(source: string): Element {
  document.body.innerHTML = renderToStaticMarkup(<Markdown source={source} />);
  return document.body.firstElementChild!;
}

describe("parsing", () => {
  it("finds inline and display formulas, in tables too, and leaves an escaped dollar alone", () => {
    const source = "Linear: $f(a+b) = f(a) + f(b)$, costs \\$5.\n\n$$\nx^2\n$$\n\n| op | ok |\n|---|---|\n| $x_1 \\cdot x_2$ | no |";
    const types: string[] = [];
    const walk = (nodes: Array<{ type: string; children?: unknown[] }>) =>
      nodes.forEach((n) => {
        types.push(n.type);
        if (n.children) walk(n.children as typeof nodes);
      });
    walk(parseMarkdown(source).root.children as never);
    expect(types.filter((t) => t === "inlineMath")).toHaveLength(2);
    expect(types.filter((t) => t === "math")).toHaveLength(1);
    expect(parseMarkdown(source).blocks.some((b) => b.type === "math")).toBe(true);
  });
});

describe("typesetting", () => {
  it("draws TeX, and reads a formula it cannot parse as its source instead of failing", () => {
    expect(renderTex(katex, "x^2", false)).toContain('class="katex"');
    expect(renderTex(katex, "\\frac{1}{", false)).toContain("katex-error");
  });

  it("lets no formula make a link, an id or a class on the page", () => {
    const html = renderTex(katex, "\\href{javascript:alert(1)}{x} \\htmlId{boom}{y} \\url{https://example.com}", false);
    expect(html).not.toMatch(/<a\b/);
    expect(html).not.toMatch(/\shref=/);
    expect(html).not.toContain('id="boom"');
    // The source survives only as the formula's text annotation, which is inert.
    expect(html).toContain('<annotation encoding="application/x-tex">\\href{javascript:alert(1)}');
  });
});

describe("a formula in the text", () => {
  const source = "Before $x^2 + y^2$ after.";
  const start = source.indexOf("$");
  const end = source.lastIndexOf("$") + 1;

  it("is shown as its source until KaTeX has loaded, carrying its source range", () => {
    const formula = mount(source).querySelector(".md-math")!;
    expect(formula.textContent).toBe("$x^2 + y^2$");
    expect(formula.getAttribute("data-src-start")).toBe(String(start));
    expect(formula.getAttribute("data-src-end")).toBe(String(end));
  });

  it("is quoted whole, whether part of it is dragged over or it is clicked", () => {
    const root = mount(source);
    const formula = root.querySelector(".md-math")!;
    const text = formula.firstChild!;
    const drag = document.createRange();
    drag.setStart(text, 2);
    drag.setEnd(text, 5);
    expect(resolveRange(drag, root, source)?.text).toBe("$x^2 + y^2$");

    const click = document.createRange();
    click.setStart(text, 3);
    click.collapse(true);
    expect(expandToTerm(click, root, source)?.text).toBe("$x^2 + y^2$");
  });

  it("maps back to its element, so the click hit-test and the underline find it", () => {
    const root = mount(source);
    const range = rangeForAnchor(root, { start, end })!;
    expect(range.toString()).toBe("$x^2 + y^2$");
  });
});
