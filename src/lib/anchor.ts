/**
 * anchor.ts — mapping DOM selections back to character offsets in the raw
 * markdown source. §7 of SPEC.md calls this "the one genuinely hard technical
 * problem" and it is.
 *
 * The trap: `textContent.indexOf(selectedText)` appears to work and then
 * silently corrupts on any message containing a repeated substring. Nothing in
 * this module ever searches the *message* for the selected text. Offsets come
 * from mdast `position` data exclusively, and text search is used only inside a
 * single already-located leaf, where it cannot be ambiguous across the message.
 *
 * The shape of the solution:
 *
 *   1. Parse the markdown once. Every mdast node carries
 *      `position.start.offset` / `position.end.offset`.
 *   2. Flatten it into an ordered list of *leaves* — the maximal runs of text
 *      that render as contiguous characters (`text`, `inlineCode`, `code`).
 *      Each leaf knows its exact source range and a per-character map from
 *      rendered offset to source offset, so escapes (`\*`) and entities
 *      (`&amp;`) cannot drift.
 *   3. The renderer (components/Markdown.tsx) emits one element per leaf
 *      carrying `data-leaf-index`, plus `data-src-start`/`data-src-end` on
 *      every block. It walks *this same tree*, so the two cannot disagree.
 *   4. To resolve a selection: find the leaf element, count rendered
 *      characters within it, look the offset up in the map.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";

export interface SourceLeaf {
  index: number;
  /** mdast node type: "text" | "inlineCode" | "code" | "html" */
  type: string;
  /** Source range of the whole mdast node, markup included. */
  srcStart: number;
  srcEnd: number;
  /** The rendered characters this leaf contributes. */
  value: string;
  /** Index path to the enclosing block, e.g. "3" or "3.1". */
  blockPath: string;
  /** map[i] is the absolute source offset of rendered character i.
   *  Length is value.length + 1; the last entry is the exclusive end. */
  map: number[];
}

export interface SourceBlock {
  /** Index path into the mdast tree, e.g. "3" or "3.1". */
  path: string;
  type: string;
  srcStart: number;
  srcEnd: number;
  /** Depth 0 = top level. */
  depth: number;
}

export interface ParsedMarkdown {
  source: string;
  root: Root;
  leaves: SourceLeaf[];
  /** Croppable block boundaries in document order (§5.2). */
  blocks: SourceBlock[];
}

/**
 * Annotations written onto the mdast nodes themselves during the flattening
 * walk, so the renderer never has to reproduce the traversal order. If the
 * renderer had to re-derive leaf indices by walking the tree a second time, the
 * two walks could drift apart on an edge case and every anchor in the message
 * would silently shift. Reading the annotation makes that class of bug
 * impossible.
 */
export interface MdastAnnotations {
  __leafIndex?: number;
  __blockPath?: string;
  __srcStart?: number;
  __srcEnd?: number;
}

export type AnnotatedNode = RootContent & MdastAnnotations;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const processor = unified().use(remarkParse).use(remarkGfm);

/** Small LRU so re-renders and repeated selections do not re-parse. */
const CACHE_LIMIT = 64;
const cache = new Map<string, ParsedMarkdown>();

export function parseMarkdown(source: string): ParsedMarkdown {
  const hit = cache.get(source);
  if (hit) {
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  const parsed = buildParsedMarkdown(source);
  cache.set(source, parsed);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return parsed;
}

export function clearMarkdownCache(): void {
  cache.clear();
}

function buildParsedMarkdown(source: string): ParsedMarkdown {
  const root = processor.parse(source) as Root;
  const leaves: SourceLeaf[] = [];
  const blocks: SourceBlock[] = [];

  const walk = (nodes: RootContent[], path: number[], depth: number): void => {
    nodes.forEach((node, i) => {
      const nextPath = [...path, i];
      const pathKey = nextPath.join(".");
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;

      const annotated = node as AnnotatedNode;
      annotated.__blockPath = pathKey;
      annotated.__srcStart = start;
      annotated.__srcEnd = end;

      if (isBlock(node) && start !== undefined && end !== undefined) {
        blocks.push({ path: pathKey, type: node.type, srcStart: start, srcEnd: end, depth });
      }

      const value = leafValue(node);
      if (value !== null && start !== undefined && end !== undefined) {
        annotated.__leafIndex = leaves.length;
        leaves.push({
          index: leaves.length,
          type: node.type,
          srcStart: start,
          srcEnd: end,
          value,
          blockPath: path.join(".") || pathKey,
          map: alignValueToSource(source.slice(start, end), value, start),
        });
        return; // leaves have no children worth descending into
      }

      const children = (node as { children?: RootContent[] }).children;
      if (children?.length) {
        walk(children, nextPath, isBlock(node) ? depth + 1 : depth);
      }
    });
  };

  walk(root.children, [], 0);
  return { source, root, leaves, blocks };
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "code",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "thematicBreak",
  "html",
  "footnoteDefinition",
  "definition",
]);

