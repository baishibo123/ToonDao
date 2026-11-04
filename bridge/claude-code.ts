/**
 * The Claude Code bridge: a local server that lets ToonDao use a Claude
 * subscription instead of an API key, by running the user's own Claude Code.
 *
 *   app ── OpenAI-style SSE over HTTP ──▶ bridge ── stdin/stdout ──▶ claude -p
 *
 * WHY THIS SHAPE. The app already speaks one provider protocol, so the bridge
 * poses as one more provider and the app changes by one adapter. Claude Code is
 * run unmodified, as the user's own signed-in process, and the bridge never sees
 * a credential: it starts `claude`, writes one message to its stdin, and relays
 * what comes back. Every request is a fresh process in a fresh empty directory,
 * so nothing carries over between requests except what ToonDao itself sends —
 * `assembleContext()` stays the only author of what the model sees.
 *
 * WHAT IT REFUSES. It listens on 127.0.0.1 only, and answers only the app's own
 * pages: any web page in the same browser could otherwise post to it and spend
 * the user's subscription. Model names are checked against a strict pattern
 * because they become a command-line argument, and a value like `--foo` would
 * be read as a flag.
 *
 * Runs directly under Node's TypeScript support (22.18+); start it with
 * `npm run bridge`, which goes through bridge/index.mjs to check the version.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  BRIDGE_EVENT,
  SSE_DONE,
  sseError,
  sseEvent,
  sseText,
  decodeContent,
  isEffort,
  type Effort,
  type RateLimit,
  type ToolScope,
  type Usage,
} from "../src/lib/bridgeProtocol.ts";
import {
  chooseFolder,
  FolderDialogError,
  listProjects,
  projectBySlug,
  snapshotProject,
  snapshotReadDir,
  TOONDAO_HOME,
} from "./projects.ts";
import { API_KEY_FILE, loadApiKey } from "./api-key.ts";

export const DEFAULT_PORT = 8788;

/** Messages API runs allowed in flight at once (TOONDAO_API_CONCURRENCY). Each is a whole Claude Code process. */
export const DEFAULT_API_CONCURRENCY = 4;

/** The app's dev and preview servers. Override with TOONDAO_ORIGINS. */
export const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5273",
  "http://127.0.0.1:5273",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/** Research tools: look things up, never run or write anything. */
export const RESEARCH_TOOLS = ["WebSearch", "WebFetch", "ToolSearch"];

/**
 * Tools for reading a project snapshot (P-31): read-only, in a run whose working
 * directory is the snapshot's `read/` folder. Claude Code reads inside its
 * working directory without asking and asks for anything outside it;
 * `--permission-mode dontAsk` turns every such ask into a refusal, so nothing
 * outside the snapshot can be read.
 */
export const PROJECT_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Tools that run without a prompt in research scope. `-p` has nobody to answer a
 * permission prompt, so anything not listed here is denied. The connector
 * pattern is a best guess until a connector is authorised and it can be checked;
 * override with TOONDAO_ALLOWED_TOOLS.
 */
export const DEFAULT_ALLOWED_TOOLS = ["WebSearch", "WebFetch", "mcp__claude_ai_*"];

const NEUTRAL_SYSTEM_PROMPT = "You are Claude, a helpful AI assistant.";
const MAX_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_RUN_MS = 15 * 60 * 1000;

export interface BridgeOptions {
  port: number;
  allowedOrigins: string[];
  allowedTools: string[];
  claudeBin: string;
  /** Where projects are registered; `~/.toondao` unless a test says otherwise. */
  projectsHome?: string;
  /** Where Claude Code keeps transcripts; `~/.claude/projects` unless a test says otherwise. */
  sessionsRoot?: string;
  /** The folder dialog; macOS's own unless a test stands in for the person. */
  chooseFolder?: () => Promise<string | null>;
  /** The key the Messages API route checks (bridge/api-key.ts); without one that route refuses everything. */
  apiKey?: string;
  /** How many Messages API runs may be in flight at once; more get a 429 the SDKs back off on. */
  apiConcurrency?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  /** ToonDao always sends a string; the Messages API route may send blocks (text, image, document). */
  content: string | InputBlock[];
}

/**
 * A content block Claude Code takes on stdin as it is. Images and documents go
 * through untouched (stream-json input is the one way to send them, P-23);
 * the Messages API route has already checked their shape.
 */
export type InputBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: Record<string, unknown> }
  | { type: "document"; source: Record<string, unknown>; title?: string; context?: string };

/* ------------------------------------------------------------------ */
/* Request checks                                                      */
/* ------------------------------------------------------------------ */

export type Guard = { ok: true } | { ok: false; status: number; message: string };

