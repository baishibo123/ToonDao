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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  BRIDGE_EVENT,
  SSE_DONE,
  sseError,
  sseEvent,
  sseText,
  type RateLimit,
  type ToolScope,
  type Usage,
} from "../src/lib/bridgeProtocol.ts";

export const DEFAULT_PORT = 8788;

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
 * Tools that run without a prompt in research scope. `-p` has nobody to answer a
 * permission prompt, so anything not listed here is denied. The connector
 * pattern is a best guess until a connector is authorised and it can be checked;
 * override with TOONDAO_ALLOWED_TOOLS.
 */
export const DEFAULT_ALLOWED_TOOLS = ["WebSearch", "WebFetch", "mcp__claude_ai_*"];

const NEUTRAL_SYSTEM_PROMPT = "You are Claude, a helpful AI assistant.";
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_RUN_MS = 15 * 60 * 1000;

export interface BridgeOptions {
  port: number;
  allowedOrigins: string[];
  allowedTools: string[];
  claudeBin: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

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

export function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  return origin && allowed.includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
        Vary: "Origin",
      }
    : {};
}

/** Aliases (`opus`, `sonnet`, `haiku`, `fable`) or full ids. Never a flag. */
export function isSafeModel(model: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(model);
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
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");

  const blocks =
    turns.length === 1 && turns[0].role === "user"
      ? [{ type: "text", text: turns[0].content }]
      : [
          { type: "text", text: TRANSCRIPT_PREAMBLE },
          ...turns.map((m) => ({
            type: "text",
            text: `${m.role === "user" ? "User" : "Assistant"}:\n${m.content}`,
          })),
        ];

  const line = JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: blocks },
  });
  return { system: system || NEUTRAL_SYSTEM_PROMPT, line };
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
}): string[] {
  const base = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--system-prompt-file", args.systemFile,
    "--model", args.model,
  ];
  if (args.toolScope === "research") {
    return [
      ...base,
      "--tools", RESEARCH_TOOLS.join(","),
      "--allowedTools", ...args.allowedTools,
      "--max-turns", "6",
    ];
  }
  return [...base, "--tools", "", "--strict-mcp-config", "--max-turns", "1"];
}

/* ------------------------------------------------------------------ */
/* Claude Code events → SSE                                            */
/* ------------------------------------------------------------------ */

/** What a tool call looked up, flattened to one short line. */
export function summarizeToolInput(name: string, input: unknown): string {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const preferred =
    name === "WebFetch" ? record.url : name === "WebSearch" || name === "ToolSearch" ? record.query : undefined;
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
export function createSseMapper() {
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
      return [];
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
        frames.push(sseEvent(BRIDGE_EVENT.tool, { name, query: summarizeToolInput(name, block.input) }));
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
function resultError(event: Record<string, unknown>): string {
  if (event.subtype === "error_max_turns") {
    return "Claude Code stopped after the most tool steps a reply may take here. The answer so far is above.";
  }
  const text = typeof event.result === "string" ? event.result.trim() : "";
  return text || `Claude Code ended with ${String(event.subtype ?? "an error")}.`;
}

/* ------------------------------------------------------------------ */
/* Running Claude Code                                                 */
/* ------------------------------------------------------------------ */

export class BridgeError extends Error {}

/**
 * One run of `claude -p`, as a stream of its stream-json events. A fresh empty
 * directory per run, so no project's CLAUDE.md, settings or files are in reach,
 * removed afterwards. Aborting sends SIGINT, which lets Claude Code end the turn
 * cleanly, and SIGKILL a few seconds later if it has not.
 */
export async function* runClaude(args: {
  bin: string;
  model: string;
  toolScope: ToolScope;
  system: string;
  line: string;
  allowedTools: readonly string[];
  signal: AbortSignal;
}): AsyncGenerator<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "toondao-"));
  const systemFile = join(dir, "system-prompt.txt");
  await writeFile(systemFile, args.system, "utf8");

  const child = spawn(
    args.bin,
    argsFor({ model: args.model, toolScope: args.toolScope, systemFile, allowedTools: args.allowedTools }),
    { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: process.env },
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
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
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
  const cors = corsHeaders(origin, opts.allowedOrigins);
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
  if (!guard.ok) return json(res, guard.status, { error: { message: guard.message } }, cors);

  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
    return json(res, 200, await claudeStatus(opts.claudeBin), cors);
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    return chat(req, res, opts, cors);
  }
  return json(res, 404, { error: { message: `No route for ${req.method} ${path}.` } }, cors);
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
  if (!isSafeModel(model)) {
    return json(res, 400, { error: { message: `Not a model name: ${model}` } }, cors);
  }
  const extension = (body.toondao ?? {}) as Record<string, unknown>;
  const toolScope: ToolScope = extension.toolScope === "research" ? "research" : "none";

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
  const mapper = createSseMapper();

  try {
    for await (const event of runClaude({
      bin: opts.claudeBin,
      model,
      toolScope,
      system,
      line,
      allowedTools: opts.allowedTools,
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
    logRun({ model, toolScope, ms: Date.now() - started, aborted: controller.signal.aborted, ...mapper.summary });
  }
}

/** One line per request: numbers only, never content. */
function logRun(run: RunSummary & { model: string; toolScope: ToolScope; ms: number; aborted: boolean }) {
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
    if (typeof content !== "string") return null;
    out.push({ role, content });
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BridgeError("Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
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
  };

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
  });
}
