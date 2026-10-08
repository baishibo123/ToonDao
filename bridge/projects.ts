/**
 * Projects the person learns from: picked in a system folder dialog, frozen as
 * dated snapshots under `~/.toondao/projects/` (P-29).
 *
 *   ~/.toondao/projects/<slug>/
 *     project.json              name, folder, and every snapshot, oldest first
 *     <snapshot id>/
 *       read/                   the only folder a model may read (P-31)
 *         harvest.md            the page it reads first
 *         sessions/<id>.md      each session in full
 *         files/…               the project's own files, as they were
 *       transcripts/<id>.jsonl  the session transcripts, copied through redact()
 *       manifest.json           what was gathered, from where, at which commit
 *
 * A request never names a folder: a new project comes from the dialog the
 * person clicked through, a known one from this registry by its slug. Every
 * file is owner-only, and nothing here is ever served back over HTTP except the
 * summaries in project.json.
 */
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ProjectSummary, SnapshotSummary } from "../src/lib/bridgeProtocol.ts";
import { estimateTokens, harvestProject, redact, renderHarvest, renderSession } from "./harvest.ts";

const run = promisify(execFile);

export const TOONDAO_HOME = join(homedir(), ".toondao");

/** `osmo dock` → `osmo-dock`. Lowercase letters, digits and dashes, so it is safe in a URL and a path. */
export function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

export function isSafeSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);
}

export function isSafeSnapshotId(id: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d{1,3})?$/.test(id);
}

/** A folder name for a snapshot: when it was taken, sortable, without colons. */
export function snapshotId(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/**
 * A transcript with every string value passed through `redact()`. Each line is
 * parsed and written back, so the copy stays valid JSONL that the harvest can
 * read again; a line that is not JSON is redacted as text.
 */
export function redactTranscript(jsonl: string): string {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
    }
    return value;
  };
  return jsonl
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(scrub(JSON.parse(line)));
      } catch {
        return redact(line);
      }
    })
    .join("\n");
}

async function readProject(dir: string): Promise<ProjectSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as ProjectSummary;
    return parsed && typeof parsed.slug === "string" && typeof parsed.root === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Every registered project, by name. */
export async function listProjects(home = TOONDAO_HOME): Promise<ProjectSummary[]> {
  const root = join(home, "projects");
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const projects = await Promise.all(names.map((name) => readProject(join(root, name))));
  return projects
    .filter((p): p is ProjectSummary => p !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function projectBySlug(slug: string, home = TOONDAO_HOME): Promise<ProjectSummary | null> {
  if (!isSafeSlug(slug)) return null;
  return readProject(join(home, "projects", slug));
}

/** The commit a git project is at, or null. */
async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", root, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function writePrivate(path: string, text: string): Promise<void> {
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * Files that hold credentials by convention. Git-ignored files are never listed
 * in the first place; these are kept out even when a project forgot to ignore
 * them, since the copy is what a model will read.
 */
const SECRET_FILE =
  /(^|\/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.[^/]*)?|secrets?(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx|mobileprovision))$/i;

export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path);
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/**
 * Copy the project's own files into a snapshot for the model to read: what git
 * tracks or would track, minus credential files, files over 1 MB, and anything
 * past the totals. Returns how many were copied.
 */
export async function copyProjectFiles(root: string, files: readonly string[], dest: string): Promise<number> {
  let copied = 0;
  let total = 0;
  for (const path of files) {
    if (copied >= MAX_FILES || isSecretFile(path) || path.split("/").includes("..")) continue;
    const from = join(root, path);
    let size: number;
    try {
      const info = await stat(from);
      if (!info.isFile()) continue;
      size = info.size;
    } catch {
      continue;
    }
    if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
    const to = join(dest, path);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    await chmod(to, 0o600);
    copied++;
    total += size;
  }
  return copied;
}

/**
 * The folder a request for a project snapshot may read, or null. Both names
 * must look right and match the registry, and the snapshot must be one taken
 * after models could read snapshots; the path is built from the registry's own
 * entries, never from the request.
 */