/**
 * Only the app's own pages, on this machine. A missing Origin means a
 * non-browser client on the same machine (curl, a script), which is allowed;
 * a browser always sends one on a cross-site request, so every other web page
 * is refused. Requiring JSON forces browsers into a CORS preflight, so the
 * check cannot be sidestepped with a "simple" form post. The Host check stops a
 * DNS-rebinding page from reaching the bridge under its own hostname.
 */
export function guardRequest(
  req: { method: string; origin?: string; host?: string; contentType?: string },
  allowedOrigins: readonly string[],
  port: number,
): Guard {
  const hostOk =
    !req.host || req.host === `127.0.0.1:${port}` || req.host === `localhost:${port}`;
  if (!hostOk) return { ok: false, status: 403, message: "Unexpected Host header." };
  if (req.origin && !allowedOrigins.includes(req.origin)) {
    return {
      ok: false,
      status: 403,
      message: `Origin ${req.origin} is not allowed. Add it to TOONDAO_ORIGINS to use the bridge from there.`,
    };
  }
  if (req.method === "POST" && !(req.contentType ?? "").startsWith("application/json")) {
    return { ok: false, status: 415, message: "Send application/json." };
  }
  return { ok: true };
}

/**
 * CORS for an allowed origin only. A preflight's requested headers are allowed
 * back as asked: a browser shell using an Anthropic SDK sends `x-api-key`,
 * `anthropic-version` and a handful of `x-stainless-*` headers, and naming them
 * all here would break with the next SDK. Headers the Messages API answers with
 * are exposed, so such a shell can read them.
 */
export function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
  requestedHeaders?: string,
): Record<string, string> {
  const asked = requestedHeaders && /^[\w-]+(\s*,\s*[\w-]+)*$/.test(requestedHeaders.trim()) ? requestedHeaders.trim() : null;
  return origin && allowed.includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": asked ?? "content-type",
        "Access-Control-Expose-Headers": "request-id, toondao-ignored-params, retry-after, x-should-retry",
        Vary: "Origin",
      }
    : {};
}

/** Aliases (`opus`, `sonnet`, `haiku`, `fable`) or full ids. Never a flag. */
export function isSafeModel(model: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(model);
}

/** Why a model name was refused, in words that point at the fix. */
export function modelProblem(model: string): string | null {
  if (isSafeModel(model)) return null;
  if (model.includes("/")) {
    return `"${model}" is another provider's model name (OpenRouter's, by the look of it). Claude Code takes names like claude-opus-5-5, or an alias such as opus.`;
  }
  return `Not a model name: ${model}`;
}

/* ------------------------------------------------------------------ */
/* Messages → one stream-json user message                             */
/* ------------------------------------------------------------------ */

const TRANSCRIPT_PREAMBLE =
  "The conversation so far is below, one turn per block, oldest first. " +
  "Reply to the final User turn as the Assistant.";

/**
 * ToonDao's assembled payload → the system prompt and one user message.
 *
 * `claude -p` takes one message per run, so a multi-turn payload is written out
 * as a transcript: a fixed preamble, then one text block per turn. One block per
 * turn, and a preamble that never changes, keep each request's prefix
 * byte-identical to the previous one's, which is what prompt caching matches on.
 * A single-message payload — what the lens, the crop and the isolation always
 * assemble to — is sent as it is.
 */
export function toStreamInput(messages: readonly ChatMessage[]): { system: string; line: string } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");

  const blocks: InputBlock[] =
    turns.length === 1 && turns[0].role === "user"
      ? turnBlocks(turns[0], null)
      : [
          { type: "text", text: TRANSCRIPT_PREAMBLE },
          ...turns.flatMap((m) => turnBlocks(m, m.role === "user" ? "User" : "Assistant")),
        ];

  const line = JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: blocks },
  });
  return { system: system || NEUTRAL_SYSTEM_PROMPT, line };
}

/**
 * One turn as blocks. Its text is joined into one block — opening with the
 * speaker when the turn is part of a transcript — and images and documents keep
 * their place around it, so a text-only turn is exactly one block, as it always
 * was, and the cache still matches on it.
 */
function turnBlocks(m: ChatMessage, speaker: "User" | "Assistant" | null): InputBlock[] {
  const parts: InputBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  const out: InputBlock[] = [];
  let labelled = speaker === null;
  let texts: string[] = [];
  const flush = () => {
    if (!texts.length) return;
    out.push({ type: "text", text: `${labelled ? "" : `${speaker}:\n`}${texts.join("\n\n")}` });
    labelled = true;
    texts = [];
  };
  for (const part of parts) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    flush();
    // An image that opens a turn still needs the turn's speaker before it.
    if (!labelled) out.push({ type: "text", text: `${speaker}:` });
    labelled = true;
    out.push(part);
  }
  flush();
  if (!labelled) out.push({ type: "text", text: `${speaker}:\n` });
  return out;
}

