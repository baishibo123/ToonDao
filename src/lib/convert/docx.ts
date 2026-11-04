import { Zip } from "./zip";
import {
  PictureBox,
  attr,
  descendants,
  emphasised,
  kid,
  kids,
  mainPart,
  markdownTable,
  parseXml,
  readRels,
  relId,
  type Converted,
  type Rel,
} from "./ooxml";

/**
 * A Word document as Markdown (P-45): paragraphs, headings, numbered and
 * bulleted lists, tables, bold and italic, links, and pictures named where
 * they stood. What it reads is the text a reader sees: tracked deletions and
 * field codes are left out, insertions and field results kept.
 */
export async function docxToMarkdown(bytes: Uint8Array): Promise<Converted> {
  const zip = new Zip(bytes);
  const part = await mainPart(zip, "word/document.xml");
  const xml = await zip.textOf(part);
  if (!xml) throw new Error("This .docx has no document in it.");
  const body = kid(parseXml(xml), "body");
  const ctx: Context = {
    rels: await readRels(zip, part),
    headings: await headingLevels(zip),
    numbering: await listFormats(zip),
    pictures: new PictureBox(zip),
  };

  const blocks: Block[] = [];
  await readBlocks(body, ctx, blocks);
  return { text: joinBlocks(blocks), images: ctx.pictures.images, ...noteOf(ctx.pictures.note()) };
}

interface Context {
  rels: Map<string, Rel>;
  /** Paragraph style id → heading level. */
  headings: Map<string, number>;
  /** numId → level → whether it is numbered (true) or bulleted (false). */
  numbering: Map<string, Map<string, boolean>>;
  pictures: PictureBox;
}

type Block = { kind: "para" | "list"; text: string };

function noteOf(note: string | undefined): { note?: string } {
  return note ? { note } : {};
}

async function readBlocks(container: Element | null, ctx: Context, out: Block[]): Promise<void> {
  for (const el of kids(container)) {
    if (el.localName === "p") {
      const block = await paragraph(el, ctx);
      if (block) out.push(block);
    } else if (el.localName === "tbl") {
      out.push({ kind: "para", text: await table(el, ctx) });
    } else if (el.localName === "sdt") {
      await readBlocks(kid(el, "sdtContent"), ctx, out);
    }
  }
}

async function paragraph(p: Element, ctx: Context): Promise<Block | null> {
  const text = (await inline(p, ctx)).replace(/[ \t]+$/gm, "");
  if (!text.trim()) return null;
  const props = kid(p, "pPr");
  const style = attr(kid(props, "pStyle"), "val") ?? "";
  const outline = attr(kid(props, "outlineLvl"), "val");
  const level = ctx.headings.get(style) ?? (outline !== null ? Number(outline) + 1 : 0);
  if (level > 0) return { kind: "para", text: `${"#".repeat(Math.min(level, 6))} ${text.replace(/\n/g, " ")}` };

  const num = kid(props, "numPr");
  const numId = attr(kid(num, "numId"), "val");
  if (num && numId && numId !== "0") {
    const depth = Number(attr(kid(num, "ilvl"), "val") ?? "0");
    const ordered = ctx.numbering.get(numId)?.get(String(depth)) ?? false;
    const marker = ordered ? "1." : "-";
    // Three spaces a level: enough to nest under "1. " as well as under "- ".
    const indent = " ".repeat(depth * 3);
    return { kind: "list", text: `${indent}${marker} ${text.replace(/\n/g, `\n${indent}   `)}` };
  }
  return { kind: "para", text };
}

/** A paragraph's runs, in order, with what is inside links, insertions and content controls. */
async function inline(el: Element, ctx: Context): Promise<string> {
  const segments: Array<{ text: string; bold: boolean; italic: boolean }> = [];
  const walk = async (node: Element): Promise<void> => {
    for (const child of kids(node)) {
      switch (child.localName) {
        case "r":
          await run(child, ctx, segments);
          break;
        case "hyperlink": {
          const inner = await inline(child, ctx);
          const rel = ctx.rels.get(relId(child) ?? "");
          const href = rel?.external ? rel.target : null;
          segments.push({ text: href && inner.trim() ? `[${inner}](${href})` : inner, bold: false, italic: false });
          break;
        }
        case "ins":
        case "smartTag":
        case "fldSimple":
        case "sdt":
        case "sdtContent":
        case "customXml":
          await walk(child);
          break;
        // `del` (tracked deletions), `pPr` and everything else are not what a reader sees.
      }
    }
  };
  await walk(el);
  return emphasised(segments);
}