function isBlock(node: { type: string }): boolean {
  return BLOCK_TYPES.has(node.type);
}

/** The rendered characters a node contributes, or null if it is not a leaf. */
function leafValue(node: { type: string; value?: string }): string | null {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value ?? "";
    case "html":
      // Raw HTML is rendered as literal text (we never inject HTML), so its
      // source and rendered forms coincide.
      return node.value ?? "";
    default:
      return null;
  }
}

/**
 * Build a per-character map from a leaf's rendered value to source offsets.
 *
 * Fast path: the value appears verbatim in the slice (the overwhelmingly common
 * case, including fenced code, where the slice is the fence and the value is
 * its body). The `indexOf` here is scoped to one leaf's own source slice, so it
 * cannot pick up a duplicate from elsewhere in the message.
 *
 * Slow path: greedy alignment, advancing through source characters that the
 * renderer drops — backslash escapes, entity references, hard-break spaces.
 */
export function alignValueToSource(
  slice: string,
  value: string,
  base: number,
): number[] {
  const map = new Array<number>(value.length + 1);

  const direct = slice.indexOf(value);
  if (direct >= 0) {
    for (let i = 0; i <= value.length; i++) map[i] = base + direct + i;
    return map;
  }

  let si = 0;
  for (let vi = 0; vi < value.length; vi++) {
    while (si < slice.length && slice[si] !== value[vi]) si++;
    if (si >= slice.length) {
      for (let k = vi; k <= value.length; k++) map[k] = base + slice.length;
      return map;
    }
    map[vi] = base + si;
    si++;
  }
  map[value.length] = base + si;
  return map;
}

/* ------------------------------------------------------------------ */
/* Crop boundaries (§5.2)                                              */
/* ------------------------------------------------------------------ */

/** Block types the crop rail is allowed to snap to. */
const CROP_SNAP_TYPES = new Set([
  "paragraph",
  "heading",
  "code",
  "listItem",
  "table",
  "thematicBreak",
  "html",
]);

export interface CropBoundary {
  /** Cut here: content.slice(0, charOffset) is kept. */
  charOffset: number;
  /** Path of the last block *included* by this cut. */
  blockPath: string;
  blockType: string;
  /** First line of the block that follows, for the "throwing away" preview. */
  nextPreview: string;
}

/**
 * Cut points for the structural crop, one after each snappable block.
 *
 * Block boundaries rather than arbitrary offsets: cutting mid-sentence produces
 * a malformed prompt, and blocks are the natural unit of "I stopped following
 * here". The final block is excluded — cropping after the last block discards
 * nothing and is not a crop.
 */
