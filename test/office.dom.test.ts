// @vitest-environment jsdom
/**
 * Word and PowerPoint files read as Markdown when attached (P-45). The files
 * are built here, part by part, so each case shows the XML it is about.
 */
import { describe, expect, it } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { Zip, ZipError, resolvePart } from "@/lib/convert/zip";
import { docxToMarkdown } from "@/lib/convert/docx";
import { pptxToMarkdown } from "@/lib/convert/pptx";
import { officeKindOf } from "@/lib/attachments";

/** A zip of these parts, deflated except where a name ends in `!stored`. */
function zip(parts: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [rawName, content] of Object.entries(parts)) {
    const stored = rawName.endsWith("!stored");
    const name = Buffer.from(rawName.replace("!stored", ""));
    const data = Buffer.from(typeof content === "string" ? enc.encode(content) : content);
    const body = stored ? data : deflateRawSync(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
const ROOT = rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`);
const p = (inner: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${inner}</w:p>`;
const r = (text: string, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const pic = (id: string) => `<w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="${id}"/></a:graphicData></a:graphic></w:drawing></w:r>`;

function docx(body: string, extra: Record<string, string | Uint8Array> = {}) {
  return zip({
    "_rels/.rels": ROOT,
    "word/document.xml": `<w:document ${W}><w:body>${body}</w:body></w:document>`,
    "word/_rels/document.xml.rels": rels(
      `<Relationship Id="rLink" Type="${REL}/hyperlink" Target="https://example.com/a" TargetMode="External"/>` +
        `<Relationship Id="rPic" Type="${REL}/image" Target="media/image1.png"/>` +
        `<Relationship Id="rEmf" Type="${REL}/image" Target="media/image2.emf"/>`,
    ),
    "word/styles.xml": `<w:styles ${W}>
      <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
      <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`,
    "word/numbering.xml": `<w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    "word/media/image1.png!stored": PNG,
    "word/media/image2.emf": new Uint8Array([1, 2]),
    ...extra,
  });
}

describe("the zip reader", () => {
  it("reads stored and deflated parts by name, and refuses what is not a zip", async () => {
    const z = new Zip(zip({ "a.txt": "deflated text", "b.bin!stored": new Uint8Array([7, 8]) }));
    expect(z.names()).toEqual(["a.txt", "b.bin"]);
    expect(await z.textOf("a.txt")).toBe("deflated text");
    expect(await z.bytesOf("b.bin")).toEqual(new Uint8Array([7, 8]));
    expect(await z.bytesOf("missing")).toBeNull();
    expect(() => new Zip(new TextEncoder().encode("just text, not a zip"))).toThrow(ZipError);
  });

  it("resolves a relationship target against the part that names it", () => {
    expect(resolvePart("ppt/slides/slide1.xml", "../media/image1.png")).toBe("ppt/media/image1.png");
    expect(resolvePart("word/document.xml", "media/a.png")).toBe("word/media/a.png");
    expect(resolvePart("", "word/document.xml")).toBe("word/document.xml");
    expect(resolvePart("x/y.xml", "/abs/z.xml")).toBe("abs/z.xml");
  });
});

describe("a Word document", () => {
  it("reads as Markdown: headings by style name, lists by numbering, emphasis, links", async () => {
    const out = await docxToMarkdown(
      docx(
        p(r("Report"), `<w:pStyle w:val="Title"/>`) +
          p(r("Background"), `<w:pStyle w:val="1"/>`) +
          p(r("Details"), `<w:pStyle w:val="Heading2"/>`) +
          p(r("Plain ") + r("bold", "<w:b/>") + r(" and ") + r("italic", "<w:i/>") + r(" and ") + r("not bold", `<w:b w:val="0"/>`)) +
          p(`<w:hyperlink r:id="rLink">${r("a link")}</w:hyperlink>`) +
          p(r("first"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>`) +
          p(r("inner"), `<w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr>`) +
          p(r("second"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>`) +
          p("") +
          p(r("After the list.")),
      ),
    );
    expect(out.text).toBe(
      [
        "# Report",
        "# Background",
        "## Details",
        "Plain **bold** and *italic* and not bold",
        "[a link](https://example.com/a)",
        "1. first\n   - inner\n1. second",
        "After the list.",
      ].join("\n\n"),
    );
    expect(out.images).toEqual([]);
    expect(out.note).toBeUndefined();
  });

  it("reads what a reader sees: tracked deletions out, insertions in, tables as tables", async () => {
    const cell = (text: string) => `<w:tc>${p(r(text))}</w:tc>`;
    const out = await docxToMarkdown(
      docx(
        p(r("Kept ") + `<w:del><w:r><w:delText>gone </w:delText></w:r></w:del>` + `<w:ins>${r("added")}</w:ins>`) +
          `<w:tbl><w:tr>${cell("Name")}${cell("Value")}</w:tr><w:tr>${cell("a|b")}${cell("2")}</w:tr></w:tbl>`,
      ),
    );
    expect(out.text).toBe("Kept added\n\n| Name | Value |\n| --- | --- |\n| a\\|b | 2 |");
  });

  it("names its pictures in order, sends those the model can take, and says which it cannot", async () => {
    const out = await docxToMarkdown(docx(p(r("See ") + pic("rPic") + pic("rEmf") + pic("rPic"))));
    expect(out.text).toBe("See [image 1: image1.png][picture not sent: image2.emf][image 1: image1.png]");
    expect(out.images).toEqual([{ name: "image1.png", mediaType: "image/png", bytes: PNG }]);
    expect(out.note).toBe("Pictures saved as EMF cannot be sent and were left out.");
  });
});

const P = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}"`;
const sp = (ph: string | null, paras: string) =>
  `<p:sp><p:nvSpPr><p:nvPr>${ph === null ? "" : `<p:ph${ph ? ` type="${ph}"` : ""}/>`}</p:nvPr></p:nvSpPr><p:txBody>${paras}</p:txBody></p:sp>`;
const ap = (text: string, lvl = 0, props = "") =>
  `<a:p><a:pPr${lvl ? ` lvl="${lvl}"` : ""}>${props}</a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
const slide = (tree: string) => `<p:sld ${P}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`;

describe("a PowerPoint deck", () => {
  it("reads slide by slide in the deck's order: title, points, tables, pictures, notes", async () => {
    const out = await pptxToMarkdown(
      zip({
        "_rels/.rels": rels(`<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>`),
        "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>`,
        "ppt/_rels/presentation.xml.rels": rels(
          `<Relationship Id="rA" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rB" Type="${REL}/slide" Target="slides/slide2.xml"/>`,
        ),
        "ppt/slides/slide2.xml": slide(
          sp("ctrTitle", ap("Prompt caching")) +
            sp("", ap("Prefixes are cached") + ap("byte for byte", 1)) +
            sp(null, ap("a free text box")) +
            sp("sldNum", ap("1")) +
            `<p:pic><p:blipFill><a:blip r:embed="rImg"/></p:blipFill></p:pic>`,
        ),
        "ppt/slides/_rels/slide2.xml.rels": rels(
          `<Relationship Id="rImg" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rN" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>`,
        ),
        "ppt/notesSlides/notesSlide1.xml": slide(sp("sldImg", "") + sp("body", ap("Say why it matters."))),
        "ppt/slides/slide1.xml": slide(
          `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody>${ap("k")}</a:txBody></a:tc><a:tc><a:txBody>${ap("v")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
        ),
        "ppt/media/image1.png!stored": PNG,
      }),
    );
    expect(out.text).toBe(
      [
        "## Slide 1: Prompt caching",
        "- Prefixes are cached\n  - byte for byte",
        "a free text box",
        "[image 1: image1.png]",
        "Notes:\nSay why it matters.",
        "## Slide 2",
        "| k | v |\n| --- | --- |",
      ].join("\n\n"),
    );
    expect(out.images.map((i) => i.name)).toEqual(["image1.png"]);
  });
});

describe("which files are Office files", () => {
  it("knows them by type or name, and names the old formats only to refuse them", () => {
    expect(officeKindOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x")).toBe("docx");
    expect(officeKindOf("", "Deck.PPTX")).toBe("pptx");
    expect(officeKindOf("application/msword", "old.doc")).toBe("legacy");
    expect(officeKindOf("text/plain", "notes.txt")).toBeNull();
  });
});
