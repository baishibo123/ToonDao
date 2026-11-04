import type { OfficeKind } from "@/types";
import { docxToMarkdown } from "./docx";
import { pptxToMarkdown } from "./pptx";
import type { Converted } from "./ooxml";

/**
 * Office files turned into text when they are attached (P-45). Loaded with
 * `import()` only when such a file is added, so the app's first load does not
 * carry it.
 */
export async function convertOffice(kind: OfficeKind, bytes: Uint8Array): Promise<Converted> {
  return kind === "docx" ? docxToMarkdown(bytes) : pptxToMarkdown(bytes);
}

export type { Converted, ConvertedImage } from "./ooxml";