function textOf(content: ChatMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
}

/* ------------------------------------------------------------------ */
/* The command line                                                    */
/* ------------------------------------------------------------------ */

/**
 * Flags for one run. `--system-prompt-file` replaces Claude Code's own coding
 * prompt, and is a file rather than an argument so its text can never be parsed
 * as a flag. No session is written to disk, so requests do not pile up in the
 * user's Claude Code history.
 *
 * - `none`: no tools and no MCP servers at all, one turn. For a crop or an
 *   isolation this is the promise itself: nothing but the assembled text.
 * - `research`: web search and fetch, plus the account's connectors through
 *   ToolSearch; a few turns so a lookup can finish.
 */
export function argsFor(args: {
  model: string;
  toolScope: ToolScope;
  systemFile: string;
  allowedTools: readonly string[];
  /** A project snapshot's `read/` folder, from the registry; null when the request may read none.
   *  The run starts there (`runClaude`); here it only decides the tools. */
  readDir?: string | null;
  /** Thinking effort; one of `EFFORTS` only, checked again here because it becomes a flag (P-36). */
  effort?: Effort | null;
  /** The lookup tools to offer when fewer than all of them — the Messages API offers only the ones
   *  a request declared. Never more than `RESEARCH_TOOLS`: anything else is dropped here. */
  researchTools?: readonly string[];
  /** Keep the account's claude.ai connectors out of a research run as well. */
  noConnectors?: boolean;
  /** Run with the person's own Claude Code customizations off — `~/.claude/CLAUDE.md`, hooks,
   *  skills, plugins, MCP servers — while their permission rules still apply (`--safe-mode`).
   *  ToonDao keeps them (P-33); the Messages API does by default (P-41). */
  safeMode?: boolean;
  /** A structured-output schema from `schemaArg()`, checked again here because it becomes an argument. */
  jsonSchema?: string | null;
}): string[] {
  const schema = isSchemaArg(args.jsonSchema) ? args.jsonSchema : null;
  const base = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--system-prompt-file", args.systemFile,
    "--model", args.model,
    ...(isEffort(args.effort) ? ["--effort", args.effort] : []),
    ...(args.safeMode ? ["--safe-mode"] : []),
    // One argument, `--json-schema={…}`: a JSON object can never be read as a flag.
    ...(schema ? [`--json-schema=${schema}`] : []),
  ];
  // A structured answer is a StructuredOutput tool call and its result: two more turns.
  const maxTurns = (turns: number) => ["--max-turns", String(schema ? turns + 2 : turns)];
  const lookups = (args.researchTools ?? RESEARCH_TOOLS).filter((t) => RESEARCH_TOOLS.includes(t));
  if (args.readDir) {
    const research = args.toolScope === "research";
    return [
      ...base,
      "--tools", [...PROJECT_TOOLS, ...(research ? lookups : [])].join(","),
      ...(research ? ["--allowedTools", ...args.allowedTools] : []),
      ...(!research || args.noConnectors ? ["--strict-mcp-config"] : []),
      "--permission-mode", "dontAsk",
      ...maxTurns(12),
    ];
  }
  if (args.toolScope === "research") {
    return [
      ...base,
      "--tools", lookups.join(","),
      "--allowedTools", ...args.allowedTools,
      ...(args.noConnectors ? ["--strict-mcp-config"] : []),
      ...maxTurns(6),
    ];
  }
  return [...base, "--tools", "", "--strict-mcp-config", ...maxTurns(1)];
}

const MAX_SCHEMA_CHARS = 64 * 1024;

/**
 * A structured-output schema as the one argument `--json-schema` takes (Claude
 * Code accepts it inline only, not as a file): the request's value parsed into
 * an object and written out again, so what reaches the command line is JSON this
 * code produced, and always opens with `{`. Null when it is not a JSON object,
 * or is too large to pass as an argument.
 */
export function schemaArg(schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    return null;
  }
  return isSchemaArg(text) ? text : null;
}

/** Is this what `schemaArg()` produces? `argsFor()` asks again before it becomes an argument. */
export function isSchemaArg(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("{") || value.length > MAX_SCHEMA_CHARS) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && JSON.stringify(parsed) === value;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Claude Code events → SSE                                            */
/* ------------------------------------------------------------------ */