export function cropBoundaries(source: string): CropBoundary[] {
  const { blocks } = parseMarkdown(source);
  const snappable = blocks
    .filter((b) => CROP_SNAP_TYPES.has(b.type))
    // A listItem and its inner paragraph share a range; prefer the outer one.
    .filter((b, i, all) => !all.some((o, j) => j !== i && o.srcStart === b.srcStart && o.srcEnd === b.srcEnd && o.depth < b.depth))
    .sort((a, b) => a.srcStart - b.srcStart || b.srcEnd - a.srcEnd)
    .filter((b, i, all) => i === 0 || b.srcStart >= all[i - 1].srcEnd);

  const out: CropBoundary[] = [];
  for (let i = 0; i < snappable.length - 1; i++) {
    const block = snappable[i];
    const next = snappable[i + 1];
    out.push({
      charOffset: block.srcEnd,
      blockPath: block.path,
      blockType: block.type,
      nextPreview: firstLine(source.slice(next.srcStart, next.srcEnd)),
    });
  }
  return out;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/* ------------------------------------------------------------------ */
/* DOM selection resolution                                           */
/* ------------------------------------------------------------------ */

export const LEAF_ATTR = "data-leaf-index";
export const SRC_START_ATTR = "data-src-start";
export const SRC_END_ATTR = "data-src-end";
export const BLOCK_PATH_ATTR = "data-block-path";

export interface ResolvedAnchor {
  start: number;
  end: number;
  text: string;
  blockPath?: string;
}

/**
 * Resolve a DOM Range inside a rendered message to raw-markdown offsets.
 * Returns null when the range does not intersect the message at all.
 */
export function resolveRange(
  range: Range,
  root: Element,
  source: string,
): ResolvedAnchor | null {
  const parsed = parseMarkdown(source);

  const startPoint = resolvePoint(
    range.startContainer,
    range.startOffset,
    root,
    parsed,
    "start",
  );
  const endPoint = range.collapsed
    ? startPoint
    : resolvePoint(range.endContainer, range.endOffset, root, parsed, "end");

  if (startPoint === null || endPoint === null) return null;

  let start = Math.min(startPoint.offset, endPoint.offset);
  let end = Math.max(startPoint.offset, endPoint.offset);
  if (end < start) [start, end] = [end, start];

  return {
    start,
    end,
    text: source.slice(start, end),
    blockPath: startPoint.blockPath,
  };
}

interface Point {
  offset: number;
  blockPath?: string;
}

function resolvePoint(
  container: Node,
  offsetInContainer: number,
  root: Element,
  parsed: ParsedMarkdown,
  edge: "start" | "end",
): Point | null {
  const leafEl = closestWithAttr(container, LEAF_ATTR, root);

  if (leafEl) {
    const index = Number(leafEl.getAttribute(LEAF_ATTR));
    const leaf = parsed.leaves[index];
    if (leaf) {
      const rendered = renderedOffsetWithin(leafEl, container, offsetInContainer);
      const clamped = Math.max(0, Math.min(rendered, leaf.value.length));
      return { offset: leaf.map[clamped], blockPath: leaf.blockPath };
    }
  }

  // The point sits between leaves — a block wrapper, a list bullet, the gap
  // after a paragraph. Fall back to the enclosing block's own boundary.
  const blockEl = closestWithAttr(container, SRC_START_ATTR, root);
  if (blockEl) {
    const attr = edge === "start" ? SRC_START_ATTR : SRC_END_ATTR;
    const raw = Number(blockEl.getAttribute(attr));
    if (Number.isFinite(raw)) {
      return {
        offset: raw,
        blockPath: blockEl.getAttribute(BLOCK_PATH_ATTR) ?? undefined,
      };
    }
  }

  // Selecting the whole message from outside any block.
  if (root.contains(container) || root === container) {
    return { offset: edge === "start" ? 0 : parsed.source.length };
  }
  return null;
}

function closestWithAttr(
  node: Node,
  attr: string,
  root: Element,
): Element | null {
  let el: Node | null =
    node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== root.parentNode) {
    if (el.nodeType === Node.ELEMENT_NODE && (el as Element).hasAttribute(attr)) {
      return el as Element;
    }
    el = el.parentNode;
  }
  return null;
}

/** Rendered characters preceding `container[offset]` inside `leafEl`. */
function renderedOffsetWithin(
  leafEl: Element,
  container: Node,
  offsetInContainer: number,
): number {
  if (container === leafEl) {
    // Offset is a child index, not a character index.
    let total = 0;
    for (let i = 0; i < offsetInContainer && i < leafEl.childNodes.length; i++) {
      total += leafEl.childNodes[i].textContent?.length ?? 0;
    }
    return total;
  }

  let total = 0;
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (node === container) {
      total +=
        node.nodeType === Node.TEXT_NODE
          ? offsetInContainer
          : childIndexLength(node, offsetInContainer);
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      total += node.textContent?.length ?? 0;
      return;
    }
    node.childNodes.forEach(visit);
  };
  leafEl.childNodes.forEach(visit);
  return total;
}