export async function snapshotReadDir(slug: string, snapshot: string, home = TOONDAO_HOME): Promise<string | null> {
  if (!isSafeSlug(slug) || !isSafeSnapshotId(snapshot)) return null;
  const project = await projectBySlug(slug, home);
  const found = project?.snapshots.find((s) => s.id === snapshot);
  if (!project || !found || typeof found.files !== "number") return null;
  const dir = join(home, "projects", project.slug, found.id, "read");
  try {
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Harvest the folder and freeze the result as a new snapshot, registering the
 * project the first time. A snapshot is never overwritten, so a clean "just
 * imported" start can always be returned to. Two different folders with the
 * same name get different slugs.
 */
export async function snapshotProject(
  folder: string,
  opts: { home?: string; sessionsRoot?: string; now?: Date } = {},
): Promise<ProjectSummary> {
  const home = opts.home ?? TOONDAO_HOME;
  const now = opts.now ?? new Date();
  const harvest = await harvestProject(folder, {
    ...(opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot } : {}),
    now,
  });

  // The slug: this folder's existing entry, or a fresh name no other folder holds.
  const existing = (await listProjects(home)).find((p) => p.root === harvest.root);
  let slug = existing?.slug ?? slugFor(harvest.name);
  if (!existing) {
    for (let n = 2; await projectBySlug(slug, home); n++) slug = `${slugFor(harvest.name)}-${n}`;
  }
  const projectDir = join(home, "projects", slug);

  let id = snapshotId(now);
  for (let n = 2; (existing?.snapshots ?? []).some((s) => s.id === id); n++) id = `${snapshotId(now)}-${n}`;
  const dir = join(projectDir, id);
  const read = join(dir, "read");
  await mkdir(join(read, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(read, "files"), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "transcripts"), { recursive: true, mode: 0o700 });
  for (const d of [home, join(home, "projects"), projectDir, dir, read]) await chmod(d, 0o700);

  const page = renderHarvest(harvest);
  await writePrivate(join(read, "harvest.md"), page);
  for (const session of harvest.sessions) {
    await writePrivate(join(read, "sessions", `${session.id}.md`), renderSession(session));
    const raw = await readFile(session.file, "utf8");
    await writePrivate(join(dir, "transcripts", `${session.id}.jsonl`), redactTranscript(raw));
  }
  const files = await copyProjectFiles(harvest.root, harvest.files, join(read, "files"));

  const summary: SnapshotSummary = {
    id,
    createdAt: now.toISOString(),
    gitHead: await gitHead(harvest.root),
    sources: harvest.sources,
    sessions: harvest.sessions.map((s) => ({ id: s.id, title: s.title })),
    harvestTokens: estimateTokens(page),
    files,
  };
  await writePrivate(
    join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        ...summary,
        root: harvest.root,
        notes: harvest.notes.map((n) => n.path),
        transcripts: harvest.sessions.map((s) => ({ id: s.id, from: s.file, why: s.why })),
      },
      null,
      2,
    )}\n`,
  );

  const project: ProjectSummary = {
    slug,
    name: harvest.name,
    root: harvest.root,
    snapshots: [...(existing?.snapshots ?? []), summary],
  };
  await writePrivate(join(projectDir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  return project;
}

/* ------------------------------------------------------------------ */
/* The folder dialog                                                   */
/* ------------------------------------------------------------------ */

export class FolderDialogError extends Error {}

/** Brings the dialog to the front, then returns the chosen folder's POSIX path. */
const CHOOSE_SCRIPT = ["activate", 'return POSIX path of (choose folder with prompt "Choose a project to learn from")'];

type Runner = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string }>;

/**
 * Ask the person for a folder with macOS's own dialog. The path comes from
 * their click, never from a web request. Returns null when they cancel or let
 * it sit for `timeoutMs`.
 */
export async function chooseFolder(
  deps: { runner?: Runner; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new FolderDialogError(
      'Picking a folder from ToonDao works on macOS for now. In a terminal, run: npm run harvest -- "<project folder>" --snapshot',
    );
  }
  const runner: Runner = deps.runner ?? ((file, args, options) => run(file, [...args], options));
  try {
    const { stdout } = await runner(
      "osascript",
      CHOOSE_SCRIPT.flatMap((line) => ["-e", line]),
      { timeout: deps.timeoutMs ?? 5 * 60_000 },
    );
    // POSIX paths of folders end in "/"; a folder name may itself end in a space.
    const path = stdout.replace(/\r?\n$/, "").replace(/\/$/, "");
    return path || null;
  } catch (err) {
    const detail = err instanceof Error ? `${err.message} ${String((err as { stderr?: unknown }).stderr ?? "")}` : String(err);
    if (/-128|User canceled/i.test(detail) || (err as { killed?: boolean }).killed) return null;
    throw new FolderDialogError(`Could not open a folder dialog: ${detail.trim().slice(0, 300)}`);
  }
}
