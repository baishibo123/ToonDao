/**
 * Just enough of the zip format to read an Office file (P-45): the central
 * directory, and entries that are stored or deflated. Inflating uses the
 * platform's own `DecompressionStream`, so there is no dependency.
 *
 * Entries are read one at a time, by name, and only those a converter asks
 * for; each is capped, so a zip bomb fails instead of filling memory.
 */

export class ZipError extends Error {}

interface Entry {
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** No part of an Office file a converter reads comes near this once inflated. */
export const MAX_ENTRY_BYTES = 50_000_000;

export class Zip {
  private readonly entries = new Map<string, Entry>();
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = this.findEnd();
    const count = this.view.getUint16(end + 10, true);
    let at = this.view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (at + 46 > bytes.length || this.view.getUint32(at, true) !== 0x02014b50) {
        throw new ZipError("The file's table of contents is damaged.");
      }
      const nameLength = this.view.getUint16(at + 28, true);
      const extraLength = this.view.getUint16(at + 30, true);
      const commentLength = this.view.getUint16(at + 32, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      this.entries.set(name, {
        method: this.view.getUint16(at + 10, true),
        compressedSize: this.view.getUint32(at + 20, true),
        size: this.view.getUint32(at + 24, true),
        offset: this.view.getUint32(at + 42, true),
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  async bytesOf(name: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.size > MAX_ENTRY_BYTES) throw new ZipError(`${name} is too large to read.`);
    const at = entry.offset;
    if (at + 30 > this.bytes.length || this.view.getUint32(at, true) !== 0x04034b50) {
      throw new ZipError(`${name} is damaged.`);
    }
    const start = at + 30 + this.view.getUint16(at + 26, true) + this.view.getUint16(at + 28, true);
    const data = this.bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data.slice();
    if (entry.method !== 8) throw new ZipError(`${name} uses a compression this app cannot read.`);
    const stream = new Response(data as BodyInit).body!.pipeThrough(new DecompressionStream("deflate-raw"));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    if (out.length > MAX_ENTRY_BYTES) throw new ZipError(`${name} is too large to read.`);
    return out;
  }

  async textOf(name: string): Promise<string | null> {
    const bytes = await this.bytesOf(name);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /** The end-of-central-directory record, searched for backwards past any trailing comment. */
  private findEnd(): number {
    const min = Math.max(0, this.bytes.length - 22 - 0xffff);
    for (let at = this.bytes.length - 22; at >= min; at--) {
      if (this.view.getUint32(at, true) === 0x06054b50) return at;
    }
    throw new ZipError("This is not a zip file, so it is not a .docx or .pptx.");
  }
}

/** `word/_rels/document.xml.rels` for `word/document.xml`. */
export function relsPathOf(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** A relationship target resolved against the folder of the part that names it. */
export function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPart.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== ".") parts.push(piece);
  }
  return parts.join("/");
}
