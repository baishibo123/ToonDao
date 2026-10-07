/**
 * What a project already holds about how it was built, gathered once by code so
 * the model can draw a learning map from one page instead of the whole folder
 * (P-28).
 *
 * A port of the learn-project skill's harvest.py, generalised for projects with
 * no ADRs or notes: every source is optional, and the page says which ones were
 * found. Read-only throughout. Git-ignored files are never read, and everything
 * rendered passes `redact()`.
 *
 * Run it from a terminal with `npm run harvest` (bridge/harvest-cli.ts).
 */
import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { HarvestSource } from "../src/lib/bridgeProtocol.ts";

const run = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ItemKind = "prompt" | "error" | "summary" | "answer";

/** One thing worth keeping from a session, in the order it happened. */
export interface SessionItem {
  at: string;
  kind: ItemKind;
  text: string;
}

export interface SessionDigest {
  /** The transcript's file name, first 8 characters. */
  id: string;
  title: string | null;
  /** The first working directory the transcript records. */
  cwd: string | null;
  first: string;
  last: string;
  /** User and assistant records, how many ran inside the project, and how
   *  many lines mention its path at all. */
  records: number;
  inside: number;
  mentions: number;
  items: SessionItem[];
}

export interface MatchedSession extends SessionDigest {
  file: string;
  /** Which rule tied it to the project, so a brief visit can be told apart. */
  why: string;
}

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  stat: string[];
}

export interface NoteFile {
  path: string;
  text: string;
}

export interface FolderSummary {
  path: string;
  files: number;
  bytes: number;
}

export type Source = HarvestSource;

export interface Harvest {
  root: string;
  name: string;
  gatheredAt: string;
  sources: Source[];
  sessions: MatchedSession[];
  commits: Commit[];
  notes: NoteFile[];
  tree: FolderSummary[];
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

const SECRETS = [
  /sk-or-v1-[0-9a-f]{32,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
];

const ASSIGNED =
  /((?:\b(?:pass(?:word|wd)?|psw|pwd|secret|api[_-]?key|token)\b|密码|口令)\s*(?:[:：=]|是|为)?\s*)([^\s,，;；。、（）()\u3000-\u9fff\uff00-\uffef]{4,})/gi;

/**
 * Credentials pasted into a chat — API keys, tokens, `password:` values —
 * replaced, with harvest.py's patterns. Deliberately greedy: an English word
 * after "password" or "token" may go too, which costs a little meaning and
 * never a secret. Unlike harvest.py, the value is never Chinese: a password is
 * not, and prose such as "用蓝牙读 Wi-Fi 密码、再握手" is what a project about
 * passwords is there to teach.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRETS) out = out.replace(pattern, "[REDACTED-KEY]");
  return out.replace(ASSIGNED, (_match, lead: string) => `${lead}[REDACTED]`);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

export const SESSIONS_ROOT = join(homedir(), ".claude", "projects");

/** Chat lines that are the harness talking, not the person. */
const NOISE = ["<task-notification>", "<local-command-stdout>", "<command-name>", "[Request interrupted"];
const SUMMARY_LEAD = "This session is being continued";

/**
 * One transcript → the user's prompts, the tool errors they hit, compaction
 * summaries and the final text of each answer, in order. Pure.
 *
 * As in harvest.py, an answer is the last assistant text before the next
 * prompt, and errors the harness raised about its own tools are dropped as
 * noise. Unlike it, a prompt typed while Claude was busy — stored as a
 * `queued_command` attachment rather than a user record — is kept.
 */
export function digestSession(jsonl: string, project: string | readonly string[], id = ""): SessionDigest {
  const roots = typeof project === "string" ? [project] : project;
  const digest: SessionDigest = {
    id,
    title: null,
    cwd: null,
    first: "",
    last: "",
    records: 0,
    inside: 0,
    mentions: 0,
    items: [],
  };
  let aiTitle: string | null = null;
  let pending: SessionItem | null = null;
  const flush = () => {
    if (pending) digest.items.push(pending);
    pending = null;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    if (roots.some((root) => line.includes(root))) digest.mentions++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const record = parsed;
    const type = record.type;

    if (type === "custom-title") {
      digest.title = str(record.customTitle) || str(record.title) || digest.title;
      continue;
    }
    if (type === "ai-title") {
      aiTitle = str(record.aiTitle) || aiTitle;
      continue;
    }
    if (type === "attachment" && isRecord(record.attachment)) {
      if (record.attachment.type === "queued_command") {
        const text = str(record.attachment.prompt).trim();
        if (text && !NOISE.some((lead) => text.startsWith(lead))) {
          flush();
          digest.items.push({ at: str(record.timestamp), kind: "prompt", text });
        }
      }
      continue;
    }
    if ((type !== "user" && type !== "assistant") || record.isSidechain) continue;

    const at = str(record.timestamp);
    const cwd = str(record.cwd);
    digest.records++;
    if (cwd) {
      digest.cwd ??= cwd;
      if (roots.some((root) => inside(cwd, root))) digest.inside++;
    }
    if (!digest.first) digest.first = at;
    if (at) digest.last = at;

    const content = isRecord(record.message) ? record.message.content : undefined;
    if (type === "assistant") {
      const body = texts(content).join("\n").trim();
      if (body) pending = { at, kind: "answer", text: body };
      continue;
    }

    if (Array.isArray(content) && content.some((b) => isRecord(b) && b.type === "tool_result")) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result" || !block.is_error) continue;
        const raw = typeof block.content === "string" ? block.content : texts(block.content).join("\n");
        const text = errorLine(raw);
        if (text) digest.items.push({ at, kind: "error", text });
      }
      continue;
    }
    if (record.isMeta) continue;

    const body = texts(content).join("\n").trim();
    if (!body || NOISE.some((lead) => body.startsWith(lead))) continue;
    flush();
    digest.items.push({ at, kind: body.startsWith(SUMMARY_LEAD) ? "summary" : "prompt", text: body });
  }
  flush();
  digest.title ??= aiTitle;
  return digest;
}