function childIndexLength(node: Node, childIndex: number): number {
  let total = 0;
  for (let i = 0; i < childIndex && i < node.childNodes.length; i++) {
    total += node.childNodes[i].textContent?.length ?? 0;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Click-to-term expansion (§5.1)                                     */
/* ------------------------------------------------------------------ */

const WORD_RE = /[\p{L}\p{N}_'’-]/u;

/**
 * Expand a collapsed click into a term.
 *
 * Order of preference, per §5.1:
 *   1. the enclosing inline code span / bold / italic / link text, if any
 *   2. a run of capitalized tokens around the word
 *   3. the bare word
 *
 * No NLP pipeline. Selection-or-word, degrading gracefully.
 */
export function expandToTerm(
  range: Range,
  root: Element,
  source: string,
): ResolvedAnchor | null {
  const point = resolveRange(range, root, source);
  if (point === null) return null;

  // A drag already expressed the user's intent exactly. Only a click needs
  // expanding — §5.1 is "selection-or-word", not "selection-then-word".
  if (!range.collapsed && point.end > point.start) return point;

  // 1. An inline wrapper the click landed inside.
  const wrapper = closestInlineWrapper(range.startContainer, root);
  if (wrapper) {
    const start = Number(wrapper.getAttribute(SRC_START_ATTR));
    const end = Number(wrapper.getAttribute(SRC_END_ATTR));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return {
        start,
        end,
        text: source.slice(start, end),
        blockPath: wrapper.getAttribute(BLOCK_PATH_ATTR) ?? point.blockPath,
      };
    }
  }

  // 2 & 3. Word, then capitalized run, computed in source coordinates. The
  // source is markdown, but word characters are word characters either way.
  const word = wordAt(source, point.start);
  if (!word) return point;
  const run = capitalizedRunAround(source, word.start, word.end);
  const chosen = run ?? word;
  return {
    start: chosen.start,
    end: chosen.end,
    text: source.slice(chosen.start, chosen.end),
    blockPath: point.blockPath,
  };
}

const INLINE_WRAPPER_TAGS = new Set(["CODE", "STRONG", "EM", "A", "DEL", "ABBR"]);

function closestInlineWrapper(node: Node, root: Element): Element | null {
  let el: Node | null =
    node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el !== root.parentNode) {
    if (el.nodeType === Node.ELEMENT_NODE) {
      const element = el as Element;
      // A fenced code block is a whole block, not a term.
      if (element.tagName === "PRE") return null;
      if (
        INLINE_WRAPPER_TAGS.has(element.tagName) &&
        element.hasAttribute(SRC_START_ATTR)
      ) {
        return element;
      }
    }
    el = el.parentNode;
  }
  return null;
}

export function wordAt(
  text: string,
  offset: number,
): { start: number; end: number } | null {
  if (text.length === 0) return null;
  let i = Math.max(0, Math.min(offset, text.length - 1));
  if (!WORD_RE.test(text[i])) {
    // Clicked whitespace or punctuation — try the character just before.
    if (i > 0 && WORD_RE.test(text[i - 1])) i -= 1;
    else return null;
  }
  let start = i;
  let end = i + 1;
  while (start > 0 && WORD_RE.test(text[start - 1])) start--;
  while (end < text.length && WORD_RE.test(text[end])) end++;
  return { start, end };
}

/**
 * A run of two or more capitalized tokens ("Reingold Tilford", "Central Limit
 * Theorem") reads as one term. One capitalized word on its own does not — it is
 * usually just a sentence opener.
 */
export function capitalizedRunAround(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (!isCapitalizedToken(text.slice(start, end))) return null;

  let runStart = start;
  let runEnd = end;
  let tokens = 1;

  for (;;) {
    const prev = previousToken(text, runStart);
    if (!prev || !isCapitalizedToken(text.slice(prev.start, prev.end))) break;
    runStart = prev.start;
    tokens++;
  }
  for (;;) {
    const next = nextToken(text, runEnd);
    if (!next || !isCapitalizedToken(text.slice(next.start, next.end))) break;
    runEnd = next.end;
    tokens++;
  }

  return tokens >= 2 ? { start: runStart, end: runEnd } : null;
}

function isCapitalizedToken(token: string): boolean {
  if (token.length === 0) return false;
  const first = token[0];
  return first === first.toUpperCase() && first !== first.toLowerCase();
}

/** The token immediately before `pos`, separated by a single space only. */
function previousToken(
  text: string,
  pos: number,
): { start: number; end: number } | null {
  if (pos === 0 || text[pos - 1] !== " ") return null;
  const end = pos - 1;
  if (end === 0 || !WORD_RE.test(text[end - 1])) return null;
  let start = end;
  while (start > 0 && WORD_RE.test(text[start - 1])) start--;
  return { start, end };
}

function nextToken(
  text: string,
  pos: number,
): { start: number; end: number } | null {
  if (pos >= text.length || text[pos] !== " ") return null;
  const start = pos + 1;
  if (start >= text.length || !WORD_RE.test(text[start])) return null;
  let end = start;
  while (end < text.length && WORD_RE.test(text[end])) end++;
  return { start, end };
}
