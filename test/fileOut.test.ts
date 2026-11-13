/**
 * Saving out of a reply (P-53). The claims: a block is saved under the name
 * the model gave it, and only a name that cannot leave its folder; a reply's
 * named blocks make a zip any unzip tool reads, with a revised file saved once.
 */
import { describe, expect, it } from "vitest";
import { baseName, crc32, fileNameFor, namedFiles, namedPath, safePath, zipFiles } from "@/lib/fileOut";
import { Zip } from "@/lib/convert/zip";

describe("the name a block is saved under", () => {
  it("is read from the fence, in the forms models write it", () => {
    expect(namedPath("python", "scripts/fetch.py")).toBe("scripts/fetch.py");
    expect(namedPath("ts", 'title="src/app.ts"')).toBe("src/app.ts");
    expect(namedPath("ts", "filename=app.ts {1,3}")).toBe("app.ts");
    expect(namedPath("python:main.py", null)).toBe("main.py");
    expect(namedPath("main.py", null)).toBe("main.py");
    expect(namedPath("dockerfile", "Dockerfile")).toBe("Dockerfile");
    expect(namedPath("md", "docs/说明.md")).toBe("docs/说明.md");
  });

  it("is none for a block that names no file", () => {
    expect(namedPath("python", null)).toBeNull();
    expect(namedPath("ts", "{1,3}")).toBeNull();
    expect(namedPath("bash", "run this")).toBeNull();
    expect(namedPath(null, null)).toBeNull();
  });

  it("falls back to the language's extension", () => {
    expect(fileNameFor("python", null)).toBe("snippet.py");
    expect(fileNameFor("TypeScript", null)).toBe("snippet.ts");
    expect(fileNameFor("brainfuck", null)).toBe("snippet.txt");
    expect(fileNameFor(null, null)).toBe("snippet.txt");
    expect(fileNameFor("python", "scripts/fetch.py")).toBe("fetch.py");
  });

  it("never leaves the folder it is saved in", () => {
    expect(safePath("../../etc/passwd")).toBe("etc/passwd");
    expect(safePath("/abs/x.sh")).toBe("abs/x.sh");
    expect(safePath("C:\\\\Users\\\\x.bat")).toBe("Users/x.bat");
    expect(safePath("a/./b//c.txt")).toBe("a/b/c.txt");
    expect(safePath("..")).toBeNull();
    expect(namedPath("sh", "../evil.sh")).toBe("evil.sh");
  });

  it("names a reply after its conversation, without characters files refuse", () => {
    expect(baseName('What is a "race": condition?')).toBe("What is a race condition");
    expect(baseName("  ")).toBe("reply");
  });
});

const REPLY = [
  "Two files:",
  "",
  "```python app/main.py",
  "print('v1')",
  "```",
  "",
  "- inside a list:",
  "",
  "  ```toml pyproject.toml",
  "  [project]",
  "  ```",
  "",
  "```bash",
  "python app/main.py",
  "```",
  "",
  "On second thought:",
  "",
  "```python app/main.py",
  "print('v2')",
  "```",
].join("\n");

describe("a reply's files", () => {
  it("are its named blocks, wherever they sit, the later of a revised one kept", () => {
    expect(namedFiles(REPLY)).toEqual([
      { path: "app/main.py", text: "print('v2')" },
      { path: "pyproject.toml", text: "[project]" },
    ]);
  });

  it("zip into an archive that reads back whole", async () => {
    const files = [...namedFiles(REPLY), { path: "docs/说明.md", text: "中文 ✓" }];
    const zip = new Zip(zipFiles(files, new Date(2026, 10, 13, 9, 30)));
    expect(zip.names()).toEqual(["app/main.py", "pyproject.toml", "docs/说明.md"]);
    for (const file of files) expect(await zip.textOf(file.path)).toBe(file.text);
  });

  it("carry a correct checksum", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    const bytes = zipFiles([{ path: "a.txt", text: "hello" }]);
    expect(new DataView(bytes.buffer).getUint32(14, true)).toBe(0x3610a686);
  });
});
