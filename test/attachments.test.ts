/**
 * Files attached to a question (P-43): read once, carried with their turn,
 * placed beside its text by each adapter, and admitted by the bridge only in
 * the shapes it can pass to Claude Code.
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binaryKindOf,
  countPdfPages,
  decodeText,
  fenced,
  attachmentLabel,
  toBase64,
} from "@/lib/attachments";
import { attachmentTokens, estimateMessageTokens } from "@/lib/tokens";
import { assembleContext, formatPayload } from "@/lib/assembleContext";
import { claudeContent, openAIContent } from "@/providers/content";
import { decodeContent } from "@/lib/bridgeProtocol";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import { startBridge, DEFAULT_ORIGINS } from "../bridge/claude-code.ts";
import { buildBundle, parseBundle } from "@/lib/transfer";
import { DEFAULT_SETTINGS } from "@/db/db";
import type { Attachment } from "@/types";
import { TreeFixture } from "./helpers";

const T = DEFAULT_TEMPLATES;
const bytes = (s: string) => new TextEncoder().encode(s);

const image: Attachment = {
  id: "f1", kind: "image", name: "arch.png", mediaType: "image/png", bytes: 2048, data: "iVBORw0KGgo=", width: 1200, height: 800,
};
const pdf: Attachment = {
  id: "f2", kind: "pdf", name: "paper.pdf", mediaType: "application/pdf", bytes: 300_000, data: "JVBERi0=", pages: 3,
};
const notes: Attachment = {
  id: "f3", kind: "text", name: "notes.ts", mediaType: "text/plain", bytes: 30, data: "const x = 1;\n```\n",
};

describe("reading a file", () => {
  it("knows an image or a PDF by its type or name; anything else is text only if its bytes are", () => {
    expect(binaryKindOf("image/png", "a")).toBe("image");
    expect(binaryKindOf("image/svg+xml", "a.svg")).toBeNull();
    expect(binaryKindOf("", "Paper.PDF")).toBe("pdf");
    expect(decodeText(bytes("﻿hello 你好"))).toBe("hello 你好");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(decodeText(bytes("a\u0000b"))).toBeNull();
  });

  it("counts a PDF's pages, not its page tree", () => {
    const doc = "<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>";
    expect(countPdfPages(bytes(doc))).toBe(2);
    expect(countPdfPages(bytes("no pages here"))).toBeUndefined();
  });

  it("encodes base64 in chunks, so a large file does not overflow the stack", () => {
    const big = new Uint8Array(200_000).fill(65);
    expect(toBase64(big)).toBe(btoa("A".repeat(200_000)));
  });

  it("fences a text file longer than any backtick run inside it", () => {
    expect(fenced("const x = 1;\n```\n", "notes.ts")).toBe("````ts\nconst x = 1;\n```\n````");
    expect(fenced("plain", "README")).toBe("```\nplain\n```");
  });

  it("names a file without its contents, and estimates what it costs", () => {
    expect(attachmentLabel(image)).toBe("[image: arch.png · 1200×800 · 2 KB]");
    expect(attachmentLabel(pdf)).toBe("[pdf: paper.pdf · 3 pages · 300 KB]");
    expect(attachmentTokens(image)).toBe(1280);
    expect(attachmentTokens(pdf)).toBe(6000);
    expect(estimateMessageTokens([{ role: "user", content: "", attachments: [image] }])).toBe(1284);
  });
});

describe("a turn's files go where the turn goes whole", () => {
  it("rides with its question on every later turn of the thread, text files written in before the ask", () => {
    const t = new TreeFixture();
    const u = t.add("user", "What does this diagram show?", null);
    u.attachments = [image, notes];
    const a = t.add("assistant", "A bridge.", u.id);
    const next = t.add("user", "And the arrow?", a.id);
    const msgs = assembleContext(next, t, T);
    expect(msgs[0]?.attachments).toEqual([image]);
    expect(msgs[0]?.content).toBe(`Attached file: notes.ts\n\n${fenced(notes.data, notes.name)}\n\nWhat does this diagram show?`);
    expect(msgs[2]).toEqual({ role: "user", content: "And the arrow?" });
  });

  it("is left behind by a departure, which carries carved-out text; the departure's own files go with it", () => {
    const t = new TreeFixture();
    const u = t.add("user", "Read this paper", null);
    u.attachments = [pdf, notes];
    const a = t.add("assistant", "It argues that caching matters.", u.id);
    const lens = t.add("user", "caching", a.id, { kind: "windowed", turns: 1, upToNodeId: a.id }, "concept-lens");
    let msgs = assembleContext(lens, t, T);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.attachments).toBeUndefined();
    expect(msgs[0]?.content).not.toContain("notes.ts");

    lens.attachments = [image];
    msgs = assembleContext(lens, t, T);
    expect(msgs[0]?.attachments).toEqual([image]);
    // A later turn in the aside re-sends the aside's opening, files and all.
    const r = t.add("assistant", "It is…", lens.id);
    const later = t.add("user", "more", r.id);
    expect(assembleContext(later, t, T)[0]?.attachments).toEqual([image]);
  });

  it("is named in the record of what was sent, never copied into it", () => {
    const preview = formatPayload([{ role: "user", content: "Look", attachments: [image] }]);
    expect(preview).toBe("### user\n[image: arch.png · 1200×800 · 2 KB]\nLook");
  });
});

describe("an export", () => {
  it("carries a question's files and brings them back whole; a broken one is dropped", () => {
    const t = new TreeFixture();
    const u = t.add("user", "Look", null);
    u.attachments = [image, pdf, notes, { kind: "image", name: "half.png" } as unknown as Attachment];
    const conversation = { id: t.conversationId, title: "Files", createdAt: 1, updatedAt: 2, rootId: u.id, activeNodeId: u.id };
    const bundle = buildBundle({ conversations: [conversation], nodes: t.all(), templates: T, settings: DEFAULT_SETTINGS });
    const back = parseBundle(JSON.stringify(bundle)).nodes[0];
    expect(back?.attachments).toEqual([image, pdf, notes]);
  });
});

describe("each adapter places the files beside the text", () => {
  it("leaves a message without files a plain string, so the cache still matches it", () => {
    expect(claudeContent({ role: "user", content: "hi" })).toBe("hi");
    expect(openAIContent({ role: "user", content: "hi" })).toBe("hi");
  });

  it("puts files first, and sends no empty text block for a file alone", () => {
    expect(claudeContent({ role: "user", content: "What is it?", attachments: [image, pdf] })).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.data }, title: "paper.pdf" },
      { type: "text", text: "What is it?" },
    ]);
    expect(openAIContent({ role: "user", content: " ", attachments: [image, pdf] })).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
      { type: "file", file: { filename: "paper.pdf", file_data: `data:application/pdf;base64,${pdf.data}` } },
    ]);
  });
});

describe("the bridge admits a question's files", () => {
  it("only as base64 images and PDFs", () => {
    const blocks = claudeContent({ role: "user", content: "x", attachments: [image, pdf] });
    expect(decodeContent(blocks)).toEqual(blocks);
    expect(decodeContent([{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }])).toBeNull();
    expect(decodeContent([{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "AA==" } }])).toBeNull();
    expect(decodeContent([{ type: "image", source: { type: "base64", media_type: "image/png", data: "not base64!" } }])).toBeNull();
    expect(decodeContent([{ type: "tool_result", content: "x" }])).toBeNull();
    expect(decodeContent([])).toBeNull();
  });

  it("and hands them to Claude Code on stdin, files before the text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toondao-files-"));
    const bin = join(dir, "fake-claude");
    await writeFile(bin, `#!/bin/sh\ncat > '${join(dir, "stdin")}'\n`);
    await chmod(bin, 0o755);
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const server = startBridge({ port, allowedOrigins: DEFAULT_ORIGINS, allowedTools: [], claudeBin: bin });
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "haiku",
          stream: true,
          messages: [{ role: "user", content: claudeContent({ role: "user", content: "What is it?", attachments: [image] }) }],
          toondao: { toolScope: "none" },
        }),
      });
      await res.text();
      const line = JSON.parse(await readFile(join(dir, "stdin"), "utf8"));
      expect(line.message.content).toEqual([
        { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
        { type: "text", text: "What is it?" },
      ]);

      const refused = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "haiku",
          stream: true,
          messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }],
        }),
      });
      expect(refused.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