/**
 * The line of a failed tool call that says what went wrong. harvest.py keeps
 * the first line, but a failed command's first line is only "Exit code 1": then
 * the line naming an error is kept beside it, or failing that the last one.
 * Errors the harness raised about its own tools are noise, and dropped.
 */
export function errorLine(raw: string): string {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines[0] ?? "";
  if (!first || first.startsWith("<tool_use_error>")) return "";
  if (!/^Exit code \d+$/.test(first)) return first;
  const rest = lines.slice(1);
  const telling = rest.find((l) => /error|fatal|failed|denied|not found|cannot|unable/i.test(l)) ?? rest.at(-1);
  return telling ? `${first}: ${telling}` : first;
}

export function inside(path: string, project: string): boolean {
  return path === project || path.startsWith(`${project}/`);
}

/**
 * Did this session work on the project? harvest.py's three rules: it started
 * there (worktrees included), it spent `minRecords` records there, or it named
 * the project's path on `minMentions` lines — a session that only attached one
 * of its docs does that a few dozen times, one that worked on it by absolute
 * path hundreds.
 */
export function matchReason(
  digest: SessionDigest,
  project: string | readonly string[],
  { minRecords = 20, minMentions = 200 }: { minRecords?: number; minMentions?: number } = {},
): string | null {
  const roots = typeof project === "string" ? [project] : project;
  const cwd = digest.cwd;
  if (cwd && roots.some((root) => inside(cwd, root))) return "started in the project";
  if (digest.inside >= minRecords) return `${digest.inside} of ${digest.records} records in the project`;
  if (digest.mentions >= minMentions) return `${digest.mentions} lines mention its path`;
  return null;
}

/**
 * Every Claude Code transcript that worked on the project, oldest first.
 * `project` may name the folder by more than one path — the path it was given
 * and the one symlinks resolve to — since a session records whichever it ran in.
 */