/** What a tool call looked up, flattened to one short line. */
export function summarizeToolInput(name: string, input: unknown, relativeTo?: string | null): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  // A file the model opened is named as it sits in the snapshot, not by the
  // snapshot's own path on this machine.
  const local = (value: unknown) =>
    typeof value === "string" && relativeTo && value.startsWith(`${relativeTo}/`)
      ? value.slice(relativeTo.length + 1)
      : value;
  const preferred =
    name === "WebFetch"
      ? record.url
      : name === "WebSearch" || name === "ToolSearch"
        ? record.query
        : name === "Read"
          ? local(record.file_path)
          : name === "Grep" || name === "Glob"
            ? record.pattern
            : undefined;
  const value =
    typeof preferred === "string"
      ? preferred
      : Object.values(record).find((v): v is string => typeof v === "string") ??
        JSON.stringify(input ?? "");
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

export function toRateLimit(info: unknown): RateLimit | null {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const window = typeof record.rateLimitType === "string" ? record.rateLimitType : "";
  const windows = (record.unifiedWindows ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const slot = windows[window] ?? {};
  const utilization = slot.utilization ?? record.utilization;
  const resetsAt = record.resetsAt ?? slot.resetsAt;
  return {
    status: typeof record.status === "string" ? record.status : "",
    window,
    utilization: typeof utilization === "number" ? utilization : null,
    resetsAt: typeof resetsAt === "number" ? resetsAt : null,
  };
}

function toUsage(usage: unknown): Usage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    inputTokens: n(u.input_tokens),
    cacheCreationInputTokens: n(u.cache_creation_input_tokens),
    cacheReadInputTokens: n(u.cache_read_input_tokens),
    outputTokens: n(u.output_tokens),
  };
}

export interface RunSummary {
  /** A result event arrived, successful or not. */
  finished: boolean;
  ok: boolean;
  usage: Usage | null;
  rateLimit: RateLimit | null;
  toolCalls: number;
  apiKeySource: string | null;
}

/**
 * A stateful mapper from Claude Code's stream-json events to SSE frames.
 *
 * Text streams as it is generated. When a tool call splits the answer into
 * several assistant messages, a paragraph break is put between them, so the
 * sentence before a search and the answer after it do not run together.
 */
export function createSseMapper(opts: { relativeTo?: string | null } = {}) {
  let textSent = false;
  let breakPending = false;
  const seenTools = new Set<string>();
  const summary: RunSummary = {
    finished: false,
    ok: false,
    usage: null,
    rateLimit: null,
    toolCalls: 0,
    apiKeySource: null,
  };

  const map = (event: Record<string, unknown>): string[] => {
    const type = event.type;

    if (type === "system" && event.subtype === "init") {
      summary.apiKeySource = typeof event.apiKeySource === "string" ? event.apiKeySource : null;
      return typeof event.model === "string" && event.model
        ? [sseEvent(BRIDGE_EVENT.model, { model: event.model })]
        : [];
    }

    if (type === "stream_event") {
      const inner = (event.event ?? {}) as Record<string, unknown>;
      if (inner.type === "message_start") {
        if (textSent) breakPending = true;
        return [];
      }
      const delta = (inner.delta ?? {}) as Record<string, unknown>;
      if (inner.type === "content_block_delta" && delta.type === "text_delta") {
        const text = typeof delta.text === "string" ? delta.text : "";
        if (!text) return [];
        const frames = breakPending ? [sseText("\n\n")] : [];
        breakPending = false;
        textSent = true;
        frames.push(sseText(text));
        return frames;
      }
      return [];
    }

    if (type === "assistant") {
      const message = (event.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      const frames: string[] = [];
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_use") continue;
        const id = typeof block.id === "string" ? block.id : `${seenTools.size}`;
        if (seenTools.has(id)) continue;
        seenTools.add(id);
        const name = typeof block.name === "string" ? block.name : "tool";
        // ToolSearch only loads another tool's definition (Claude Code defers
        // WebSearch behind it). Nothing from outside enters the context, so the
        // reader is not told about it.
        if (name === "ToolSearch") continue;
        summary.toolCalls += 1;
        frames.push(sseEvent(BRIDGE_EVENT.tool, { name, query: summarizeToolInput(name, block.input, opts.relativeTo) }));
      }
      return frames;
    }

    if (type === "rate_limit_event") {
      const rateLimit = toRateLimit(event.rate_limit_info);
      if (!rateLimit) return [];
      summary.rateLimit = rateLimit;
      return [sseEvent(BRIDGE_EVENT.rate, rateLimit)];
    }

    if (type === "result") {
      const frames: string[] = [];
      const usage = toUsage(event.usage);
      if (usage) {
        summary.usage = usage;
        frames.push(sseEvent(BRIDGE_EVENT.usage, usage));
      }
      const failed = event.is_error === true || event.subtype !== "success";
      summary.finished = true;
      summary.ok = !failed;
      if (failed) frames.push(sseError(resultError(event)));
      frames.push(SSE_DONE);
      return frames;
    }

    return [];
  };

  return { map, summary };
}

