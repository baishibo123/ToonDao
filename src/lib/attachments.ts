import type { Attachment, AttachmentKind, OfficeKind } from "@/types";
import { newId } from "@/lib/id";

/**
 * Files attached to a question (P-43): images, PDFs and text files.
 *
 * A file is turned into an `Attachment` once, when it is picked, and stored on
 * the question's node as it will be sent: an image already shrunk to what the
 * model can see, a PDF as it is, a text file as its text. Everything here but
 * `prepareAttachment()` is pure.
 */

export const ATTACHMENT_LIMITS = {
  /** Claude sees an image at most this many pixels on its long edge; larger is shrunk first. */
  imageEdge: 1568,
  /** 5 MB once base64-encoded, the API's limit for one image. */
  imageBytes: 3_750_000,
  pdfBytes: 10_000_000,
  /** About 100k tokens of text. */
  textBytes: 400_000,
  /** A .docx or .pptx as picked, pictures and all; its text is held to `textBytes`. */
  officeBytes: 30_000_000,
  perMessage: 10,
} as const;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** An attachment, a file that cannot be one (and why), or something said about one that was made. */
export type Prepared = Attachment | { refused: string } | { note: string };

/** An image or a PDF, by its type or name; anything else may still be text, which only its bytes can tell. */
export function binaryKindOf(mediaType: string, name: string): Exclude<AttachmentKind, "text"> | null {
  const type = mediaType.toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (type === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  return null;
}

/** The bytes as text, or null when they are not UTF-8 text (a NUL byte means binary). */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text.replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** A PDF's page count, read from its page objects; undefined when they are hidden in compressed streams. */
export function countPdfPages(bytes: Uint8Array): number | undefined {
  let latin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    latin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const pages = latin.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return pages > 0 ? pages : undefined;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const FENCE_LANGS: Record<string, string> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp",
  cs: "csharp", php: "php", sh: "sh", zsh: "sh", bash: "sh", sql: "sql", html: "html", css: "css",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", md: "markdown", csv: "csv",
  // P-45: an Office file is sent as the Markdown it was converted to.
  docx: "markdown", pptx: "markdown",
};

/** A text file as a fenced block, the fence longer than any run of backticks inside it. */
export function fenced(text: string, name: string): string {
  const ext = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? "";
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${FENCE_LANGS[ext] ?? ""}\n${text.replace(/\n$/, "")}\n${fence}`;
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** One line naming a file without its contents, for the record of what was sent. */
export function attachmentLabel(a: Attachment): string {
  const detail =
    a.convertedFrom
      ? `converted from ${a.convertedFrom}`
      : a.kind === "image" && a.width && a.height
      ? `${a.width}×${a.height}`
      : a.kind === "pdf" && a.pages
        ? `${a.pages} page${a.pages === 1 ? "" : "s"}`
        : null;
  return `[${a.kind}: ${a.name}${detail ? ` · ${detail}` : ""} · ${formatBytes(a.bytes)}]`;
}

/** A picture to show an image attachment with. */
export function attachmentUrl(a: Attachment): string {
  return `data:${a.mediaType};base64,${a.data}`;
}

/* ------------------------------------------------------------------ */
/* Reading a picked file (browser only)                                */
/* ------------------------------------------------------------------ */

/**
 * A picked, pasted or dropped file, as it will be stored and sent — or why it
 * cannot be. Usually one attachment; an Office file becomes its text and its
 * pictures (P-45), with a note when something could not come along.
 */
export async function prepareAttachment(file: File): Promise<Prepared[]> {
  const name = file.name || "pasted";
  const kind = binaryKindOf(file.type, name);
  try {
    if (kind === "image") return [await prepareImage(file, name)];
    if (kind === "pdf") {
      if (file.size > ATTACHMENT_LIMITS.pdfBytes) {
        return [{ refused: `${name} is ${formatBytes(file.size)}; a PDF can be at most ${formatBytes(ATTACHMENT_LIMITS.pdfBytes)}.` }];
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pages = countPdfPages(bytes);
      return [{
        id: newId("f"), kind: "pdf", name, mediaType: "application/pdf", bytes: bytes.length,
        data: toBase64(bytes), ...(pages ? { pages } : {}),
      }];
    }
    const office = officeKindOf(file.type, name);
    if (office === "legacy") {
      return [{ refused: `${name} is an old-style Office file. Save it as .docx or .pptx first, then attach that.` }];
    }
    if (office) return await prepareOffice(file, name, office);
    if (file.size > ATTACHMENT_LIMITS.textBytes) {
      return [{ refused: `${name} is ${formatBytes(file.size)}; a text file can be at most ${formatBytes(ATTACHMENT_LIMITS.textBytes)}.` }];
    }
    const text = decodeText(new Uint8Array(await file.arrayBuffer()));
    if (text === null) {
      return [{ refused: `${name} is not an image, a PDF, a Word or PowerPoint file, or a text file, so it cannot be sent.` }];
    }
    return [{ id: newId("f"), kind: "text", name, mediaType: "text/plain", bytes: file.size, data: text }];
  } catch {
    return [{ refused: `${name} could not be read.` }];
  }
}

/** Word and PowerPoint by type or name; their pre-2007 formats only so they can be named in a refusal. */
export function officeKindOf(mediaType: string, name: string): OfficeKind | "legacy" | null {
  const type = mediaType.toLowerCase();
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(name)) return "docx";
  if (type === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || /\.pptx$/i.test(name)) return "pptx";
  if (/\.(doc|ppt)$/i.test(name) || type === "application/msword" || type === "application/vnd.ms-powerpoint") return "legacy";
  return null;
}

/**
 * An Office file as a text attachment and one image attachment per picture,
 * which keep the order the text numbers them in. The converter is loaded
 * only now, so the app's first load does not carry it.
 */
async function prepareOffice(file: File, name: string, kind: OfficeKind): Promise<Prepared[]> {
  if (file.size > ATTACHMENT_LIMITS.officeBytes) {
    return [{ refused: `${name} is ${formatBytes(file.size)}; a Word or PowerPoint file can be at most ${formatBytes(ATTACHMENT_LIMITS.officeBytes)}.` }];
  }
  const { convertOffice } = await import("@/lib/convert");
  let converted;
  try {
    converted = await convertOffice(kind, new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    return [{ refused: `${name} could not be read: ${err instanceof Error ? err.message : String(err)}` }];
  }
  const bytes = new TextEncoder().encode(converted.text).length;
  if (!converted.text.trim()) return [{ refused: `${name} has no text in it.` }];
  if (bytes > ATTACHMENT_LIMITS.textBytes) {
    return [{ refused: `${name} holds ${formatBytes(bytes)} of text; at most ${formatBytes(ATTACHMENT_LIMITS.textBytes)} can be sent.` }];
  }
  const out: Prepared[] = [
    { id: newId("f"), kind: "text", name, mediaType: "text/markdown", bytes, data: converted.text, convertedFrom: kind },
  ];
  for (const image of converted.images) {
    const picture = new File([image.bytes as BlobPart], `${name} · ${image.name}`, { type: image.mediaType });
    out.push(await prepareImage(picture, picture.name).catch(() => ({ refused: `${picture.name} could not be read.` })));
  }
  if (converted.note) out.push({ note: `${name}: ${converted.note}` });
  return out;
}

/**
 * An image the model can take: kept as it is when it already fits, otherwise
 * drawn smaller (a GIF keeps its animation only when it fits), as PNG where it
 * may be transparent, else JPEG — and as JPEG anyway if a PNG stays too large.
 */
async function prepareImage(file: File, name: string): Promise<Prepared> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const edge = ATTACHMENT_LIMITS.imageEdge;
  if (Math.max(width, height) <= edge && file.size <= ATTACHMENT_LIMITS.imageBytes) {
    bitmap.close();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { id: newId("f"), kind: "image", name, mediaType: file.type, bytes: bytes.length, data: toBase64(bytes), width, height };
  }
  const scale = Math.min(1, edge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const encode = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = file.type === "image/jpeg" ? await encode("image/jpeg", 0.88) : await encode("image/png");
  if (blob && blob.size > ATTACHMENT_LIMITS.imageBytes) blob = await encode("image/jpeg", 0.85);
  if (!blob || blob.size > ATTACHMENT_LIMITS.imageBytes) return { refused: `${name} is too large to send, even shrunk.` };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { id: newId("f"), kind: "image", name, mediaType: blob.type, bytes: bytes.length, data: toBase64(bytes), width: w, height: h };
}
