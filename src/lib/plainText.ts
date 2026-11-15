/**
 * A passage as a label reads it: the Markdown and TeX it was written in taken
 * off, so a sidebar row says "im2col", not "**im2col**". A passage is a slice
 * of source cut wherever the reader pointed, often mid-construct, so this
 * works on the characters rather than on a parse: a marker is dropped where it
 * touches a word, and a lone `*` between spaces (a product) is kept.
 *
 * For display only. What is quoted to a model is always the source itself.
 */

/** TeX commands whose argument is the text to show. */
const UNWRAP = /\\(?:text|textbf|textit|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|operatorname|boldsymbol|emph)\s*\{([^{}]*)\}/g;

const SYMBOLS: Record<string, string> = {
  times: "×", cdot: "·", div: "÷", pm: "±", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", sim: "~", infty: "∞", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒",
  in: "∈", sum: "Σ", prod: "Π", int: "∫", partial: "∂", nabla: "∇", sqrt: "√", ldots: "…", cdots: "⋯",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", eta: "η", theta: "θ",
  lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", omega: "ω",
  Delta: "Δ", Sigma: "Σ", Omega: "Ω",
};

export function plainText(source: string): string {
  let text = source;
  // Escaped characters are themselves; set them aside so no rule below eats them.
  const escaped: string[] = [];
  text = text.replace(/\\([\\`*_{}[\]()#+\-.$~|>])/g, (_, ch: string) => `\u0000${escaped.push(ch) - 1}\u0000`);

  // Math: drop the dollars, unwrap \text{…}, name the common symbols, drop
  // the remaining command backslashes and grouping braces.
  text = text.replace(/\${1,2}/g, "");
  for (let i = 0; i < 3; i++) text = text.replace(UNWRAP, "$1");
  text = text.replace(/\\([A-Za-z]+)/g, (whole, name: string) => SYMBOLS[name] ?? (name.length > 1 ? name : whole));
  text = text.replace(/\\[,;:! ]/g, " ").replace(/[{}]/g, "");

  // Links and pictures keep their words.
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Block markers at the start of a line: heading, quote, list item, fence.
  text = text.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+|`{3,}\S*|~{3,}\S*)/gm, "");
  // Emphasis, strikethrough and code markers that touch a word.
  // Underscores are left alone: `__init__` and `x_i` are words more often
  // than a model's `__bold__` is.
  text = text.replace(/(\*{1,3}|~~|`+)(?=\S)|(?<=\S)(\*{1,3}|~~|`+)/g, "");

  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => escaped[Number(i)]);
}