/** The reason a run ended badly, in words the reader can act on. */
export function resultError(event: Record<string, unknown>): string {
  if (event.subtype === "error_max_turns") {
    return "Claude Code stopped after the most tool steps a reply may take here. The answer so far is above.";
  }
  const text = typeof event.result === "string" ? event.result.trim() : "";
  if (/does not support this model/i.test(text)) {
    // The server names the version it needs, and lately how to get it too; what
    // it cannot know is that the bridge picks up the new Claude Code by itself.
    return /claude update/i.test(text)
      ? `${text} No need to restart the bridge.`
      : `${text} Update Claude Code with \`claude update\`, then send again — no need to restart the bridge.`;
  }
  return text || `Claude Code ended with ${String(event.subtype ?? "an error")}.`;
}

/* ------------------------------------------------------------------ */
/* Running Claude Code                                                 */
/* ------------------------------------------------------------------ */

export class BridgeError extends Error {}

/**
 * Where every run happens: one empty folder, the same for every request.
 *
 * Claude Code writes its working directory into the context it builds ahead of
 * ToonDao's prompt. A fresh folder per run made that prefix differ every time,
 * so no request could reuse the prompt cache and each turn of a long thread was
 * paid in full; one stable folder lets a turn read everything before it from
 * the cache (P-23). Nothing is ever written here — the system prompt goes to a
 * temporary folder of its own — so no project's CLAUDE.md, settings or files
 * are in reach.
 */
export const RUN_DIR = join(tmpdir(), "toondao-bridge");

/**
 * The environment a run starts with. When the bridge itself was started from
 * inside a Claude Code session (`CLAUDECODE` is set — a dev preview, say), every
 * `CLAUDE*` variable describes that host session: its id, its messaging socket
 * and token, its effort level. A run that inherited them would attach to the
 * host and put per-session details into the prompt, so they are dropped and
 * the run starts as it would from a terminal. Started from a terminal, the
 * environment passes through untouched — except the bridge's own API key
 * (`TOONDAO_API_KEY`), which is the bridge's to check and never Claude Code's.
 */
export function runEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env.CLAUDECODE && env.TOONDAO_API_KEY === undefined) return env;
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => name !== "TOONDAO_API_KEY" && !(env.CLAUDECODE && name.startsWith("CLAUDE")),
    ),
  );
}

/**
 * One run of `claude -p`, as a stream of its stream-json events, in `RUN_DIR` —
 * or, when it may read a project, in that snapshot's `read/` folder, which is
 * the same for every turn of the conversation, so the cache holds there too.
 * Aborting sends SIGINT, which lets Claude Code end the turn cleanly, and
 * SIGKILL a few seconds later if it has not.
 */
export async function* runClaude(args: {
  bin: string;
  model: string;
  toolScope: ToolScope;
  system: string;
  line: string;
  allowedTools: readonly string[];
  readDir?: string | null;
  effort?: Effort | null;
  /** The Messages API's options for the command line; see `argsFor()`. */
  researchTools?: readonly string[];
  noConnectors?: boolean;
  safeMode?: boolean;
  jsonSchema?: string | null;
  /** A request's `max_tokens`, for this run only (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`). */
  maxOutputTokens?: number | null;
  signal: AbortSignal;
}): AsyncGenerator<Record<string, unknown>> {
  await mkdir(RUN_DIR, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "toondao-prompt-"));
  const systemFile = join(dir, "system-prompt.txt");
  await writeFile(systemFile, args.system, "utf8");

  // Aborted while the prompt file was being written (the client left at once):
  // start nothing, rather than a run nobody will read and nothing will stop.
  if (args.signal.aborted) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  const env = runEnv(process.env);
  const maxOutput = args.maxOutputTokens;
  const child = spawn(
    args.bin,
    argsFor({
      model: args.model,
      toolScope: args.toolScope,
      systemFile,
      allowedTools: args.allowedTools,
      readDir: args.readDir ?? null,
      effort: args.effort ?? null,
      ...(args.researchTools ? { researchTools: args.researchTools } : {}),
      noConnectors: args.noConnectors === true,
      safeMode: args.safeMode === true,
      jsonSchema: args.jsonSchema ?? null,
    }),
    {
      cwd: args.readDir ?? RUN_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env:
        typeof maxOutput === "number" && Number.isInteger(maxOutput) && maxOutput > 0
          ? { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput) }
          : env,
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  // A process that never started, or exited before reading its input, turns
  // the stdin write into EPIPE; unhandled, that would take the whole bridge down.
  child.stdin.on("error", () => {});

  let spawnError: BridgeError | null = null;
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      spawnError = new BridgeError(
        err.code === "ENOENT"
          ? `Claude Code was not found (tried "${args.bin}"). Install it, or set CLAUDE_BIN.`
          : `Could not start Claude Code: ${err.message}`,
      );
      reject(spawnError);
    });
  });
  spawnFailed.catch(() => {});
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
    child.once("error", () => resolve(null));
  });

  const stop = () => {
    if (child.exitCode !== null) return;
    child.kill("SIGINT");
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000).unref();
  };
  args.signal.addEventListener("abort", stop, { once: true });
  if (args.signal.aborted) stop();

  try {
    child.stdin.end(`${args.line}\n`);
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([iterator.next(), spawnFailed]);
      if (next.done) break;
      if (!next.value.trim()) continue;
      try {
        yield JSON.parse(next.value) as Record<string, unknown>;
      } catch {
        // Not an event — Claude Code writes the odd notice to stdout.
      }
    }
    const code = await exited;
    if (spawnError) throw spawnError;
    if (code !== 0 && code !== null && !args.signal.aborted) {
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      throw new BridgeError(`Claude Code exited with code ${code}${detail ? `: ${detail}` : "."}`);
    }
  } finally {
    args.signal.removeEventListener("abort", stop);
    stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  orgName: string | null;
}

