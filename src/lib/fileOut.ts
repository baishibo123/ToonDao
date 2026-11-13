/**
 * Saving out of a reply (P-53). A code block the model named — ```python
 * scripts/fetch.py — is saved under that name; an unnamed one under a name
 * made from its language; a reply with several named blocks as one .zip that
 * keeps their folders. Everything is made in the browser and handed to its
 * download, so nothing is written anywhere the person did not choose.
 */
import type { Code, RootContent } from "mdast";
import { parseMarkdown } from "@/lib/anchor";

export interface OutFile {
  /** Relative, with `/` between folders, never `..`. */
  path: string;
  text: string;
}

/** A name with no extension that is still plainly a file. */
const BARE_NAMES = new Set(["Makefile", "Dockerfile", "Procfile", "Gemfile", "Rakefile", "Justfile", "LICENSE", "README"]);

const EXTENSIONS: Record<string, string> = {
  python: "py", py: "py", javascript: "js", js: "js", mjs: "mjs", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx",
  bash: "sh", sh: "sh", shell: "sh", zsh: "sh", console: "txt", powershell: "ps1", ps1: "ps1",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "xml", svg: "svg",
  html: "html", css: "css", scss: "scss", markdown: "md", md: "md", sql: "sql", graphql: "graphql",
  rust: "rs", rs: "rs", go: "go", java: "java", kotlin: "kt", kt: "kt", swift: "swift", c: "c", h: "h",
  cpp: "cpp", "c++": "cpp", hpp: "hpp", csharp: "cs", cs: "cs", ruby: "rb", rb: "rb", php: "php", lua: "lua",
  r: "r", scala: "scala", dart: "dart", vue: "vue", svelte: "svelte", latex: "tex", tex: "tex",
  text: "txt", txt: "txt", plaintext: "txt", csv: "csv", diff: "diff", patch: "patch",
};

/**
 * The path a block names, or null. Read from the fence's words after the
 * language — `scripts/fetch.py`, `title="fetch.py"`, `file=fetch.py` — or
 * from the language itself when it is a file (```fetch.py, ```python:fetch.py).
 */
export function namedPath(lang: string | null | undefined, meta: string | null | undefined): string | null {
  const keyed = meta?.match(/\b(?:title|file|filename|path|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  if (keyed) return safePath(keyed[1] ?? keyed[2] ?? keyed[3]);
  const first = meta?.trim().split(/\s+/)[0];
  if (first && looksLikeFile(first)) return safePath(first);
  if (lang?.includes(":")) return safePath(lang.slice(lang.indexOf(":") + 1));
  if (lang && looksLikeFile(lang) && lang.includes(".")) return safePath(lang);
  return null;
}

function looksLikeFile(word: string): boolean {
  const base = word.split("/").pop() ?? "";
  // Letters of any script: a file may well be called 说明.md.
  return /^[\p{L}\p{N}_@+.\-/]+$/u.test(word) && (/\.\w+$/.test(base) || BARE_NAMES.has(base));
}

/**
 * A path that cannot leave the folder it is unpacked in: no root, no drive, no
 * `..`, and only characters every file system takes. Null if nothing is left.
 */
export function safePath(raw: string): string | null {
  const parts = raw
    .replace(/^[A-Za-z]:/, "")
    .split(/[\\/]+/)
    .map((part) => part.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim())
    .filter((part) => part && part !== "." && part !== "..");
  return parts.length ? parts.join("/") : null;
}

/** What a block is saved as when pressed on its own: its name, else `snippet.<ext>`. */
export function fileNameFor(lang: string | null | undefined, meta: string | null | undefined): string {
  const path = namedPath(lang, meta);
  if (path) return path.split("/").pop()!;
  const key = (lang ?? "").toLowerCase().split(":")[0];
  return `snippet.${EXTENSIONS[key] ?? "txt"}`;
}

/**
 * Every named block of a reply, in order of first appearance. A name given
 * twice keeps the later block: a reply that revises a file means the revision.
 */
export function namedFiles(source: string): OutFile[] {
  const files = new Map<string, string>();
  const walk = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === "code") {
        const path = namedPath(node.lang, (node as Code).meta);
        if (path) files.set(path, node.value);
      } else if ("children" in node) {
        walk(node.children as RootContent[]);
      }
    }
  };
  walk(parseMarkdown(source).root.children);
  return [...files].map(([path, text]) => ({ path, text }));
}

/** A conversation's title as a file name, without the characters file systems refuse. */
export function baseName(title: string | undefined, fallback = "reply"): string {
  const clean = (title ?? "").replace(/[\u0000-\u001f\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80).trim();
  return clean || fallback;
}

/** Hands `data` to the browser's download as `name`. */
export function saveFile(name: string, data: string | Blob, type = "text/plain;charset=utf-8"): void {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Revoked once the download has taken it; at once, some browsers lose it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ------------------------------------------------------------------ */
/* A zip of stored (uncompressed) entries                              */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * The files as a zip. Stored, not deflated: a reply's text is small, and every
 * unzip tool reads a stored entry. Names are UTF-8 (flag bit 11).
 */
export function zipFiles(files: OutFile[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const entries = files.map((file) => {
    const name = encoder.encode(file.path);
    const data = encoder.encode(file.text);
    return { name, data, crc: crc32(data) };
  });

  const localSize = entries.reduce((sum, e) => sum + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((sum, e) => sum + 46 + e.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];

  const common = (e: (typeof entries)[number], base: number) => {
    view.setUint16(base, 20, true); // version needed
    view.setUint16(base + 2, 0x0800, true); // UTF-8 names
    view.setUint16(base + 4, 0, true); // stored
    view.setUint16(base + 6, time, true);
    view.setUint16(base + 8, date, true);
    view.setUint32(base + 10, e.crc, true);
    view.setUint32(base + 14, e.data.length, true);
    view.setUint32(base + 18, e.data.length, true);
    view.setUint16(base + 22, e.name.length, true);
    view.setUint16(base + 24, 0, true); // extra
  };

  for (const e of entries) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    common(e, at + 4);
    out.set(e.name, at + 30);
    out.set(e.data, at + 30 + e.name.length);
    at += 30 + e.name.length + e.data.length;
  }

  const centralStart = at;
  entries.forEach((e, i) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by
    common(e, at + 6);
    // comment length, disk, internal and external attributes stay 0
    view.setUint32(at + 42, offsets[i], true);
    out.set(e.name, at + 46);
    at += 46 + e.name.length;
  });

  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
