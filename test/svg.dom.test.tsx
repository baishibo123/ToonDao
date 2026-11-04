// @vitest-environment jsdom
/**
 * A reply's SVG is drawn as a picture (P-42): only a finished `<svg>` element,
 * only as an image, and the block still quotes as its source.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/Markdown";
import { svgPictureUrl } from "@/lib/svg";
import { LEAF_ATTR, resolveRange } from "@/lib/anchor";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
const decode = (url: string) => decodeURIComponent(url.split(",")[1] ?? "");

describe("svgPictureUrl", () => {
  it("draws a finished svg element under the languages a model writes it in", () => {
    for (const lang of ["svg", "SVG", "xml", "html", null]) {
      expect(svgPictureUrl(lang, SVG)).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    }
    expect(decode(svgPictureUrl("xml", `<?xml version="1.0"?>\n${SVG}\n`)!)).toMatch(/^<svg [^>]*><circle/);
  });

  it("leaves everything else as code: other languages, other markup, a block still streaming", () => {
    expect(svgPictureUrl("js", SVG)).toBeNull();
    expect(svgPictureUrl("html", "<div><svg></svg></div>")).toBeNull();
    expect(svgPictureUrl("svg", SVG.slice(0, -4))).toBeNull();
    expect(svgPictureUrl("svg", "<svgfoo></svg>")).toBeNull();
  });

  it("adds the namespaces an image needs and a model leaves out", () => {
    const bare = decode(svgPictureUrl("svg", '<svg viewBox="0 0 4 4"><use xlink:href="#a"/></svg>')!);
    expect(bare).toContain('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ');
    expect(decode(svgPictureUrl("svg", SVG)!).match(/xmlns=/g)).toHaveLength(1);
  });

  it("sizes a viewBox-only drawing by its viewBox, and leaves a stated size alone", () => {
    expect(decode(svgPictureUrl("svg", '<svg viewBox="0 0 640 200"></svg>')!)).toContain('width="640" height="200"');
    const sized = '<svg xmlns="http://www.w3.org/2000/svg" width="50" viewBox="0 0 640 200"></svg>';
    expect(decode(svgPictureUrl("svg", sized)!)).toBe(sized);
  });
});

describe("an SVG block in a reply", () => {
  const source = `Here it is:\n\n\`\`\`svg\n${SVG}\n\`\`\`\n`;

  it("renders as an image, never as markup in the page, with its source kept", () => {
    document.body.innerHTML = renderToStaticMarkup(<Markdown source={source} />);
    const img = document.querySelector("img.md-svg__img") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(document.querySelector("circle")).toBeNull();
    expect(document.querySelector(`.md-svg__source [${LEAF_ATTR}]`)?.textContent).toBe(SVG);
  });

  it("quotes as the whole block when the picture is selected", () => {
    document.body.innerHTML = renderToStaticMarkup(<Markdown source={source} />);
    const root = document.body.firstElementChild!;
    const figure = root.querySelector("figure.md-svg")!;
    const range = document.createRange();
    range.selectNode(figure.querySelector(".md-svg__paper")!);
    const anchor = resolveRange(range, root, source)!;
    expect(anchor.text).toContain("```svg");
    expect(anchor.text).toContain(SVG);
  });
});