/**
 * Is Claude Code installed and signed in? Answered by `claude --version` and
 * `claude auth status`, neither of which calls a model, so asking is free. The
 * account's email is deliberately not passed on.
 */
export async function claudeStatus(bin: string): Promise<ClaudeStatus> {
  const empty: ClaudeStatus = {
    installed: false,
    version: null,
    loggedIn: false,
    authMethod: null,
    subscriptionType: null,
    orgName: null,
  };
  const version = await capture(bin, ["--version"]);
  if (version === null) return empty;
  const auth = await capture(bin, ["auth", "status", "--json"]);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = auth ? (JSON.parse(auth) as Record<string, unknown>) : {};
  } catch {
    /* an older Claude Code without --json: report what we know */
  }
  const text = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : null);
  return {
    installed: true,
    version: version.trim().split(/\s+/)[0] ?? null,
    loggedIn: parsed.loggedIn === true,
    authMethod: text("authMethod"),
    subscriptionType: text("subscriptionType"),
    orgName: text("orgName"),
  };
}

function capture(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"], env: runEnv(process.env) });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code === 0 ? out : null));
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

export function startBridge(opts: BridgeOptions): Server {
  const server = createServer((req, res) => {
    void route(req, res, opts).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
      } else {
        res.end();
      }
    });
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

async function route(req: IncomingMessage, res: ServerResponse, opts: BridgeOptions): Promise<void> {
  const origin = header(req, "origin");
  const cors = corsHeaders(origin, opts.allowedOrigins, header(req, "access-control-request-headers"));
  const guard = guardRequest(
    {
      method: req.method ?? "GET",
      origin,
      host: header(req, "host"),
      contentType: header(req, "content-type"),
    },
    opts.allowedOrigins,
    opts.port,
  );
  const path = (req.url ?? "/").split("?")[0];
  if (!guard.ok) {
    // Each front door answers in its own protocol's shape: the Messages API's error envelope there.
    return isMessagesApiPath(path)
      ? json(
          res,
          guard.status,
          { type: "error", error: { type: guard.status === 415 ? "invalid_request_error" : "permission_error", message: guard.message } },
          cors,
        )
      : json(res, guard.status, { error: { message: guard.message } }, cors);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
    return json(res, 200, await claudeStatus(opts.claudeBin), cors);
  }
  if (req.method === "GET" && (path === "/docs" || path === "/v1/docs")) {
    return docs(res, cors);
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return chat(req, res, opts, cors);
  }
  if (path === "/v1/projects" || path.startsWith("/v1/projects/")) {
    return projects(req, res, path, opts, cors);
  }
  if (isMessagesApiPath(path)) {
    // Loaded on first use: messages-api.ts builds on this file, so a static import would be a cycle.
    const { messagesRoute } = await import("./messages-api.ts");
    return messagesRoute(req, res, path, { opts, cors });
  }
  return json(res, 404, { error: { message: `No route for ${req.method} ${path}.` } }, cors);
}

/**
 * The Messages API's document (docs/bridge-api.md), read from disk on every
 * request, so a service integrating with this bridge reads the version it is
 * calling, from the one address it already knows.
 */
export const API_DOC = new URL("../docs/bridge-api.md", import.meta.url);

async function docs(res: ServerResponse, cors: Record<string, string>): Promise<void> {
  let text: string;
  try {
    text = await readFile(API_DOC, "utf8");
  } catch {
    return json(res, 404, { error: { message: "The API document is missing beside the bridge (docs/bridge-api.md)." } }, cors);
  }
  res.writeHead(200, { ...cors, "Content-Type": "text/markdown; charset=utf-8" });
  res.end(text);
}

/** The paths that speak the Anthropic Messages API (bridge/messages-api.ts) rather than ToonDao's protocol. */
export function isMessagesApiPath(path: string): boolean {
  return path === "/v1/messages" || path.startsWith("/v1/messages/") || path === "/v1/models" || path.startsWith("/v1/models/");
}

/** Only one folder dialog at a time: a second click would stack another on top. */
let dialogOpen = false;

/**
 * The project routes (P-29). None of them takes a folder from the request: a
 * new project's folder comes from the dialog the person clicks through, a known
 * one from the registry by its slug. They answer with summaries only — what a
 * snapshot holds is read by the model, never served here.
 *
 *   GET  /v1/projects                  every registered project
 *   POST /v1/projects/choose           open the folder dialog, then snapshot what was picked
 *   POST /v1/projects/<slug>/snapshot  snapshot a registered project again
 */
async function projects(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  opts: BridgeOptions,
  cors: Record<string, string>,
): Promise<void> {
  const home = opts.projectsHome ?? TOONDAO_HOME;
  const where = { home, ...(opts.sessionsRoot ? { sessionsRoot: opts.sessionsRoot } : {}) };
  if (req.method === "GET" && path === "/v1/projects") {
    return json(res, 200, { projects: await listProjects(home) }, cors);
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: `Use POST for ${path}.` } }, cors);
  }
  await readJson(req);

  if (path === "/v1/projects/choose") {
    if (dialogOpen) {
      return json(res, 409, { error: { message: "A folder dialog is already open — look behind this window." } }, cors);
    }
    dialogOpen = true;
    let folder: string | null;
    try {
      folder = await (opts.chooseFolder ?? chooseFolder)();
    } catch (err) {
      const status = err instanceof FolderDialogError ? 501 : 500;
      return json(res, status, { error: { message: err instanceof Error ? err.message : String(err) } }, cors);
    } finally {
      dialogOpen = false;
    }
    if (!folder) return json(res, 200, { cancelled: true }, cors);
    return snapshotAnswer(res, folder, where, cors);
  }

  const match = /^\/v1\/projects\/([^/]+)\/snapshot$/.exec(path);
  const project = match ? await projectBySlug(decodeURIComponent(match[1] ?? ""), home) : null;
  if (!project) return json(res, 404, { error: { message: "No such project." } }, cors);
  return snapshotAnswer(res, project.root, where, cors);
}

