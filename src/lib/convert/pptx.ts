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
 * A PowerPoint deck as Markdown (P-45): one section per slide in the deck's
 * own order, its title as the heading, its text as bullets and paragraphs,
 * tables as tables, pictures named where they stand, and the speaker notes
 * after it — they are often where a deck's explanation is.
 */
export async function pptxToMarkdown(bytes: Uint8Array): Promise<Converted> {
  const zip = new Zip(bytes);
  const part = await mainPart(zip, "ppt/presentation.xml");
  const xml = await zip.textOf(part);
  if (!xml) throw new Error("This .pptx has no presentation in it.");
  const rels = await readRels(zip, part);
  const pictures = new PictureBox(zip);

  const slides = kids(kid(parseXml(xml), "sldIdLst"), "sldId")
    .map((s) => rels.get(relId(s) ?? ""))
    .filter((rel): rel is Rel => Boolean(rel && !rel.external));

  const sections: string[] = [];
  for (const [i, rel] of slides.entries()) {
    const slideXml = await zip.textOf(rel.target);
    if (!slideXml) continue;
    const slideRels = await readRels(zip, rel.target);
    const tree = kid(kid(parseXml(slideXml), "cSld"), "spTree");
    const shapes = { title: "", body: [] as string[] };
    await readShapes(tree, slideRels, pictures, shapes);

    const notes = [...slideRels.values()].find((r) => r.type.endsWith("/notesSlide"));
    const notesText = notes ? await notesOf(zip, notes.target) : "";

    const heading = `## Slide ${i + 1}${shapes.title ? `: ${shapes.title}` : ""}`;
    sections.push(
      [heading, ...shapes.body, ...(notesText ? [`Notes:\n${notesText}`] : [])].join("\n\n"),
    );
  }
  const note = pictures.note();
  return { text: sections.join("\n\n"), images: pictures.images, ...(note ? { note } : {}) };
}

const TITLES = new Set(["title", "ctrTitle"]);
/** Placeholders whose paragraphs are a slide's points; a free text box is prose. */
const BULLETED = new Set(["body", "obj", ""]);

async function readShapes(
  tree: Element | null,
  rels: Map<string, Rel>,
  pictures: PictureBox,
  out: { title: string; body: string[] },
): Promise<void> {
  for (const el of kids(tree)) {
    switch (el.localName) {
      case "sp": {
        const placeholder = kid(kid(kid(el, "nvSpPr"), "nvPr"), "ph");
        const type = placeholder ? (attr(placeholder, "type") ?? "") : null;
        if (type === "sldNum" || type === "dt" || type === "ftr") break;
        const body = kid(el, "txBody");
        if (!body) break;
        if (type !== null && TITLES.has(type)) {
          const title = paragraphs(body, false).join(" ").replace(/\s+/g, " ").trim();
          if (title) out.title = out.title ? `${out.title} — ${title}` : title;
          break;
        }
        const lines = paragraphs(body, type !== null && BULLETED.has(type));
        if (lines.length) out.body.push(lines.join("\n"));
        break;
      }
      case "grpSp":
        await readShapes(el, rels, pictures, out);
        break;
      case "graphicFrame":
        for (const tbl of descendants(el, "tbl")) {
          const rows = kids(tbl, "tr").map((tr) =>
            kids(tr, "tc").map((tc) => paragraphs(kid(tc, "txBody"), false).join(" ")),
          );
          if (rows.length) out.body.push(markdownTable(rows));
        }
        break;
      case "pic":
        for (const blip of descendants(el, "blip")) {
          const rel = rels.get(attr(blip, "embed") ?? "");
          const name = rel && !rel.external ? await pictures.add(rel.target) : null;
          if (name) out.body.push(name);
        }
        break;
    }
  }
}

/** A text body's paragraphs, as bullets indented by level where the shape lists points. */
function paragraphs(body: Element | null, bulleted: boolean): string[] {
  const lines: string[] = [];
  for (const p of kids(body, "p")) {
    const segments: Array<{ text: string; bold: boolean; italic: boolean }> = [];
    for (const child of kids(p)) {
      if (child.localName === "r" || child.localName === "fld") {
        const props = kid(child, "rPr");
        const flag = (name: string) => ["1", "true"].includes(attr(props, name) ?? "");
        segments.push({ text: kid(child, "t")?.textContent ?? "", bold: flag("b"), italic: flag("i") });
      } else if (child.localName === "br") {
        segments.push({ text: "\n", bold: false, italic: false });
      }
    }
    const text = emphasised(segments).trim();
    if (!text) continue;
    const props = kid(p, "pPr");
    const level = Number(attr(props, "lvl") ?? "0");
    const marked = (bulleted && !kid(props, "buNone")) || Boolean(kid(props, "buChar") || kid(props, "buAutoNum"));
    const indent = "  ".repeat(level);
    lines.push(marked ? `${indent}- ${text.replace(/\n/g, `\n${indent}  `)}` : text);
  }
  return lines;
}

/** A slide's speaker notes: the notes page's body placeholder. */
async function notesOf(zip: Zip, part: string): Promise<string> {
  const xml = await zip.textOf(part);
  if (!xml) return "";
  const tree = kid(kid(parseXml(xml), "cSld"), "spTree");
  const texts: string[] = [];
  for (const sp of descendants(tree ?? parseXml(xml), "sp")) {
    const ph = kid(kid(kid(sp, "nvSpPr"), "nvPr"), "ph");
    if (attr(ph, "type") !== "body") continue;
    texts.push(...paragraphs(kid(sp, "txBody"), false));
  }
  return texts.join("\n").trim();
}
