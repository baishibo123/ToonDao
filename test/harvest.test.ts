/**
 * The harvest: what a project already holds about how it was built, gathered
 * by code for the model to read first (P-28). Sessions are synthetic
 * transcripts in Claude Code's JSONL shape; folders are made in a temp dir.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Harvest,
  type MatchedSession,
  demoteHeadings,
  digestSession,
  errorLine,
  estimateTokens,
  findNotes,
  findSessions,
  gitHistory,
  matchReason,
  projectFiles,
  redact,
  renderHarvest,
} from "../bridge/harvest.ts";

const PROJECT = "/Users/someone/osmo dock ";

function jsonl(...records: object[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

const user = (text: string, at: string, extra: object = {}) => ({
  type: "user",
  timestamp: at,
  cwd: PROJECT,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (text: string, at: string) => ({
  type: "assistant",
  timestamp: at,
  cwd: PROJECT,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolError = (content: string, at: string) => ({
  type: "user",
  timestamp: at,
  cwd: PROJECT,
  message: { role: "user", content: [{ type: "tool_result", is_error: true, content }] },
});

describe("digestSession", () => {
  it("keeps prompts, errors, summaries and each turn's last answer, in order", () => {
    const digest = digestSession(
      jsonl(
        { type: "custom-title", customTitle: "Camera sync" },
        user("Why does the camera drop Wi-Fi?", "2026-09-23T10:00:00Z"),
        assistant("Let me look.", "2026-09-23T10:00:05Z"),
        toolError("Exit code 1\nbuilding…\nerror: no such module 'CoreWLAN'", "2026-09-23T10:00:09Z"),
        assistant("It is the AP mode switch.", "2026-09-23T10:00:30Z"),
        user("This session is being continued from a previous conversation…", "2026-09-23T11:00:00Z"),
        user("And how do we stay online?", "2026-09-23T11:05:00Z"),
        assistant("Use station mode.", "2026-09-23T11:05:10Z"),
      ),
      PROJECT,
      "abcd1234",
    );
    expect(digest.title).toBe("Camera sync");
    expect(digest.items.map((i) => [i.kind, i.text])).toEqual([
      ["prompt", "Why does the camera drop Wi-Fi?"],
      ["error", "Exit code 1: error: no such module 'CoreWLAN'"],
      ["answer", "It is the AP mode switch."],
      ["summary", "This session is being continued from a previous conversation…"],
      ["prompt", "And how do we stay online?"],
      ["answer", "Use station mode."],
    ]);
    expect(digest.records).toBe(7);
    expect(digest.inside).toBe(7);
    expect(digest.first).toBe("2026-09-23T10:00:00Z");
  });

  it("drops harness noise, meta records and subagent records", () => {
    const digest = digestSession(
      jsonl(
        user("<command-name>/compact</command-name>", "t1"),
        user("<local-command-stdout>ok</local-command-stdout>", "t2"),
        user("[Request interrupted by user]", "t3"),
        user("caveat", "t4", { isMeta: true }),
        user("a subagent's prompt", "t5", { isSidechain: true }),
        toolError("<tool_use_error>File has not been read yet</tool_use_error>", "t6"),
      ),
      PROJECT,
    );
    expect(digest.items).toEqual([]);
  });

  it("keeps a prompt typed while Claude was busy, which is stored as an attachment", () => {
    const digest = digestSession(
      jsonl(
        user("first", "t1"),
        assistant("working", "t2"),
        { type: "attachment", timestamp: "t3", attachment: { type: "queued_command", prompt: "also check the BLE side" } },
      ),
      PROJECT,
    );
    expect(digest.items.map((i) => i.text)).toEqual(["first", "working", "also check the BLE side"]);
  });

  it("drops a background subagent's report, which is queued the same way but marked meta", () => {
    const report = {
      type: "attachment",
      timestamp: "t3",
      attachment: {
        type: "queued_command",
        isMeta: true,
        origin: { kind: "peer", name: "general-purpose" },
        prompt: '<agent-message from="a66fa281">\n[Subagent hand-back] The text below is the final report of a subagent.\n  The BLE side is fine.\n</agent-message>',
      },
    };
    const digest = digestSession(
      jsonl(user("first", "t1"), assistant("working", "t2"), report, assistant("done", "t4")),
      PROJECT,
    );
    // Not a prompt, and not a turn boundary: the answer is still the turn's last text.
    expect(digest.items.map((i) => [i.kind, i.text])).toEqual([
      ["prompt", "first"],
      ["answer", "done"],
    ]);
  });

  it("falls back to the generated title when the session was never renamed", () => {
    expect(digestSession(jsonl({ type: "ai-title", aiTitle: "Wi-Fi debugging" }), PROJECT).title).toBe(
      "Wi-Fi debugging",
    );
  });
});

describe("errorLine", () => {
  it("keeps a plain first line, and names what failed after a bare exit code", () => {
    expect(errorLine("ENOENT: no such file")).toBe("ENOENT: no such file");
    expect(errorLine("Exit code 2\nline one\nfatal: not a git repository")).toBe(
      "Exit code 2: fatal: not a git repository",
    );
    expect(errorLine("Exit code 1\nonly this")).toBe("Exit code 1: only this");
    expect(errorLine("<tool_use_error>noise</tool_use_error>")).toBe("");
  });
});

describe("matchReason", () => {
  const base = digestSession("", PROJECT);
  it("matches a session that started in the project or one of its worktrees", () => {
    expect(matchReason({ ...base, cwd: PROJECT }, PROJECT)).toBe("started in the project");
    expect(matchReason({ ...base, cwd: `${PROJECT}/.claude/worktrees/x` }, PROJECT)).toBe("started in the project");
  });
  it("matches long stays and heavy mentions, and not a passing visit", () => {
    expect(matchReason({ ...base, cwd: "/elsewhere", records: 50, inside: 20 }, PROJECT)).toMatch(/20 of 50/);
    expect(matchReason({ ...base, cwd: "/elsewhere", mentions: 200 }, PROJECT)).toMatch(/200 lines/);
    expect(matchReason({ ...base, cwd: "/elsewhere", inside: 3, mentions: 40 }, PROJECT)).toBeNull();
  });
  it("does not mistake a sibling folder with a longer name for the project", () => {
    expect(matchReason({ ...base, cwd: "/Users/someone/osmo dock 2" }, "/Users/someone/osmo dock")).toBeNull();
  });
});

describe("redact", () => {
  it("removes keys and assigned passwords", () => {
    expect(redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe("key [REDACTED-KEY]");
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toContain("[REDACTED");
    expect(redact("psw: hunter2!x")).toBe("psw: [REDACTED]");
    expect(redact("相机密码是 Abc_12345")).toBe("相机密码是 [REDACTED]");
    expect(redact("SSID `HOME`, password `s3cret-pass`")).toBe("SSID `HOME`, password [REDACTED]");
  });

  it("leaves Chinese prose after 密码 alone — it is what such a project teaches", () => {
    const prose = "用蓝牙读 Wi-Fi 密码、再握手；密码，全部只读";
    expect(redact(prose)).toBe(prose);
  });
});

describe("demoteHeadings", () => {
  it("pushes a note's headings below the note's title, but not inside code fences", () => {
    expect(demoteHeadings("# Title\n## Part\n```sh\n# a shell comment\n```")).toBe(
      "#### Title\n##### Part\n```sh\n# a shell comment\n```",
    );
  });
});

describe("the project's own files", () => {
  function folder(): string {
    const root = mkdtempSync(join(tmpdir(), "harvest-test-"));
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put("README.md", "# Demo\n\nWhat it does.");
    put("docs/decisions.md", "## ADR-001: Use SwiftPM\n");
    put("src/main.swift", "print(1)\n");
    put("node_modules/pkg/README.md", "someone else's");
    put("research/upstream/.git/HEAD", "ref: refs/heads/main\n");
    put("research/upstream/README.md", "someone else's repository");
    put("traces/run1.md", "passphrase capture");
    put(".gitignore", "traces/\n");
    return root;
  }

  it("without git, walks the folder but skips dependencies and nested repositories", async () => {
    const root = folder();
    const files = await projectFiles(root);
    expect(files).toContain("README.md");
    expect(files).toContain("src/main.swift");
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.startsWith("research/"))).toBe(false);
  });

  it("in a git repository, never lists what git ignores", async () => {
    const root = folder();
    execFileSync("git", ["init", "-q"], { cwd: root });
    const files = await projectFiles(root);
    expect(files).toContain("docs/decisions.md");
    expect(files.some((f) => f.startsWith("traces/"))).toBe(false);
  });

  it("finds the notes, README first and decisions before the rest", async () => {
    const root = folder();
    const notes = await findNotes(root, await projectFiles(root));
    expect(notes.map((n) => n.path).slice(0, 2)).toEqual(["README.md", "docs/decisions.md"]);
  });

  it("reads the history oldest first, and nothing without a repository", async () => {
    const root = folder();
    expect(await gitHistory(root)).toEqual([]);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
    git("init", "-q");
    git("add", "README.md");
    git("commit", "-q", "-m", "Start");
    git("add", "src");
    git("commit", "-q", "-m", "Fix the build");
    const history = await gitHistory(root);
    expect(history.map((c) => c.subject)).toEqual(["Start", "Fix the build"]);
    expect(history[1]?.stat.join("\n")).toContain("src/main.swift");
  });

  it("finds the sessions that worked on the project, by the cwd recorded inside them", async () => {
    const root = folder();
    const sessionsRoot = mkdtempSync(join(tmpdir(), "harvest-sessions-"));
    mkdirSync(join(sessionsRoot, "-encoded-name-does-not-matter"));
    writeFileSync(
      join(sessionsRoot, "-encoded-name-does-not-matter", "1111aaaa-x.jsonl"),
      jsonl({ ...user("hello", "2026-09-01T00:00:00Z"), cwd: root }),
    );
    writeFileSync(
      join(sessionsRoot, "-encoded-name-does-not-matter", "2222bbbb-x.jsonl"),
      jsonl({ ...user("elsewhere", "2026-09-01T00:00:00Z"), cwd: "/tmp/other" }),
    );
    const found = await findSessions(root, { sessionsRoot });
    expect(found.map((s) => s.id)).toEqual(["1111aaaa"]);
  });
});

describe("renderHarvest", () => {
  function harvest(sessions: MatchedSession[], extra: Partial<Harvest> = {}): Harvest {
    return {
      root: "/p",
      name: "demo",
      gatheredAt: "2026-10-07T00:00:00Z",
      sources: [
        { name: "Claude Code sessions", found: sessions.length > 0, detail: "" },
        { name: "Decision records", found: false, detail: "none — anchor modules in sessions, commits or code instead" },
      ],
      sessions,
      commits: [],
      notes: [],
      tree: [{ path: "main.swift", files: 1, bytes: 9 }],
      files: ["main.swift"],
      ...extra,
    };
  }
  function session(id: string, items: MatchedSession["items"]): MatchedSession {
    return { ...digestSession("", "/p", id), file: `/s/${id}.jsonl`, why: "started in the project", first: "2026-09-01", last: "2026-09-02", items };
  }

  it("says which sources were missing", () => {
    const page = renderHarvest(harvest([]));
    expect(page).toContain("| Decision records | no | none — anchor modules in sessions, commits or code instead |");
  });

  it("keeps every prompt and error, and leaves answers out first, when over budget", () => {
    const long = "答".repeat(1100);
    const items = Array.from({ length: 12 }, (_, i) => [
      { at: `2026-09-01T0${i % 10}:00`, kind: "prompt" as const, text: `question ${i}` },
      { at: `2026-09-01T0${i % 10}:01`, kind: "error" as const, text: `error ${i}` },
      // Distinct openings: answers sharing their first 300 characters count as repeats.
      { at: `2026-09-01T0${i % 10}:02`, kind: "answer" as const, text: `answer ${i}: ${long}` },
    ]).flat();
    const page = renderHarvest(harvest([session("aaaa1111", items)]), { budgetTokens: 4000 });
    for (let i = 0; i < 12; i++) {
      expect(page).toContain(`question ${i}`);
      expect(page).toContain(`error ${i}`);
    }
    expect(page).toMatch(/## Left out for length\n\n\d+ answers\./);
    expect(estimateTokens(page)).toBeLessThan(4400);
  });

  it("prints what a resumed session repeats only once", () => {
    const shared = { at: "2026-09-01T01:00", kind: "prompt" as const, text: "the same question" };
    const page = renderHarvest(harvest([session("aaaa1111", [shared]), session("bbbb2222", [shared])]));
    expect(page.match(/the same question/g)).toHaveLength(1);
  });

  it("redacts what it renders", () => {
    const page = renderHarvest(
      harvest([session("aaaa1111", [{ at: "2026-09-01T01:00", kind: "prompt", text: "密码是 Abc_12345" }])]),
    );
    expect(page).toContain("密码是 [REDACTED]");
    expect(page).not.toContain("Abc_12345");
  });
});