async function snapshotAnswer(
  res: ServerResponse,
  folder: string,
  where: { home: string; sessionsRoot?: string },
  cors: Record<string, string>,
): Promise<void> {
  try {
    return json(res, 200, { project: await snapshotProject(folder, where) }, cors);
  } catch (err) {
    // Not a folder, the home folder, gone since it was registered: the person can act on it.
    return json(res, 400, { error: { message: err instanceof Error ? err.message : String(err) } }, cors);
  }
}

async function chat(
  req: IncomingMessage,
  res: ServerResponse,
  opts: BridgeOptions,
  cors: Record<string, string>,
): Promise<void> {
  const body = await readJson(req);
  const messages = parseMessages(body.messages);
  if (!messages) {
    return json(res, 400, { error: { message: "`messages` must be an array of text messages." } }, cors);
  }
  const model = typeof body.model === "string" && body.model ? body.model : "opus";
  const problem = modelProblem(model);
  if (problem) return json(res, 400, { error: { message: problem } }, cors);
  const extension = (body.toondao ?? {}) as Record<string, unknown>;
  const toolScope: ToolScope = extension.toolScope === "research" ? "research" : "none";
  // Only a known level becomes `--effort`; anything else is dropped, not passed on.
  const effort: Effort | null = isEffort(extension.effort) ? extension.effort : null;
  // A project snapshot to read, named by slug and snapshot id; the folder comes
  // from the registry. A request that names one the registry does not hold is
  // refused rather than answered without it.
  let readDir: string | null = null;
  if (extension.project && typeof extension.project === "object") {
    const ref = extension.project as Record<string, unknown>;
    readDir =
      typeof ref.slug === "string" && typeof ref.snapshot === "string"
        ? await snapshotReadDir(ref.slug, ref.snapshot, opts.projectsHome ?? TOONDAO_HOME)
        : null;
    if (!readDir) {
      return json(
        res,
        400,
        { error: { message: "That project snapshot is not available. Take a new snapshot in Settings → Projects." } },
        cors,
      );
    }
  }

  res.writeHead(200, {
    ...cors,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const timer = setTimeout(() => controller.abort(), MAX_RUN_MS);
  const started = Date.now();
  const { system, line } = toStreamInput(messages);
  const mapper = createSseMapper({ relativeTo: readDir });

  try {
    for await (const event of runClaude({
      bin: opts.claudeBin,
      model,
      toolScope,
      system,
      line,
      allowedTools: opts.allowedTools,
      readDir,
      effort,
      signal: controller.signal,
    })) {
      for (const frame of mapper.map(event)) res.write(frame);
    }
    if (!mapper.summary.finished && !controller.signal.aborted) {
      // Exited without a result event: say so, rather than end on silence.
      res.write(sseError("Claude Code ended without an answer."));
      res.write(SSE_DONE);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      res.write(sseError(err instanceof Error ? err.message : String(err)));
      res.write(SSE_DONE);
    }
  } finally {
    clearTimeout(timer);
    res.end();
    logRun({
      model,
      toolScope: `${readDir ? `${toolScope}+project` : toolScope}${effort ? ` effort=${effort}` : ""}`,
      ms: Date.now() - started,
      aborted: controller.signal.aborted,
      ...mapper.summary,
    });
  }
}

/** One line per request: numbers only, never content. */
export function logRun(run: RunSummary & { model: string; toolScope: string; ms: number; aborted: boolean }) {
  const u = run.usage;
  const window = run.rateLimit?.utilization;
  const parts = [
    run.aborted ? "stopped" : run.ok ? "ok" : "error",
    run.model,
    run.toolScope,
    `${(run.ms / 1000).toFixed(1)}s`,
    u ? `in=${u.inputTokens} cache_write=${u.cacheCreationInputTokens} cache_read=${u.cacheReadInputTokens} out=${u.outputTokens}` : "",
    run.toolCalls ? `tools=${run.toolCalls}` : "",
    typeof window === "number" ? `${run.rateLimit?.window}=${Math.round(window * 100)}%` : "",
    run.apiKeySource && run.apiKeySource !== "none" ? `auth=${run.apiKeySource}` : "",
  ];
  console.log(`[bridge] ${parts.filter(Boolean).join(" ")}`);
}

function parseMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { role, content } = item as Record<string, unknown>;
    if (role !== "system" && role !== "user" && role !== "assistant") return null;
    // A question's files arrive as blocks (P-43); the shared decoder admits only base64 images and PDFs.
    const decoded = decodeContent(content);
    if (decoded === null) return null;
    out.push({ role, content: decoded });
  }
  return out;
}

