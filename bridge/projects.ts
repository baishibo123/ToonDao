/**
 * Projects the person learns from: picked in a system folder dialog, frozen as
 * dated snapshots under `~/.toondao/projects/` (P-29).
 *
 *   ~/.toondao/projects/<slug>/
 *     project.json              name, folder, and every snapshot, oldest first
 *     <snapshot id>/
 *       harvest.md              the page the model reads first
 *       sessions/<id>.md        each session in full
 *       transcripts/<id>.jsonl  the session transcripts, copied through redact()
 *       manifest.json           what was gathered, from where, at which commit
 *
 * A request never names a folder: a new project comes from the dialog the
 * person clicked through, a known one from this registry by its slug. Every
 * file is owner-only, and nothing here is ever served back over HTTP except the
 * summaries in project.json.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  await mkdir(join(dir, "sessions"), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "transcripts"), { recursive: true, mode: 0o700 });
  for (const d of [home, join(home, "projects"), projectDir, dir]) await chmod(d, 0o700);

  const page = renderHarvest(harvest);
  await writePrivate(join(dir, "harvest.md"), page);
  for (const session of harvest.sessions) {
    await writePrivate(join(dir, "sessions", `${session.id}.md`), renderSession(session));
    const raw = await readFile(session.file, "utf8");
    await writePrivate(join(dir, "transcripts", `${session.id}.jsonl`), redactTranscript(raw));
  }

  const summary: SnapshotSummary = {
    id,
    createdAt: now.toISOString(),
    gitHead: await gitHead(harvest.root),
    sources: harvest.sources,
    sessions: harvest.sessions.map((s) => ({ id: s.id, title: s.title })),
    harvestTokens: estimateTokens(page),
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
