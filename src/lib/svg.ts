/**
 * Drawing an SVG a reply wrote (P-42).
 *
 * A fenced block whose source is a whole `<svg>…</svg>` element is shown as a
 * picture. It is loaded as an image from a `data:` URL, never put into the
 * page: an SVG loaded as an image runs no script and fetches nothing, so a
 * reply cannot reach the network or the app through it. Until the closing tag
 * has streamed in, the block stays code.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Fence languages a model writes an SVG under. */
const SVG_LANGS = new Set(["svg", "xml", "html", ""]);

/**
 * The `data:` URL to draw a fenced block with, or null when the block is not a
 * finished SVG (another language, not an `<svg>` element, still streaming).
 */
export function svgPictureUrl(lang: string | null | undefined, source: string): string | null {
  if (!SVG_LANGS.has((lang ?? "").toLowerCase())) return null;
  const svg = source.trim().replace(/^<\?xml[^>]*\?>\s*/, "");
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespaces(svg))}`;
}

/**
 * What an image needs and a model often leaves out. Loaded as an image, an
 * SVG is parsed as XML and draws nothing without its namespace (and xlink's,
 * if used); and with only a `viewBox` it is drawn 300 px wide, so it takes
 * the viewBox's size instead.
 */
function withNamespaces(svg: string): string {
  const open = svg.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
  let attrs = "";
  if (!/\sxmlns\s*=/.test(open)) attrs += ` xmlns="${SVG_NS}"`;
  if (svg.includes("xlink:") && !/\sxmlns:xlink\s*=/.test(open)) attrs += ` xmlns:xlink="${XLINK_NS}"`;
  const box = open.match(/\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/);
  if (box && !/\s(width|height)\s*=/.test(open)) attrs += ` width="${box[1]}" height="${box[2]}"`;
  return attrs ? svg.replace(/^<svg/i, `<svg${attrs}`) : svg;
}