/** A request's body, refused past `MAX_BODY_BYTES` (thrown as `BodyTooLarge`). */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class BodyTooLarge extends BridgeError {}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string>) {
  res.writeHead(status, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function main(): Promise<void> {
  const env = process.env;
  const opts: BridgeOptions = {
    port: Number(env.PORT ?? DEFAULT_PORT),
    allowedOrigins: env.TOONDAO_ORIGINS
      ? env.TOONDAO_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ORIGINS,
    allowedTools: env.TOONDAO_ALLOWED_TOOLS
      ? env.TOONDAO_ALLOWED_TOOLS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ALLOWED_TOOLS,
    claudeBin: env.CLAUDE_BIN ?? "claude",
    apiConcurrency: Math.max(1, Number(env.TOONDAO_API_CONCURRENCY) || DEFAULT_API_CONCURRENCY),
  };
  const apiKey = await loadApiKey();
  opts.apiKey = apiKey.key;

  const status = await claudeStatus(opts.claudeBin);
  const server = startBridge(opts);
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `[bridge] Port ${opts.port} is already in use. Stop the other process or set PORT.`
        : `[bridge] ${err.message}`,
    );
    process.exit(1);
  });
  server.on("listening", () => {
    console.log(`[bridge] ToonDao ↔ Claude Code on http://127.0.0.1:${opts.port}/v1`);
    if (!status.installed) {
      console.log(`[bridge] Claude Code was not found. Install it first, or set CLAUDE_BIN.`);
    } else if (!status.loggedIn) {
      console.log(`[bridge] Claude Code ${status.version} is installed but not signed in. Run \`claude\` once and sign in.`);
    } else {
      console.log(
        `[bridge] Claude Code ${status.version}, signed in (${[status.subscriptionType, status.orgName].filter(Boolean).join(", ")}).`,
      );
    }
    console.log(`[bridge] In ToonDao: Settings → Provider → "Claude Code (local bridge)".`);
    const where =
      apiKey.source === "env" ? "TOONDAO_API_KEY" : `${API_KEY_FILE}${apiKey.source === "created" ? " (new)" : ""}`;
    console.log(`[bridge] Other services: Messages API at http://127.0.0.1:${opts.port}/v1/messages, key in ${where}.`);
    console.log(`[bridge] How to call it: http://127.0.0.1:${opts.port}/docs`);
  });
}