export async function findSessions(
  project: string | readonly string[],
  opts: { sessionsRoot?: string; minRecords?: number; minMentions?: number } = {},
): Promise<MatchedSession[]> {
  const root = opts.sessionsRoot ?? SESSIONS_ROOT;
  let folders: string[];
  try {
    folders = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
  const found: MatchedSession[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = (await readdir(folder)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(folder, name);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const digest = digestSession(text, project, basename(name, ".jsonl").slice(0, 8));
      const why = matchReason(digest, project, opts);
      if (why && digest.items.length > 0) found.push({ ...digest, file, why });
    }
  }
  return found.sort((a, b) => a.first.localeCompare(b.first));
}

/* ------------------------------------------------------------------ */
/* The project itself                                                  */
/* ------------------------------------------------------------------ */

/** The arc of the work, oldest first; fix commits are where incidents are. */
export async function gitHistory(root: string, maxLines = 400): Promise<Commit[]> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      "git",
      ["-C", root, "log", "--reverse", "--stat", "--date=short", "--format=%x00%h %ad %s"],
      { maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return [];
  }
  const commits: Commit[] = [];
  let lines = 0;
  for (const chunk of stdout.split("\0")) {
    if (!chunk.trim()) continue;
    const [head = "", ...rest] = chunk.split("\n");
    const match = /^(\S+) (\d{4}-\d{2}-\d{2}) (.*)$/.exec(head);
    if (!match) continue;
    const statLines = rest.map((l) => l.trimEnd()).filter(Boolean);
    lines += 1 + statLines.length;
    if (lines > maxLines) break;
    commits.push({ hash: match[1] ?? "", date: match[2] ?? "", subject: match[3] ?? "", stat: statLines });
  }
  return commits;
}

/** Folders that are never the project's own words: dependencies, build output, caches. */
const SKIP_DIRS = new Set([
  ".git", ".claude", "node_modules", ".build", ".swiftpm", "dist", "build", "out", "target",
  "DerivedData", "Pods", "vendor", ".venv", "venv", "__pycache__", ".next", ".turbo", ".cache",
  "coverage",
]);

/**
 * The project's own files, relative to its root. In a git repository, what git
 * tracks or would track: ignored files are where captures, traces and secrets
 * usually live, so they are never listed, let alone read. Without git, a walk
 * that skips dependencies, build output, hidden folders and nested repositories.
 */
export async function projectFiles(root: string, limit = 20_000): Promise<string[]> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout
      .split("\0")
      .filter((path) => path && !path.endsWith("/") && !path.split("/").some((part) => SKIP_DIRS.has(part)))
      .slice(0, limit);
  } catch {
    // Not a git repository: walk it instead.
  }
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (prefix && entries.some((entry) => entry.name === ".git")) return; // someone else's repository
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.isFile()) out.push(path);
    }
  }
  await walk(root, "");
  return out;
}

const NOTE_FILE = /(^|\/)(README|readme)(\.[a-z]+)?$|\.(md|markdown)$/i;

/** What a reader would read first: README, CLAUDE.md, decisions, then the rest of docs/, then any other note. */
function noteRank(path: string): number {
  const lower = path.toLowerCase();
  if (/^readme(\.[a-z]+)?$/.test(lower)) return 0;
  if (lower === "claude.md" || lower === "agents.md") return 1;
  if (lower.endsWith("decisions.md")) return 2;
  if (lower.startsWith("docs/")) return 3;
  return 4;
}

/** The project's own notes, whatever it has of them — possibly none. */
export async function findNotes(root: string, files: readonly string[], maxBytes = 200_000): Promise<NoteFile[]> {
  const picked = files
    .filter((path) => NOTE_FILE.test(path))
    .sort((a, b) => noteRank(a) - noteRank(b) || a.localeCompare(b));
  const notes: NoteFile[] = [];
  for (const path of picked) {
    try {
      const full = join(root, path);
      if ((await stat(full)).size > maxBytes) continue;
      const text = (await readFile(full, "utf8")).trim();
      if (text) notes.push({ path, text });
    } catch {
      // Unreadable: leave it out.
    }
  }
  return notes;
}

/**
 * What Claude Code remembered about the project: the `memory/` folder beside
 * the transcripts of each session that worked on it. These are lessons already
 * written down, so they are read with the notes, filed under `claude-memory/`.
 */
export async function findMemory(sessions: readonly MatchedSession[], maxBytes = 200_000): Promise<NoteFile[]> {
  const folders = [...new Set(sessions.map((s) => join(dirname(s.file), "memory")))];
  const notes: NoteFile[] = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = (await readdir(folder)).filter((name) => name.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const full = join(folder, name);
        if ((await stat(full)).size > maxBytes) continue;
        const text = (await readFile(full, "utf8")).trim();
        if (text) notes.push({ path: `claude-memory/${name}`, text });
      } catch {
        // Unreadable: leave it out.
      }
    }
  }
  return notes;
}

