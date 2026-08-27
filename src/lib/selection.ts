import type { NodeId, TextAnchor } from "@/types";
import { expandToTerm, resolveRange } from "@/lib/anchor";
import type { NodeMap } from "@/lib/tree";

export interface ReadSelection {
  nodeId: NodeId;
  anchor: TextAnchor;
  rect: { top: number; bottom: number; left: number; right: number };
  /** True when this came from a click rather than a drag. */
  fromClick: boolean;
}

/**
 * Read the live DOM selection and resolve it to a source anchor on whichever
 * message it landed in. Returns null when the selection is outside any message,
 * empty, or spans two different messages — a cross-message anchor has no
 * meaning, since offsets index one node's raw markdown.
 */
export function readSelection(nodes: NodeMap): ReadSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const startMessage = closestMessage(range.startContainer);
  if (!startMessage) return null;
  if (!range.collapsed && closestMessage(range.endContainer) !== startMessage) {
    return null;
  }

  const nodeId = startMessage.getAttribute("data-node-id");
  if (!nodeId) return null;
  const source = nodes[nodeId]?.content;
  if (source === undefined) return null;

  // The first `.md` root is the authoritative one. While the crop rail is
  // hovered the discarded tail is rendered as a *second* root over a sliced
  // source, whose offsets are relative to the slice — requiring containment in
  // the first root is what keeps a selection there from resolving to a wrong
  // offset rather than to nothing.
  const root = startMessage.querySelector(".md");
  if (!root || !root.contains(range.startContainer)) return null;

  const resolved = range.collapsed
    ? expandToTerm(range, root, source)
    : resolveRange(range, root, source);
  const anchor = resolved ? trimAnchor(resolved, source) : null;
  if (!anchor || anchor.end <= anchor.start) return null;

  const rect = range.collapsed
    ? rectForAnchor(root, anchor) ?? range.getBoundingClientRect()
    : range.getBoundingClientRect();

  return {
    nodeId,
    anchor: {
      start: anchor.start,
      end: anchor.end,
      text: anchor.text,
      blockPath: anchor.blockPath,
    },
    rect: {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    },
    fromClick: range.collapsed,
  };
}

/**
 * Drag selections routinely pick up a leading or trailing space, which then
 * shows up at the head of an isolated payload. Trimming in source coordinates
 * keeps `text === source.slice(start, end)` true, which a naive
 * `text.trim()` would break.
 */
function trimAnchor<T extends { start: number; end: number; text: string }>(
  anchor: T,
  source: string,
): T {
  let { start, end } = anchor;
  while (start < end && /\s/.test(source[start])) start++;
  while (end > start && /\s/.test(source[end - 1])) end--;
  return { ...anchor, start, end, text: source.slice(start, end) };
}

function closestMessage(node: Node): Element | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el) {
    if (el.nodeType === Node.ELEMENT_NODE && (el as Element).hasAttribute("data-node-id")) {
      return el as Element;
    }
    el = el.parentNode;
  }
  return null;
}

/**
 * A DOM Range for a source anchor, by walking the rendered leaves back the
 * other way. Used to position the popover over an expanded term, and to draw
 * the hover underline.
 */
export function rangeForAnchor(
  root: Element,
  anchor: { start: number; end: number },
): Range | null {
  const start = pointForSourceOffset(root, anchor.start, "start");
  const end = pointForSourceOffset(root, anchor.end, "end");
  if (!start || !end) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  return range;
}

function rectForAnchor(root: Element, anchor: { start: number; end: number }): DOMRect | null {
  const range = rangeForAnchor(root, anchor);
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/**
 * Inverse of the leaf map: find the rendered text node and offset that a source
 * offset falls on. Reads the same `data-src-start`/`data-src-end` attributes the
 * renderer emitted, so it cannot disagree with the forward direction.
 */
function pointForSourceOffset(
  root: Element,
  sourceOffset: number,
  edge: "start" | "end",
): { node: Node; offset: number } | null {
  const leaves = [...root.querySelectorAll("[data-leaf-index]")];
  let best: { node: Node; offset: number } | null = null;

  for (const leaf of leaves) {
    const srcStart = Number(leaf.getAttribute("data-src-start"));
    const srcEnd = Number(leaf.getAttribute("data-src-end"));
    if (!Number.isFinite(srcStart) || !Number.isFinite(srcEnd)) continue;
    if (sourceOffset < srcStart) break;
    if (sourceOffset > srcEnd) continue;

    const text = leaf.textContent ?? "";
    // The leaf's source span may include markup (backticks, asterisks), so clamp
    // the proportional position into the rendered range rather than assuming a
    // 1:1 mapping.
    const within = Math.max(0, Math.min(sourceOffset - srcStart, text.length));
    const point = textPointIn(leaf, within);
    if (point) best = point;
    if (sourceOffset <= srcEnd && edge === "start") return best;
  }
  return best;
}

function textPointIn(leaf: Element, offset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last: Node | null = null;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
    last = node;
    node = walker.nextNode();
  }
  return last ? { node: last, offset: last.textContent?.length ?? 0 } : null;
}
