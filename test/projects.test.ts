/**
 * Projects to learn from (P-29): the folder dialog, dated snapshots under a
 * ToonDao home, and the bridge routes that never take a folder from a request.
 * Everything runs in temp folders; the dialog is stood in for.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridge, type BridgeOptions } from "../bridge/claude-code.ts";
import {
  chooseFolder,
  FolderDialogError,
  isSecretFile,
  listProjects,
  redactTranscript,
  slugFor,
  snapshotId,
  snapshotProject,
  snapshotReadDir,
} from "../bridge/projects.ts";

/** A small git project with one matching session (which pasted a password) and a memory note. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "projects-test-"));
  const project = join(base, "osmo dock ");
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "README.md"), "# Osmo Dock\n\nPulls clips off the camera.");
  writeFileSync(join(project, "docs", "decisions.md"), "## ADR-001: Keep the Mac online\n");
  mkdirSync(join(project, "Sources"), { recursive: true });
  writeFileSync(join(project, "Sources", "WifiJoiner.swift"), "// joins the camera's hotspot\n");
  writeFileSync(join(project, ".env"), "OPENAI_API_KEY=not-for-the-model\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "Start");

  const sessionsRoot = join(base, "claude-projects");
  const folder = join(sessionsRoot, "-encoded");
  mkdirSync(join(folder, "memory"), { recursive: true });
  writeFileSync(join(folder, "memory", "camera-silent-state.md"), "The camera goes quiet after a failed join.");
  const line = (o: object) => JSON.stringify(o);
  writeFileSync(
    join(folder, "aaaa1111-0000.jsonl"),
    [
      line({ type: "custom-title", customTitle: "Camera sync" }),
      line({ type: "user", timestamp: "2026-09-23T10:00:00Z", cwd: project, message: { role: "user", content: "The Wi-Fi psw: hunter2!x — why does it drop?" } }),
      line({ type: "assistant", timestamp: "2026-09-23T10:00:30Z", cwd: project, message: { role: "assistant", content: [{ type: "text", text: "AP mode." }] } }),
    ].join("\n"),
  );
  const home = join(base, "toondao-home");
  return { base, project, sessionsRoot, home };
}

describe("names", () => {
  it("slugs a folder name for a URL and a path", () => {
    expect(slugFor("osmo dock ")).toBe("osmo-dock");
    expect(slugFor("WiseTrade")).toBe("wisetrade");
    expect(slugFor("深度学习")).toBe("project");
  });
  it("names a snapshot by when it was taken, without colons", () => {
    expect(snapshotId(new Date("2026-10-07T14:55:02.123Z"))).toBe("2026-10-07T14-55-02Z");
  });
});

describe("redactTranscript", () => {
  it("redacts every string and keeps each line valid JSON", () => {
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "密码是 Abc_12345" }] } }),
      "not json, but psw: hunter2!x",
      "",
    ].join("\n");
    const out = redactTranscript(raw).split("\n");
    expect(JSON.parse(out[0] ?? "").message.content[0].text).toBe("密码是 [REDACTED]");
    expect(out[1]).toBe("not json, but psw: [REDACTED]");
    expect(out).toHaveLength(3);
  });
});

describe("snapshotProject", () => {
  it("freezes the harvest, the sessions and redacted transcripts, owner-only", async () => {
    const f = fixture();
    const project = await snapshotProject(f.project, {
      home: f.home,
      sessionsRoot: f.sessionsRoot,
      now: new Date("2026-10-07T14:55:02Z"),
    });
    // The temp folder sits behind a symlink (/var → /private/var), as a real project can:
    // the session recorded the linked path and is still found; the root is the resolved one.
    expect(project).toMatchObject({ slug: "osmo-dock", name: "osmo dock", root: realpathSync(f.project) });
    const snap = project.snapshots[0]!;
    expect(snap.id).toBe("2026-10-07T14-55-02Z");
    expect(snap.sessions).toEqual([{ id: "aaaa1111", title: "Camera sync" }]);
    expect(snap.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.sources.find((s) => s.name === "Claude Code memory")?.found).toBe(true);

    const dir = join(f.home, "projects", "osmo-dock", snap.id);
    const read = join(dir, "read");
    const page = readFileSync(join(read, "harvest.md"), "utf8");
    expect(page).toContain("claude-memory/camera-silent-state.md");
    expect(page).not.toContain("hunter2");
    const copy = readFileSync(join(dir, "transcripts", "aaaa1111.jsonl"), "utf8");
    expect(copy).not.toContain("hunter2");
    for (const line of copy.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    expect(readFileSync(join(read, "sessions", "aaaa1111.md"), "utf8")).toContain("AP mode.");
    // What the model may read: the harvest, the sessions and the project's own files —
    // never the transcripts, and never a credential file the project forgot to ignore.
    expect(readFileSync(join(read, "files", "Sources", "WifiJoiner.swift"), "utf8")).toContain("hotspot");
    expect(existsSync(join(read, "files", "docs", "decisions.md"))).toBe(true);
    expect(existsSync(join(read, "files", ".env"))).toBe(false);
    expect(existsSync(join(read, "transcripts"))).toBe(false);
    expect(snap.files).toBe(3);
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).root).toBe(realpathSync(f.project));

    expect(statSync(join(read, "harvest.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(read, "files", "README.md")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.home, "projects")).mode & 0o777).toBe(0o700);
  });

  it("keeps every snapshot, and gives another folder of the same name its own slug", async () => {
    const f = fixture();
    const opts = { home: f.home, sessionsRoot: f.sessionsRoot };
    await snapshotProject(f.project, { ...opts, now: new Date("2026-10-07T10:00:00Z") });
    const again = await snapshotProject(f.project, { ...opts, now: new Date("2026-10-08T10:00:00Z") });
    expect(again.snapshots.map((s) => s.id)).toEqual(["2026-10-07T10-00-00Z", "2026-10-08T10-00-00Z"]);

    const twin = join(f.base, "elsewhere", "osmo dock ");
    mkdirSync(twin, { recursive: true });
    writeFileSync(join(twin, "README.md"), "# Another one");
    const other = await snapshotProject(twin, opts);
    expect(other.slug).toBe("osmo-dock-2");
    expect((await listProjects(f.home)).map((p) => p.slug).sort()).toEqual(["osmo-dock", "osmo-dock-2"]);
  });
});

describe("snapshotReadDir", () => {
  it("finds a snapshot's read folder only through the registry", async () => {
    const f = fixture();
    const project = await snapshotProject(f.project, { home: f.home, sessionsRoot: f.sessionsRoot });
    const id = project.snapshots[0]!.id;
    expect(await snapshotReadDir("osmo-dock", id, f.home)).toBe(join(f.home, "projects", "osmo-dock", id, "read"));
    expect(await snapshotReadDir("osmo-dock", "2020-01-01T00-00-00Z", f.home)).toBeNull();
    expect(await snapshotReadDir("no-such-project", id, f.home)).toBeNull();
    expect(await snapshotReadDir("../osmo-dock", id, f.home)).toBeNull();
    expect(await snapshotReadDir("osmo-dock", "../../etc", f.home)).toBeNull();
  });

  it("refuses a snapshot taken before the model could read one", async () => {
    const f = fixture();
    const project = await snapshotProject(f.project, { home: f.home, sessionsRoot: f.sessionsRoot });
    const old = { ...project, snapshots: project.snapshots.map(({ files: _files, ...rest }) => rest) };
    writeFileSync(join(f.home, "projects", "osmo-dock", "project.json"), JSON.stringify(old));
    expect(await snapshotReadDir("osmo-dock", project.snapshots[0]!.id, f.home)).toBeNull();
  });
});

describe("copying the project", () => {
  it("never follows a symbolic link out of the project", async () => {
    const f = fixture();
    const outside = join(f.base, "id_rsa_lookalike");
    writeFileSync(outside, "PRIVATE KEY MATERIAL");
    symlinkSync(outside, join(f.project, "Sources", "linked.txt"));
    const project = await snapshotProject(f.project, { home: f.home, sessionsRoot: f.sessionsRoot });
    const files = join(f.home, "projects", "osmo-dock", project.snapshots[0]!.id, "read", "files");
    expect(existsSync(join(files, "Sources", "linked.txt"))).toBe(false);
    expect(existsSync(join(files, "Sources", "WifiJoiner.swift"))).toBe(true);
  });
});

describe("isSecretFile", () => {
  it("keeps credential files out of what the model reads, and nothing else", () => {
    for (const path of [".env", "config/.env.local", "id_ed25519", "certs/server.pem", "app.keystore", "credentials.json"]) {
      expect(isSecretFile(path)).toBe(true);
    }
    for (const path of ["README.md", "Sources/Keychain.swift", "docs/secrets-handling.md", "env.ts"]) {
      expect(isSecretFile(path)).toBe(false);
    }
  });
});

describe("chooseFolder", () => {
  const darwin = { platform: "darwin" as const };
  it("returns the clicked folder, keeping a name that ends in a space", async () => {
    const runner = async () => ({ stdout: "/Users/someone/osmo dock /\n" });
    expect(await chooseFolder({ ...darwin, runner })).toBe("/Users/someone/osmo dock ");
  });
  it("returns null when the person cancels or walks away", async () => {
    const cancel = async () => Promise.reject(Object.assign(new Error("execution error: User canceled. (-128)"), {}));
    const timeout = async () => Promise.reject(Object.assign(new Error("timed out"), { killed: true }));
    expect(await chooseFolder({ ...darwin, runner: cancel })).toBeNull();
    expect(await chooseFolder({ ...darwin, runner: timeout })).toBeNull();
  });
  it("says what to do instead off macOS, and when the dialog cannot open", async () => {
    await expect(chooseFolder({ platform: "linux" })).rejects.toThrow(/npm run harvest/);
    const broken = async () => Promise.reject(new Error("osascript: not found"));
    await expect(chooseFolder({ ...darwin, runner: broken })).rejects.toBeInstanceOf(FolderDialogError);
  });
});

describe("the bridge's project routes", () => {
  async function bridge(extra: Partial<BridgeOptions>) {
    const opts: BridgeOptions = {
      port: 0,
      allowedOrigins: ["http://localhost:5273"],
      allowedTools: [],
      claudeBin: "claude-not-needed",
      ...extra,
    };
    const server = startBridge(opts);
    await new Promise((resolve) => server.once("listening", resolve));
    opts.port = (server.address() as AddressInfo).port; // the Host check compares against it
    const call = async (method: string, path: string, origin = "http://localhost:5273") => {
      const res = await fetch(`http://127.0.0.1:${opts.port}${path}`, {
        method,
        headers: { Origin: origin, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    return { call, close: () => server.close(), port: () => opts.port };
  }

  it("registers the folder the dialog returned, lists it, and snapshots it again by slug", async () => {
    const f = fixture();
    const b = await bridge({ projectsHome: f.home, sessionsRoot: f.sessionsRoot, chooseFolder: async () => f.project });
    try {
      expect((await b.call("GET", "/v1/projects")).body).toEqual({ projects: [] });
      const chosen = await b.call("POST", "/v1/projects/choose");
      expect(chosen.status).toBe(200);
      expect((chosen.body.project as { slug: string }).slug).toBe("osmo-dock");
      const listed = await b.call("GET", "/v1/projects");
      expect((listed.body.projects as unknown[]).length).toBe(1);
      const again = await b.call("POST", "/v1/projects/osmo-dock/snapshot");
      expect((again.body.project as { snapshots: unknown[] }).snapshots.length).toBeGreaterThanOrEqual(1);
      expect((await b.call("POST", "/v1/projects/no-such-project/snapshot")).status).toBe(404);
    } finally {
      b.close();
    }
  });

  it("refuses to answer a chat that names a snapshot the registry does not hold, before starting Claude Code", async () => {
    const f = fixture();
    await snapshotProject(f.project, { home: f.home, sessionsRoot: f.sessionsRoot });
    const b = await bridge({ projectsHome: f.home, claudeBin: "/nonexistent/claude-must-not-run" });
    try {
      for (const project of [
        { slug: "osmo-dock", snapshot: "2020-01-01T00-00-00Z" },
        { slug: "../../etc", snapshot: "passwd" },
      ]) {
        const res = await fetch(`http://127.0.0.1:${b.port()}/v1/chat/completions`, {
          method: "POST",
          headers: { Origin: "http://localhost:5273", "Content-Type": "application/json" },
          body: JSON.stringify({ model: "haiku", stream: true, messages: [{ role: "user", content: "hi" }], toondao: { project } }),
        });
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toMatch(/not available/);
      }
    } finally {
      b.close();
    }
  });

  it("answers a cancelled dialog plainly, refuses the home folder, and refuses other origins", async () => {
    const f = fixture();
    const cancelled = await bridge({ projectsHome: f.home, chooseFolder: async () => null });
    try {
      expect((await cancelled.call("POST", "/v1/projects/choose")).body).toEqual({ cancelled: true });
      expect((await cancelled.call("GET", "/v1/projects", "https://evil.example")).status).toBe(403);
    } finally {
      cancelled.close();
    }
    const home = await bridge({ projectsHome: f.home, chooseFolder: async () => process.env.HOME ?? "/" });
    try {
      const refused = await home.call("POST", "/v1/projects/choose");
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toMatch(/home folder/);
    } finally {
      home.close();
    }
  });
});