/** Folders two levels deep with file counts and sizes, plus the files at the top. */
export async function summarizeTree(root: string, files: readonly string[]): Promise<FolderSummary[]> {
  const folders = new Map<string, FolderSummary>();
  const top: FolderSummary[] = [];
  for (const path of files.slice(0, 5000)) {
    let bytes = 0;
    try {
      bytes = (await stat(join(root, path))).size;
    } catch {
      continue;
    }
    const parts = path.split("/");
    if (parts.length === 1) {
      top.push({ path, files: 1, bytes });
      continue;
    }
    for (let depth = 1; depth <= Math.min(2, parts.length - 1); depth++) {
      const folder = `${parts.slice(0, depth).join("/")}/`;
      const summary = folders.get(folder) ?? { path: folder, files: 0, bytes: 0 };
      summary.files++;
      summary.bytes += bytes;
      folders.set(folder, summary);
    }
  }
  return [...[...folders.values()].sort((a, b) => a.path.localeCompare(b.path)), ...top];
}

/**
 * Everything the project already holds about how it was built. Refuses the
 * home folder: every session on the machine would match it.
 */
export async function harvestProject(
  folder: string,
  opts: { sessionsRoot?: string; now?: Date } = {},
): Promise<Harvest> {
  const root = await realpath(folder);
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const given = resolve(folder).replace(/\/+$/, "");
  const aliases = given === root ? [root] : [root, given];
  if (root === "/" || root === (await realpath(homedir()))) {
    throw new Error("Pick a project folder, not your home folder: every session would match it.");
  }
  const [sessions, commits, files] = await Promise.all([
    findSessions(aliases, opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot } : {}),
    gitHistory(root),
    projectFiles(root),
  ]);
  const [ownNotes, memory, tree] = await Promise.all([
    findNotes(root, files),
    findMemory(sessions),
    summarizeTree(root, files),
  ]);
  // Claude Code's memory reads after the project's own README, CLAUDE.md and decisions.
  const lead = ownNotes.filter((note) => noteRank(note.path) <= 2);
  const notes = [...lead, ...memory, ...ownNotes.filter((note) => noteRank(note.path) > 2)];
  const name = basename(root).trim() || basename(root);
  return {
    root,
    name,
    gatheredAt: (opts.now ?? new Date()).toISOString(),
    sources: describeSources(sessions, commits, notes, memory, tree),
    sessions,
    commits,
    notes,
    tree,
  };
}

function describeSources(
  sessions: readonly MatchedSession[],
  commits: readonly Commit[],
  allNotes: readonly NoteFile[],
  memory: readonly NoteFile[],
  tree: readonly FolderSummary[],
): Source[] {
  const notes = allNotes.filter((note) => !memory.includes(note));
  // Counted once: a resumed or forked session repeats the history before it.
  const unique = dedupe(sessions);
  const count = (kind: ItemKind) => unique.filter(({ item }) => item.kind === kind).length;
  const topLevel = tree.filter((entry) => depthOf(entry) === 0);
  const files = topLevel.reduce((n, entry) => n + entry.files, 0);
  const bytes = topLevel.reduce((n, entry) => n + entry.bytes, 0);
  const adr = notes.find((note) => note.path.toLowerCase().endsWith("decisions.md"));
  return [
    {
      name: "Claude Code sessions",
      found: sessions.length > 0,
      detail: sessions.length
        ? `${plural(sessions.length, "session")}: ${plural(count("prompt"), "prompt")}, ${plural(count("error"), "error")}, ${plural(count("summary"), "compaction summary", "compaction summaries")}`
        : "none found for this folder",
    },
    {
      name: "Git history",
      found: commits.length > 0,
      detail: commits.length
        ? `${plural(commits.length, "commit")}, ${commits[0]?.date} → ${commits.at(-1)?.date}`
        : "no repository, or no commits yet",
    },
    {
      name: "Notes",
      found: notes.length > 0,
      detail: notes.length
        ? `${plural(notes.length, "file")}: ${notes.slice(0, 6).map((n) => n.path).join(", ")}${notes.length > 6 ? ", …" : ""}`
        : "no README, docs or other notes",
    },
    {
      name: "Claude Code memory",
      found: memory.length > 0,
      detail: memory.length
        ? `${plural(memory.length, "file")}: ${memory.slice(0, 6).map((n) => n.path.replace(/^claude-memory\//, "")).join(", ")}${memory.length > 6 ? ", …" : ""}`
        : "none",
    },
    {
      name: "Decision records",
      found: Boolean(adr),
      detail: adr ? adr.path : "none — anchor modules in sessions, commits or code instead",
    },
    {
      name: "Files",
      found: files > 0,
      detail: `${plural(files, "file")}, ${formatBytes(bytes)}`,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** Rough tokens: a CJK character is about one, other text about four characters each. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Per-item caps in characters, from harvest.py; prompts shrink first when over budget. */
const CAPS: Record<ItemKind, number> = { prompt: 1200, error: 300, summary: 3000, answer: 1200 };
const PROMPT_CAPS = [1200, 800, 500, 300, 200];

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)} …[+${text.length - cap} chars]`;
}

function stamp(at: string): string {
  return at.slice(5, 16).replace("T", " ");
}

function sessionHeading(s: MatchedSession): string {
  return `### ${s.first.slice(0, 10)} → ${s.last.slice(0, 10)} · ${s.title ?? "untitled"} · ${s.id} (${s.why})`;
}

