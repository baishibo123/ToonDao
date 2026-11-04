import type Katex from "katex";

/**
 * Formulas in a reply (P-48), typeset by KaTeX. KaTeX and its stylesheet are
 * loaded the first time a formula is on screen, so a conversation without one
 * never downloads them.
 *
 * KaTeX's output is the one HTML the renderer puts into the page, and it is
 * KaTeX's, built from TeX: `trust: false` turns off every command that could
 * make a link, an id or a class (\href, \url, \htmlId, …), so a reply cannot
 * reach the page through a formula.
 */

let katex: typeof Katex | null = null;
let loading: Promise<void> | null = null;

export function katexReady(): boolean {
  return katex !== null;
}

export function loadKatex(): Promise<void> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([mod]) => {
    katex = mod.default;
  });
  return loading;
}

/** A formula as HTML once KaTeX is loaded, null before. One KaTeX cannot read comes back as its source, in the error colour. */
export function typeset(tex: string, display: boolean): string | null {
  return katex ? renderTex(katex, tex, display) : null;
}

export function renderTex(engine: typeof Katex, tex: string, display: boolean): string {
  return engine.renderToString(tex, {
    displayMode: display,
    throwOnError: false,
    trust: false,
    strict: "ignore",
    output: "htmlAndMathml",
    // A runaway macro is the model's mistake, not a reason to hang the page.
    maxExpand: 1000,
    maxSize: 40,
  });
}