async function run(r: Element, ctx: Context, out: Array<{ text: string; bold: boolean; italic: boolean }>) {
  const props = kid(r, "rPr");
  const on = (name: string) => {
    const el = kid(props, name);
    return el !== null && !["0", "false", "off"].includes(attr(el, "val") ?? "");
  };
  const bold = on("b");
  const italic = on("i");
  for (const child of kids(r)) {
    switch (child.localName) {
      case "t":
        out.push({ text: child.textContent ?? "", bold, italic });
        break;
      case "tab":
        out.push({ text: "\t", bold: false, italic: false });
        break;
      case "br":
      case "cr":
        out.push({ text: "\n", bold: false, italic: false });
        break;
      case "drawing":
      case "pict":
      case "object":
        for (const blip of [...descendants(child, "blip"), ...descendants(child, "imagedata")]) {
          const rel = ctx.rels.get(attr(blip, "embed") ?? relId(blip) ?? "");
          const name = rel && !rel.external ? await ctx.pictures.add(rel.target) : null;
          if (name) out.push({ text: name, bold: false, italic: false });
        }
        break;
    }
  }
}

async function table(tbl: Element, ctx: Context): Promise<string> {
  const rows: string[][] = [];
  for (const tr of kids(tbl, "tr")) {
    const cells: string[] = [];
    for (const tc of kids(tr, "tc")) {
      const parts: string[] = [];
      for (const p of kids(tc, "p")) {
        const text = (await inline(p, ctx)).trim();
        if (text) parts.push(text);
      }
      cells.push(parts.join(" "));
    }
    rows.push(cells);
  }
  return markdownTable(rows);
}

/** Blank lines between paragraphs; list items of one list stay together. */
function joinBlocks(blocks: Block[]): string {
  let out = "";
  blocks.forEach((block, i) => {
    if (i > 0) out += block.kind === "list" && blocks[i - 1]!.kind === "list" ? "\n" : "\n\n";
    out += block.text;
  });
  return out;
}

/** Heading styles by id, read from their names ("heading 2", "Title"), which are the same in every language. */
async function headingLevels(zip: Zip): Promise<Map<string, number>> {
  const levels = new Map<string, number>();
  const xml = await zip.textOf("word/styles.xml");
  if (!xml) return levels;
  for (const style of kids(parseXml(xml), "style")) {
    const id = attr(style, "styleId");
    const name = (attr(kid(style, "name"), "val") ?? "").toLowerCase();
    if (!id) continue;
    const heading = name.match(/^heading (\d)$/);
    const outline = attr(kid(kid(style, "pPr"), "outlineLvl"), "val");
    if (heading) levels.set(id, Number(heading[1]));
    else if (name === "title") levels.set(id, 1);
    else if (outline !== null && Number(outline) < 9) levels.set(id, Number(outline) + 1);
  }
  return levels;
}

async function listFormats(zip: Zip): Promise<Map<string, Map<string, boolean>>> {
  const out = new Map<string, Map<string, boolean>>();
  const xml = await zip.textOf("word/numbering.xml");
  if (!xml) return out;
  const root = parseXml(xml);
  const abstract = new Map<string, Map<string, boolean>>();
  for (const a of kids(root, "abstractNum")) {
    const levels = new Map<string, boolean>();
    for (const lvl of kids(a, "lvl")) {
      const format = attr(kid(lvl, "numFmt"), "val") ?? "bullet";
      levels.set(attr(lvl, "ilvl") ?? "0", format !== "bullet" && format !== "none");
    }
    abstract.set(attr(a, "abstractNumId") ?? "", levels);
  }
  for (const num of kids(root, "num")) {
    const levels = abstract.get(attr(kid(num, "abstractNumId"), "val") ?? "");
    if (levels) out.set(attr(num, "numId") ?? "", levels);
  }
  return out;
}