function itemBlock(item: SessionItem, cap: number): string {
  return `--- ${stamp(item.at)} ${item.kind}\n${redact(clip(item.text, cap))}\n`;
}

/** Items repeated by resumed or forked sessions, keyed as harvest.py does. */
function dedupe(sessions: readonly MatchedSession[]): Array<{ session: MatchedSession; item: SessionItem; seq: number }> {
  const seen = new Set<string>();
  const out: Array<{ session: MatchedSession; item: SessionItem; seq: number }> = [];
  let seq = 0;
  for (const session of sessions) {
    for (const item of session.items) {
      const key = `${item.kind}\u0000${item.text.slice(0, 300)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ session, item, seq: seq++ });
    }
  }
  return out;
}

/**
 * The page the model reads first, within `budgetTokens`.
 *
 * When everything does not fit, what the person asked and what broke are kept
 * first — every prompt stays, shortened if need be — then notes, history,
 * compaction summaries, the file list, and answers last. What was left out is
 * counted at the end, with where to find it in full.
 */
export function renderHarvest(h: Harvest, { budgetTokens = 20_000 }: { budgetTokens?: number } = {}): string {
  const head = [
    `# Harvest: ${h.name}`,
    "",
    `Gathered ${h.gatheredAt.slice(0, 10)} from \`${h.root}\`, read-only. Credentials pasted into chats are redacted.`,
    "",
    "## Sources",
    "",
    "| Source | Found | Detail |",
    "|---|---|---|",
    ...h.sources.map((s) => `| ${s.name} | ${s.found ? "yes" : "no"} | ${s.detail} |`),
    "",
  ].join("\n");
  let left = budgetTokens - estimateTokens(head) - 200;

  const items = dedupe(h.sessions);
  const asks = items.filter(({ item }) => item.kind === "prompt" || item.kind === "error");
  const keep = new Set<number>();
  const omitted = new Map<ItemKind | "note" | "commit", number>();
  const omit = (what: ItemKind | "note" | "commit") => omitted.set(what, (omitted.get(what) ?? 0) + 1);

  // What was asked and what broke, with room kept for the notes and history.
  const notesCost = h.notes.reduce((n, note) => n + estimateTokens(note.text) + 10, 0);
  const historyCost = h.commits.reduce((n, c) => n + estimateTokens(commitLine(c)), 0);
  const askBudget = left - Math.min(notesCost + historyCost, Math.floor(left * 0.35));
  let promptCap = PROMPT_CAPS[PROMPT_CAPS.length - 1] ?? 200;
  for (const cap of PROMPT_CAPS) {
    const cost = asks.reduce((n, { item }) => n + estimateTokens(itemBlock(item, item.kind === "prompt" ? cap : CAPS.error)), 0);
    if (cost <= askBudget) {
      promptCap = cap;
      break;
    }
  }
  const capFor = (item: SessionItem) => (item.kind === "prompt" ? promptCap : CAPS[item.kind]);
  let askLeft = askBudget;
  for (const { item, seq } of asks) {
    const cost = estimateTokens(itemBlock(item, capFor(item)));
    if (cost > askLeft) {
      omit(item.kind);
      continue;
    }
    keep.add(seq);
    askLeft -= cost;
    left -= cost;
  }

  const notes: string[] = [];
  for (const note of h.notes) {
    const block = `### ${note.path}\n\n${redact(demoteHeadings(note.text))}\n`;
    const cost = estimateTokens(block);
    if (cost <= left) {
      notes.push(block);
      left -= cost;
    } else if (left > 400) {
      let room = (left - 50) * 4;
      let clipped = `### ${note.path}\n\n${redact(demoteHeadings(clip(note.text, room)))}\n`;
      while (estimateTokens(clipped) > left - 50 && room > 200) {
        room = Math.floor(room * 0.7);
        clipped = `### ${note.path}\n\n${redact(demoteHeadings(clip(note.text, room)))}\n`;
      }
      notes.push(clipped);
      left -= estimateTokens(clipped);
    } else {
      omit("note");
    }
  }

  const history: string[] = [];
  for (const commit of h.commits) {
    const line = redact(commitLine(commit));
    const cost = estimateTokens(line);
    if (cost > left) {
      omit("commit");
      continue;
    }
    history.push(line);
    left -= cost;
  }

  for (const kind of ["summary", "answer"] as const) {
    if (kind === "answer") left -= estimateTokens(treeBlock(h.tree));
    for (const { item, seq } of items) {
      if (item.kind !== kind) continue;
      const cost = estimateTokens(itemBlock(item, CAPS[kind]));
      if (cost > left) {
        omit(kind);
        continue;
      }
      keep.add(seq);
      left -= cost;
    }
  }

  const sessions: string[] = [];
  let current: MatchedSession | null = null;
  for (const { session, item, seq } of items) {
    if (!keep.has(seq)) continue;
    if (session !== current) {
      sessions.push(`\n${sessionHeading(session)}\n`);
      current = session;
    }
    sessions.push(itemBlock(item, capFor(item)));
  }

  const parts = [head];
  if (notes.length) parts.push("## Notes\n", ...notes);
  if (history.length) parts.push("## History\n", history.join("\n"), "");
  if (sessions.length) parts.push("## Sessions", ...sessions);
  parts.push(treeBlock(h.tree));
  const names: Record<ItemKind | "note" | "commit", [string, string]> = {
    prompt: ["prompt", "prompts"],
    error: ["error", "errors"],
    summary: ["compaction summary", "compaction summaries"],
    answer: ["answer", "answers"],
    note: ["note", "notes"],
    commit: ["commit", "commits"],
  };
  const gaps = [...omitted].map(([what, n]) => plural(n, ...names[what]));
  if (gaps.length) {
    parts.push(
      `## Left out for length\n\n${gaps.join(", ")}. Every session in full is in \`sessions/<id>.md\`; every note and file is in the project.\n`,
    );
  }
  return `${parts.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/**
 * A note's own headings, pushed below the `### path` it is filed under, so
 * "## Status" in a README cannot pass for a section of the harvest. Lines
 * inside code fences are left alone.
 */
export function demoteHeadings(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      const match = /^(#{1,6})(\s.*)$/.exec(line);
      if (!match) return line;
      return `${"#".repeat(Math.min(6, (match[1] ?? "").length + 3))}${match[2] ?? ""}`;
    })
    .join("\n");
}

function commitLine(c: Commit): string {
  const stat = c.stat.length ? `\n${c.stat.map((l) => `    ${l.trim()}`).join("\n")}` : "";
  return `- ${c.date} ${c.hash} ${c.subject}${stat}`;
}

/** 0 for a top-level folder or file, 1 for a folder inside one. */
function depthOf(entry: FolderSummary): number {
  return entry.path.endsWith("/") ? entry.path.split("/").length - 2 : 0;
}

function treeBlock(tree: readonly FolderSummary[]): string {
  if (!tree.length) return "## Files\n\nNo files found.\n";
  const lines = tree.map((entry) => {
    const depth = depthOf(entry);
    const what = entry.path.endsWith("/") ? `${plural(entry.files, "file")}, ${formatBytes(entry.bytes)}` : formatBytes(entry.bytes);
    return `${"  ".repeat(depth)}- ${entry.path} — ${what}`;
  });
  return `## Files\n\n${lines.join("\n")}\n`;
}

/** One session in full, for the model to open when the first page is not enough. */
export function renderSession(s: MatchedSession): string {
  const caps: Record<ItemKind, number> = { prompt: 4000, error: 600, summary: 6000, answer: 4000 };
  const body = s.items.map((item) => itemBlock(item, caps[item.kind])).join("\n");
  return `${sessionHeading(s).replace(/^### /, "# ")}\n\nTranscript: \`${s.file}\`\n\n${body}`;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function texts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => isRecord(b) && b.type === "text").map((b) => str((b as Record<string, unknown>).text));
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
