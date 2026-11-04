import { relsPathOf, resolvePart, type Zip } from "./zip";

/**
 * What Word and PowerPoint files share (P-45): XML parts in a zip, joined by
 * relationship files. Elements are matched by local name, so a producer that
 * picks other namespace prefixes reads the same.
 */

/** A file converted to text, with the pictures it held. */
export interface Converted {
  /** Markdown: headings, lists, tables, emphasis; a picture is named where it stood. */
  text: string;
  images: ConvertedImage[];
  /** What could not come along, said in one sentence; absent when nothing was left out. */
  note?: string;
}

export interface ConvertedImage {
  /** The picture's own file name inside the document, e.g. image1.png. */
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export function parseXml(text: string): Element {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("A part of this file is not valid XML.");
  return doc.documentElement;
}

export function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 1 && (!name || (child as Element).localName === name)) out.push(child as Element);
  }
  return out;
}

export function kid(el: Element | null | undefined, name: string): Element | null {
  return kids(el, name)[0] ?? null;
}

/** Every descendant with this local name, in document order. */
export function descendants(el: Element, name: string): Element[] {
  return Array.from(el.getElementsByTagNameNS("*", name));
}

/** An attribute by local name, whatever its prefix. */
export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === name) return a.value;
  return null;
}

/**
 * The relationship id an element points through (`r:id`). Read by namespace,
 * because some elements also carry an `id` of their own (`<p:sldId id="256"
 * r:id="rId2">`).
 */
export function relId(el: Element | null | undefined): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) {
    if (a.localName === "id" && (a.namespaceURI ?? "").endsWith("/officeDocument/2006/relationships")) return a.value;
  }
  return null;
}

export interface Rel {
  type: string;
  target: string;
  external: boolean;
}

/** A part's relationships by id, internal targets resolved to zip paths. */
export async function readRels(zip: Zip, part: string): Promise<Map<string, Rel>> {
  const rels = new Map<string, Rel>();
  const text = await zip.textOf(relsPathOf(part));
  if (!text) return rels;
  for (const rel of kids(parseXml(text), "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (!id || !target) continue;
    const external = attr(rel, "TargetMode") === "External";
    rels.set(id, { type: attr(rel, "Type") ?? "", target: external ? target : resolvePart(part, target), external });
  }
  return rels;
}

/** The package's main part (word/document.xml, ppt/presentation.xml), from its root relationships. */
export async function mainPart(zip: Zip, fallback: string): Promise<string> {
  const root = await readRels(zip, "");
  for (const rel of root.values()) if (rel.type.endsWith("/officeDocument")) return rel.target;
  return fallback;
}

const PICTURE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/**
 * Collects a document's pictures once each, in the order they appear. A
 * picture in a format the model cannot take (EMF, WMF, TIFF, SVG) is counted,
 * so the note can say so, and named in the text all the same.
 */
export class PictureBox {
  readonly images: ConvertedImage[] = [];
  private readonly seen = new Map<string, string>();
  private unsupported = new Set<string>();

  constructor(private readonly zip: Zip) {}

  /**
   * What stands in the text where the picture was, or null when the part is
   * missing. Pictures are numbered in the order they are sent, which is the
   * only way the model can tell which one the text means: an image block
   * carries no name.
   */
  async add(path: string): Promise<string | null> {
    const known = this.seen.get(path);
    if (known) return known;
    const name = path.split("/").pop() ?? path;
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mediaType = PICTURE_TYPES[ext];
    if (!mediaType) {
      this.unsupported.add(ext || "unknown");
      const mark = `[picture not sent: ${name}]`;
      this.seen.set(path, mark);
      return mark;
    }
    const bytes = await this.zip.bytesOf(path);
    if (!bytes) return null;
    this.images.push({ name, mediaType, bytes });
    const mark = `[image ${this.images.length}: ${name}]`;
    this.seen.set(path, mark);
    return mark;
  }

  note(): string | undefined {
    if (this.unsupported.size === 0) return undefined;
    return `Pictures saved as ${[...this.unsupported].map((e) => e.toUpperCase()).join(", ")} cannot be sent and were left out.`;
  }
}

/** A Markdown table, the first row as its header; cells keep to one line. */
export function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (text: string | undefined) => (text ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim();
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

/** Runs of text with their emphasis, merged and wrapped, so `**a** **b**` reads `**a b**`. */
export function emphasised(segments: Array<{ text: string; bold: boolean; italic: boolean }>): string {
  const merged: typeof segments = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && last.bold === s.bold && last.italic === s.italic) last.text += s.text;
    else merged.push({ ...s });
  }
  return merged
    .map(({ text, bold, italic }) => {
      const mark = `${bold ? "**" : ""}${italic ? "*" : ""}`;
      if (!mark || !text.trim()) return text;
      const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? ["", "", text, ""];
      return `${lead}${mark}${core}${[...mark].reverse().join("")}${trail}`;
    })
    .join("");
}
