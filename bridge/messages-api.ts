/**
 * The bridge's second front door: the Anthropic Messages API, for chat shells
 * other than ToonDao (docs/bridge-api.md).
 *
 *   shell ── POST /v1/messages (x-api-key) ──▶ bridge ── stdin/stdout ──▶ claude -p
 *
 * WHY THIS SHAPE. A shell built for the API — an official SDK with its base URL
 * pointed here, curl, anything hand-written — should work unchanged, so the
 * request fields, the response object, the SSE event sequence and the error
 * envelope are the API's own. Claude Code's raw stream events already are the
 * API's events; what this file adds is the seam: Claude Code may make several
 * model calls for one answer (a web lookup is a tool loop), and the client must
 * see one message.
 *
 * WHAT IT HONOURS. Every request field is in one of three classes. Honoured:
 * mapped onto a flag, the stdin message, or the event translation. Ignored, in
 * the open: it cannot change what a correct answer looks like (sampling
 * settings, metadata), and the response names it back in `toondao-ignored-params`.
 * Refused with a 400: it promises a capability the run would silently fail to
 * deliver — a client tool, forced tool use, prefill. Nothing is faked.
 *
 * Everything else is the bridge as ToonDao uses it: one stateless `claude -p` per
 * request in one empty folder, the conversation written as a transcript (P-23),
 * no tool that runs commands or writes files.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  isEffort,
  type Effort,
  type ProjectRef,
  type RateLimit,
  type ToolUse,
} from "../src/lib/bridgeProtocol.ts";
import { checkApiKey } from "./api-key.ts";
import {
  BodyTooLarge,
  DEFAULT_API_CONCURRENCY,
  MAX_RUN_MS,
  header,
  isSafeModel,
  logRun,
  modelProblem,
  readBody,
  resultError,
  runClaude,
  schemaArg,
  summarizeToolInput,
  toRateLimit,
  toStreamInput,
  type BridgeOptions,
  type ChatMessage,
  type InputBlock,
} from "./claude-code.ts";
import { snapshotReadDir, TOONDAO_HOME } from "./projects.ts";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ApiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

/** An error as the API reports it, plus the retry hints its SDKs read. */
export interface ApiError {
  status: number;
  type: ApiErrorType;
  message: string;
  /** Seconds to wait before trying again (`retry-after`). */
  retryAfter?: number;
  /** Whether trying again can help (`x-should-retry`); the SDKs honour it. */
  shouldRetry?: boolean;
}

/** The lookup tools a request may declare, as Claude Code names them. */
export type WebTool = "WebSearch" | "WebFetch";

/** A `/v1/messages` body, checked and reduced to what the run needs. */
export interface ApiRequest {
  model: string;
  /** The system prompt first (when there is one), then the turns: what `toStreamInput()` takes. */
  messages: ChatMessage[];
  stream: boolean;
  maxTokens: number | null;
  stopSequences: string[];
  effort: Effort | null;
  /** From `output_config.format`, already `schemaArg()`'s output. */
  jsonSchema: string | null;
  webTools: WebTool[];
  project: ProjectRef | null;
  /** Bring the person's own Claude Code settings and `~/.claude/CLAUDE.md` along (off by default). */
  userInstructions: boolean;
  /** Fields accepted but not honoured, named back to the client. */
  ignored: string[];
}

export type ParseResult = { ok: true; request: ApiRequest } | { ok: false; error: ApiError };

/** One Messages API stream event: its SSE name and its JSON payload. */
export interface ApiEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface ApiUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

/** Top-level fields this route reads. Anything else is ignored and named back, except `REFUSED`. */
const HONOURED = new Set([
  "model",
  "messages",
  "system",
  "max_tokens",
  "stop_sequences",
  "stream",
  "output_config",
  "thinking",
  "tools",
  "tool_choice",
  "toondao",
]);

/** Fields whose absence would change what the answer means: refused whenever they say anything. */
const REFUSED: Record<string, string> = {
  mcp_servers: "MCP servers are not available through the bridge.",
};

/** Blocks a conversation carries from earlier replies — reasoning, the server's own tool loop. Dropped. */
const DROPPED_BLOCKS = new Set([
  "thinking",
  "redacted_thinking",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
]);

const MAX_STOP_SEQUENCES = 16;
const MAX_STOP_SEQUENCE_CHARS = 1000;

/**
 * A `/v1/messages` body → the request, or the first thing wrong with it as an
 * `invalid_request_error`. Every field lands in one of three classes; see the
 * file comment.
 */
export function parseMessagesRequest(body: unknown): ParseResult {
  if (!isRecord(body)) return invalid("The request body must be a JSON object.");

  const ignored: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (HONOURED.has(key)) continue;
    if (key in REFUSED) {
      if (value != null && !(Array.isArray(value) && value.length === 0)) return invalid(`${key}: ${REFUSED[key]}`);
      continue;
    }
    ignored.push(key);
  }

  const model = body.model;
  if (typeof model !== "string" || !model) return invalid("model: Field required.");
  const problem = modelProblem(model);
  if (problem) return invalid(`model: ${problem}`);

  const system = parseSystem(body.system);
  if (system === null) return invalid("system: must be a string or a list of text blocks.");

  const turns = parseTurns(body.messages);
  if (!turns.ok) return turns;

  if (body.stream != null && typeof body.stream !== "boolean") return invalid("stream: must be true or false.");

  let maxTokens: number | null = null;
  if (body.max_tokens != null) {
    if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
      return invalid("max_tokens: must be a positive integer.");
    }
    maxTokens = body.max_tokens;
  }

  let stopSequences: string[] = [];
  if (body.stop_sequences != null) {
    const list = body.stop_sequences;
    if (
      !Array.isArray(list) ||
      list.length > MAX_STOP_SEQUENCES ||
      !list.every((s) => typeof s === "string" && s.trim() !== "" && s.length <= MAX_STOP_SEQUENCE_CHARS)
    ) {
      return invalid(
        `stop_sequences: must be a list of at most ${MAX_STOP_SEQUENCES} non-blank strings, each at most ${MAX_STOP_SEQUENCE_CHARS} characters.`,
      );
    }
    stopSequences = list as string[];
  }

  let effort: Effort | null = null;
  let jsonSchema: string | null = null;
  if (body.output_config != null) {
    const config = body.output_config;
    if (!isRecord(config)) return invalid("output_config: must be an object.");
    for (const key of Object.keys(config)) {
      if (key !== "effort" && key !== "format") ignored.push(`output_config.${key}`);
    }
    if (config.effort != null) {
      if (!isEffort(config.effort)) return invalid("output_config.effort: must be one of low, medium, high, xhigh, max.");
      effort = config.effort;
    }
    if (config.format != null) {
      const format = config.format;
      if (!isRecord(format) || format.type !== "json_schema") {
        return invalid('output_config.format: only {"type": "json_schema", "schema": {…}} is supported.');
      }
      jsonSchema = schemaArg(format.schema);
      if (!jsonSchema) return invalid("output_config.format.schema: must be a JSON object, under 64 KB.");
    }
  }

  if (body.thinking != null) {
    const thinking = body.thinking;
    if (!isRecord(thinking)) return invalid("thinking: must be an object.");
    // Claude Code decides how the model thinks; only "adaptive, not shown" is what it does anyway.
    if (thinking.type !== "adaptive") ignored.push("thinking");
    else if (thinking.display != null && thinking.display !== "omitted") ignored.push("thinking.display");
  }

  const tools = parseTools(body.tools, ignored);
  if (!tools.ok) return tools;
  let webTools = tools.webTools;

  if (body.tool_choice != null) {
    const choice = body.tool_choice;
    if (!isRecord(choice)) return invalid("tool_choice: must be an object.");
    if (choice.type === "any" || choice.type === "tool") {
      return invalid('tool_choice: types "any" and "tool" are not supported (nor by the API on current models); use "auto".');
    }
    if (choice.type === "none") webTools = [];
    else if (choice.type !== "auto") return invalid('tool_choice.type: must be "auto" or "none".');
    if (choice.disable_parallel_tool_use != null) ignored.push("tool_choice.disable_parallel_tool_use");
  }

  let project: ProjectRef | null = null;
  let userInstructions = false;
  if (body.toondao != null) {
    const extension = body.toondao;
    if (!isRecord(extension)) return invalid("toondao: must be an object.");
    for (const key of Object.keys(extension)) {
      if (key !== "project" && key !== "user_instructions") ignored.push(`toondao.${key}`);
    }
    if (extension.project != null) {
      const ref = extension.project;
      if (!isRecord(ref) || typeof ref.slug !== "string" || typeof ref.snapshot !== "string") {
        return invalid("toondao.project: must be {\"slug\": …, \"snapshot\": …}, as GET /v1/projects lists them.");
      }
      project = { slug: ref.slug, snapshot: ref.snapshot };
    }
    if (extension.user_instructions != null) {
      if (typeof extension.user_instructions !== "boolean") return invalid("toondao.user_instructions: must be true or false.");
      userInstructions = extension.user_instructions;
    }
  }

  return {
    ok: true,
    request: {
      model,
      messages: [...(system ? [{ role: "system" as const, content: system }] : []), ...turns.turns],
      stream: body.stream === true,
      maxTokens,
      stopSequences,
      effort,
      jsonSchema,
      webTools,
      project,
      userInstructions,
      ignored,
    },
  };
}

function parseSystem(value: unknown): string | null {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const texts: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
    texts.push(block.text);
  }
  return texts.join("\n\n");
}

function parseTurns(value: unknown): { ok: true; turns: ChatMessage[] } | { ok: false; error: ApiError } {
  if (!Array.isArray(value) || value.length === 0) return invalid("messages: at least one message is required.");
  const turns: ChatMessage[] = [];
  for (const [i, item] of value.entries()) {
    if (!isRecord(item)) return invalid(`messages.${i}: must be an object.`);
    if (item.role === "system") {
      return invalid(`messages.${i}: a system turn inside the conversation is not supported here; put it in the top-level \`system\`.`);
    }
    if (item.role !== "user" && item.role !== "assistant") return invalid(`messages.${i}.role: must be "user" or "assistant".`);
    const content = parseContent(item.content, `messages.${i}.content`);
    if (!content.ok) return content;
    if (Array.isArray(content.content) && content.content.length === 0) {
      // An earlier reply that only thought (its blocks all dropped) leaves nothing to show;
      // a question with nothing in it is a mistake.
      if (item.role === "assistant") continue;
      return invalid(`messages.${i}.content: must not be empty.`);
    }
    turns.push({ role: item.role, content: content.content });
  }
  const last = value[value.length - 1] as Record<string, unknown>;
  if (last.role !== "user") {
    return invalid(
      "messages: the last message must be from the user. Prefilling the reply is not supported (nor by the API on current models).",
    );
  }
  return { ok: true, turns };
}

function parseContent(
  value: unknown,
  where: string,
): { ok: true; content: string | InputBlock[] } | { ok: false; error: ApiError } {
  if (typeof value === "string") return { ok: true, content: value };
  if (!Array.isArray(value)) return invalid(`${where}: must be a string or a list of content blocks.`);
  const blocks: InputBlock[] = [];
  for (const [j, block] of value.entries()) {
    const at = `${where}.${j}`;
    if (!isRecord(block) || typeof block.type !== "string") return invalid(`${at}: must be a content block.`);
    if (DROPPED_BLOCKS.has(block.type)) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") return invalid(`${at}.text: must be a string.`);
        blocks.push({ type: "text", text: block.text });
        break;
      case "image": {
        const source = imageSource(block.source);
        if (!source) return invalid(`${at}.source: must be {"type": "base64", "media_type", "data"} or {"type": "url", "url"}.`);
        blocks.push({ type: "image", source });
        break;
      }
      case "document": {
        const source = documentSource(block.source);
        if (!source) {
          return invalid(
            `${at}.source: must be a base64 PDF, {"type": "text", "media_type": "text/plain", "data"}, or {"type": "url", "url"}.`,
          );
        }
        blocks.push({
          type: "document",
          source,
          ...(typeof block.title === "string" ? { title: block.title } : {}),
          ...(typeof block.context === "string" ? { context: block.context } : {}),
        });
        break;
      }
      case "tool_use":
      case "tool_result":
        return invalid(`${at}: ${block.type} blocks need client tools, which the bridge does not run.`);
      default:
        return invalid(`${at}: blocks of type "${block.type}" are not supported here.`);
    }
  }
  return { ok: true, content: blocks };
}

function imageSource(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.type === "base64" && typeof value.media_type === "string" && typeof value.data === "string") {
    return { type: "base64", media_type: value.media_type, data: value.data };
  }
  if (value.type === "url" && typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
    return { type: "url", url: value.url };
  }
  return null;
}

function documentSource(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.type === "base64" && value.media_type === "application/pdf" && typeof value.data === "string") {
    return { type: "base64", media_type: "application/pdf", data: value.data };
  }
  if (value.type === "text" && typeof value.data === "string") {
    return { type: "text", media_type: "text/plain", data: value.data };
  }
  if (value.type === "url" && typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
    return { type: "url", url: value.url };
  }
  return null;
}

/**
 * The web server tools become Claude Code's own lookup tools; nothing else can be
 * offered, because a client tool needs a loop in which the client runs it, and a
 * stateless `claude -p` run is not that loop.
 */
function parseTools(
  value: unknown,
  ignored: string[],
): { ok: true; webTools: WebTool[] } | { ok: false; error: ApiError } {
  if (value == null) return { ok: true, webTools: [] };
  if (!Array.isArray(value)) return invalid("tools: must be a list.");
  const found = new Set<WebTool>();
  for (const [i, tool] of value.entries()) {
    if (!isRecord(tool)) return invalid(`tools.${i}: must be an object.`);
    const type = typeof tool.type === "string" ? tool.type : "";
    const web = /^web_search_\d+$/.test(type) ? "web_search" : /^web_fetch_\d+$/.test(type) ? "web_fetch" : null;
    if (!web) {
      if (!type || type === "custom" || "input_schema" in tool) {
        return invalid(
          `tools.${i}: client tools need a tool loop the bridge does not run; only the web_search and web_fetch server tools are available.`,
        );
      }
      return invalid(`tools.${i}: ${type} is not available through the bridge; only web_search and web_fetch are.`);
    }
    found.add(web === "web_search" ? "WebSearch" : "WebFetch");
    for (const key of Object.keys(tool)) {
      if (key !== "type" && key !== "name" && key !== "cache_control") ignored.push(`${web}.${key}`);
    }
  }
  return { ok: true, webTools: [...found] };
}

/* ------------------------------------------------------------------ */
/* Claude Code events → Messages API events                            */
/* ------------------------------------------------------------------ */

export interface TranslatorOptions {
  /** The message id the client sees. */
  id: string;
  /** As requested; replaced by the id Claude Code resolved it to. */
  model: string;
  stopSequences?: readonly string[];
  /** The request's `max_tokens`. When set, the first `max_tokens` stop ends the reply: left alone,
   *  Claude Code would ask the model to resume, and then fail. */
  maxTokens?: number | null;
  /** A JSON schema was given: text is withheld, and the validated JSON is the reply. */
  structured?: boolean;
  /** A project snapshot's `read/` folder, so a file the model opened is named as it sits in the snapshot. */
  relativeTo?: string | null;
}

export interface TranslatorState {
  /** `message_start` has been emitted: from here on a failure is an `error` event, not an HTTP status. */
  started: boolean;
  /** The reply is settled; later Claude Code events change nothing the client sees. */
  done: boolean;
  /** The bridge should end the run now: a stop sequence matched, or `max_tokens` was reached. */
  stopRequested: boolean;
  failure: ApiError | null;
  model: string;
  stopReason: string | null;
  stopSequence: string | null;
  tools: ToolUse[];
  rateLimit: RateLimit | null;
  notices: string[];
  apiKeySource: string | null;
  usage: ApiUsage;
  webSearches: number;
  webFetches: number;
}

const MAX_TURNS_NOTICE =
  "Claude Code stopped after the most tool steps a reply may take here; the answer may be incomplete.";

const STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "refusal"]);

/**
 * One run's Claude Code events → the API events of one message.
 *
 * Claude Code makes one model call per step of its tool loop and streams each as
 * a message of its own; the client sees them as one. Text and thinking blocks
 * pass through with indices renumbered across the calls; tool calls are Claude
 * Code's business and are hidden, reported instead as `toondao.tool` events and
 * counted into `usage.server_tool_use`. Usage is summed over the calls.
 *
 * `push()` returns what to send now; `finish()` closes the message once the run
 * is over — after a cut, too, so the cut call's usage is in.
 */
export function createMessagesTranslator(opts: TranslatorOptions) {
  const stops = (opts.stopSequences ?? []).filter(Boolean);
  const holdBack = stops.reduce((n, s) => Math.max(n, s.length), 0) - 1;
  const state: TranslatorState = {
    started: false,
    done: false,
    stopRequested: false,
    failure: null,
    model: opts.model,
    stopReason: null,
    stopSequence: null,
    tools: [],
    rateLimit: null,
    notices: [],
    apiKeySource: null,
    usage: emptyUsage(),
    webSearches: 0,
    webFetches: 0,
  };

  let firstUsage: ApiUsage | null = null;
  const perCall: ApiUsage[] = [];
  /** False once a call starts after the reply was settled: its usage is not this reply's. */
  let counting = true;
  let stopDetails: unknown = null;
  let blockMap = new Map<number, number | null>();
  let nextIndex = 0;
  const open = new Set<number>();
  /** Text not yet sent because a stop sequence could still be completing in it. */
  const held = new Map<number, string>();
  const seenTools = new Set<string>();
  let finished = false;

  const start = (): ApiEvent[] => {
    if (state.started) return [];
    state.started = true;
    const usage = firstUsage ?? emptyUsage();
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: opts.id,
            type: "message",
            role: "assistant",
            model: state.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            stop_details: null,
            usage,
          },
        },
      },
    ];
  };

  const delta = (index: number, payload: Record<string, unknown>): ApiEvent => ({
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta: payload },
  });

  const closeBlock = (index: number): ApiEvent[] => {
    if (!open.has(index)) return [];
    open.delete(index);
    const rest = held.get(index) ?? "";
    held.delete(index);
    return [
      ...(rest ? [delta(index, { type: "text_delta", text: rest })] : []),
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    ];
  };

  const closeAll = (): ApiEvent[] => [...open].sort((a, b) => a - b).flatMap(closeBlock);

  /** Settle the reply here and ask for the run to end; `finish()` adds the closing events. */
  const cut = (): ApiEvent[] => {
    state.done = true;
    state.stopRequested = true;
    return closeAll();
  };

  const textDelta = (index: number, text: string): ApiEvent[] => {
    if (!text) return [];
    if (!stops.length) return [delta(index, { type: "text_delta", text })];
    const pending = (held.get(index) ?? "") + text;
    let hit: { at: number; sequence: string } | null = null;
    for (const sequence of stops) {
      const at = pending.indexOf(sequence);
      if (at !== -1 && (!hit || at < hit.at)) hit = { at, sequence };
    }
    if (hit) {
      held.delete(index);
      state.stopReason = "stop_sequence";
      state.stopSequence = hit.sequence;
      const before = pending.slice(0, hit.at);
      return [...(before ? [delta(index, { type: "text_delta", text: before })] : []), ...cut()];
    }
    // Keep back as much as could be the start of a stop sequence, never half a surrogate pair.
    let safe = pending.length - holdBack;
    if (safe > 0 && isHighSurrogate(pending.charCodeAt(safe - 1))) safe -= 1;
    if (safe <= 0) {
      held.set(index, pending);
      return [];
    }
    held.set(index, pending.slice(safe));
    return [delta(index, { type: "text_delta", text: pending.slice(0, safe) })];
  };

  const streamEvent = (inner: Record<string, unknown>): ApiEvent[] => {
    switch (inner.type) {
      case "message_start": {
        blockMap = new Map();
        if (state.done) {
          counting = false;
          return [];
        }
        const message = isRecord(inner.message) ? inner.message : {};
        if (typeof message.model === "string" && message.model) state.model = message.model;
        const usage = toApiUsage(message.usage, emptyUsage());
        perCall.push(usage);
        if (!state.started) {
          firstUsage = usage;
          return start();
        }
        return [];
      }
      case "content_block_start": {
        if (state.done || typeof inner.index !== "number") return [];
        const block = visibleBlock(inner.content_block, opts.structured === true);
        if (!block) {
          blockMap.set(inner.index, null);
          return [];
        }
        const index = nextIndex++;
        blockMap.set(inner.index, index);
        open.add(index);
        return [...start(), { event: "content_block_start", data: { type: "content_block_start", index, content_block: block } }];
      }
      case "content_block_delta": {
        if (state.done || typeof inner.index !== "number") return [];
        const index = blockMap.get(inner.index);
        if (index == null) return [];
        const d = isRecord(inner.delta) ? inner.delta : {};
        if (d.type === "text_delta") return textDelta(index, typeof d.text === "string" ? d.text : "");
        if (d.type === "thinking_delta") return [delta(index, { type: "thinking_delta", thinking: str(d.thinking) })];
        if (d.type === "signature_delta") return [delta(index, { type: "signature_delta", signature: str(d.signature) })];
        return []; // citations of Claude Code's own tool results, tool input: not the client's
      }
      case "content_block_stop": {
        if (state.done || typeof inner.index !== "number") return [];
        const index = blockMap.get(inner.index);
        return index == null ? [] : closeBlock(index);
      }
      case "message_delta": {
        // The call a cut interrupted still reports its usage; it is part of this reply.
        const last = perCall.length - 1;
        if (counting && last >= 0) perCall[last] = toApiUsage(inner.usage, perCall[last] ?? emptyUsage());
        const d = isRecord(inner.delta) ? inner.delta : {};
        if (state.done) return [];
        if (d.stop_reason === "max_tokens" && opts.maxTokens) {
          state.stopReason = "max_tokens";
          return cut();
        }
        if (d.stop_reason === "refusal") {
          state.stopReason = "refusal";
          stopDetails = d.stop_details ?? null;
        }
        return [];
      }
      default:
        return [];
    }
  };

  const toolEvents = (event: Record<string, unknown>): ApiEvent[] => {
    if (state.done) return [];
    const message = isRecord(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const out: ApiEvent[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const id = typeof block.id === "string" ? block.id : `${seenTools.size}`;
      if (seenTools.has(id)) continue;
      seenTools.add(id);
      const name = typeof block.name === "string" ? block.name : "tool";
      // ToolSearch only loads another tool's definition; StructuredOutput is the reply itself.
      if (name === "ToolSearch" || name === "StructuredOutput") continue;
      if (name === "WebSearch") state.webSearches += 1;
      if (name === "WebFetch") state.webFetches += 1;
      const tool: ToolUse = { name, query: summarizeToolInput(name, block.input, opts.relativeTo) };
      state.tools.push(tool);
      out.push(extension("toondao.tool", { ...tool }));
    }
    return out;
  };

  let result: Record<string, unknown> | null = null;

  const push = (event: Record<string, unknown>): ApiEvent[] => {
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          if (typeof event.model === "string" && event.model) state.model = event.model;
          state.apiKeySource = typeof event.apiKeySource === "string" ? event.apiKeySource : null;
        }
        return [];
      case "rate_limit_event": {
        const rateLimit = toRateLimit(event.rate_limit_info);
        if (!rateLimit) return [];
        state.rateLimit = rateLimit;
        return [extension("toondao.rate", { ...rateLimit })];
      }
      case "assistant":
        return toolEvents(event);
      case "stream_event":
        return isRecord(event.event) ? streamEvent(event.event) : [];
      case "result":
        // A run the bridge cut short ends in an interrupted result; the reply is already settled.
        if (!state.done) {
          result = event;
          state.done = true;
        }
        return [];
      default:
        return [];
    }
  };

  /**
   * The run is over. Close the message — or, when the run failed (its result, or
   * `failure` from outside: the process could not start, the run timed out),
   * report the failure: as an `error` event once streaming has started, and
   * otherwise as nothing at all, for the caller to answer with an HTTP status.
   */
  const finish = (failure: ApiError | null = null): ApiEvent[] => {
    if (finished) return [];
    finished = true;
    state.usage = sumUsage(perCall);

    const out: ApiEvent[] = [];
    if (result) {
      const failed = result.is_error === true || result.subtype !== "success";
      if (result.subtype === "error_max_turns") {
        state.notices.push(MAX_TURNS_NOTICE);
        state.stopReason ??= "end_turn";
        out.push(extension("toondao.notice", { message: MAX_TURNS_NOTICE }));
      } else if (failed) {
        state.failure = apiErrorForResult(result, state.rateLimit);
      } else if (opts.structured && result.structured_output !== undefined) {
        out.push(...start(), ...closeAll());
        const index = nextIndex++;
        out.push(
          { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } },
          delta(index, { type: "text_delta", text: JSON.stringify(result.structured_output) }),
          { event: "content_block_stop", data: { type: "content_block_stop", index } },
        );
        state.stopReason = "end_turn";
      } else if (!state.stopReason) {
        const reason = typeof result.stop_reason === "string" ? result.stop_reason : "end_turn";
        state.stopReason = STOP_REASONS.has(reason) ? reason : "end_turn";
      }
    } else if (!state.stopRequested) {
      // No result: the process could not start, timed out, or died. With a result in
      // hand, an exit code afterwards changes nothing about the reply.
      state.failure = failure ?? { status: 500, type: "api_error", message: "Claude Code ended without an answer." };
    }

    if (state.failure) {
      if (!state.started) return [];
      return [...out, ...closeAll(), errorEvent(state.failure)];
    }
    return [
      ...start(),
      ...out,
      ...closeAll(),
      {
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: state.stopReason ?? "end_turn", stop_sequence: state.stopSequence, stop_details: stopDetails },
          usage: {
            ...state.usage,
            server_tool_use: { web_search_requests: state.webSearches, web_fetch_requests: state.webFetches },
          },
        },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ];
  };

  return { push, finish, state };
}

/** A content block the client may see, as the API would open it; null when it is Claude Code's own. */
function visibleBlock(value: unknown, structured: boolean): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (value.type === "text") return structured ? null : { type: "text", text: "" };
  if (value.type === "thinking") return { type: "thinking", thinking: "", signature: "" };
  if (value.type === "redacted_thinking") return { type: "redacted_thinking", data: str(value.data) };
  return null;
}

function extension(name: string, payload: Record<string, unknown>): ApiEvent {
  return { event: name, data: { type: name, ...payload } };
}

function errorEvent(error: ApiError): ApiEvent {
  return { event: "error", data: { type: "error", error: { type: error.type, message: error.message } } };
}

function emptyUsage(): ApiUsage {
  return { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
}

/** A call's usage as reported; fields it leaves out keep `fallback`'s values. */
function toApiUsage(value: unknown, fallback: ApiUsage): ApiUsage {
  const u = isRecord(value) ? value : {};
  const pick = (key: keyof ApiUsage) => (typeof u[key] === "number" ? (u[key] as number) : fallback[key]);
  return {
    input_tokens: pick("input_tokens"),
    cache_creation_input_tokens: pick("cache_creation_input_tokens"),
    cache_read_input_tokens: pick("cache_read_input_tokens"),
    output_tokens: pick("output_tokens"),
  };
}

function sumUsage(calls: readonly ApiUsage[]): ApiUsage {
  return calls.reduce(
    (sum, u) => ({
      input_tokens: sum.input_tokens + u.input_tokens,
      cache_creation_input_tokens: sum.cache_creation_input_tokens + u.cache_creation_input_tokens,
      cache_read_input_tokens: sum.cache_read_input_tokens + u.cache_read_input_tokens,
      output_tokens: sum.output_tokens + u.output_tokens,
    }),
    emptyUsage(),
  );
}

/**
 * A failed run → the error the API would have answered with. Claude Code reports
 * the HTTP status it got (`api_error_status`); a spent usage window is a 429 that
 * retrying will not fix before the window resets.
 */
export function apiErrorForResult(result: Record<string, unknown>, rateLimit: RateLimit | null): ApiError {
  const status = typeof result.api_error_status === "number" ? result.api_error_status : null;
  const message = resultError(result);
  if (status === 429 || rateLimit?.status === "rejected") {
    const spent = rateLimit?.status === "rejected";
    const resetsIn =
      spent && typeof rateLimit?.resetsAt === "number" ? Math.max(1, Math.round(rateLimit.resetsAt - Date.now() / 1000)) : null;
    return {
      status: 429,
      type: "rate_limit_error",
      message: spent ? `Your Claude subscription's usage window is spent. ${message}` : message,
      ...(resetsIn ? { retryAfter: resetsIn } : {}),
      shouldRetry: !spent,
    };
  }
  if (status === 529) return { status: 529, type: "overloaded_error", message, shouldRetry: true };
  if (status === 404) return { status: 404, type: "not_found_error", message };
  if (status === 400) return { status: 400, type: "invalid_request_error", message };
  if (status === 413) return { status: 413, type: "request_too_large", message };
  if (status === 401 || status === 403) {
    return {
      status: 500,
      type: "api_error",
      message: `Claude Code could not authenticate (${status}). Run \`claude\` and sign in again. ${message}`,
      shouldRetry: false,
    };
  }
  return { status: 500, type: "api_error", message };
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

export function sseFrame(event: ApiEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * The event sequence → the Message object a non-streaming request gets, folded
 * the way the SDKs fold a stream. Extension events are not part of it.
 */
export function accumulateMessage(events: readonly ApiEvent[]): Record<string, unknown> | null {
  let message: Record<string, unknown> | null = null;
  let content: Array<Record<string, unknown>> = [];
  for (const { data } of events) {
    if (data.type === "message_start" && isRecord(data.message)) {
      message = { ...data.message, usage: { ...(data.message.usage as object) } };
      content = [];
      message.content = content;
      continue;
    }
    if (!message) continue;
    const index = typeof data.index === "number" ? data.index : -1;
    switch (data.type) {
      case "content_block_start":
        if (isRecord(data.content_block)) content[index] = { ...data.content_block };
        break;
      case "content_block_delta": {
        const block = content[index];
        const d = isRecord(data.delta) ? data.delta : {};
        if (!block) break;
        if (d.type === "text_delta") block.text = str(block.text) + str(d.text);
        else if (d.type === "thinking_delta") block.thinking = str(block.thinking) + str(d.thinking);
        else if (d.type === "signature_delta") block.signature = str(d.signature);
        break;
      }
      case "message_delta": {
        const d = isRecord(data.delta) ? data.delta : {};
        message.stop_reason = d.stop_reason ?? null;
        message.stop_sequence = d.stop_sequence ?? null;
        message.stop_details = d.stop_details ?? null;
        message.usage = { ...(message.usage as object), ...(isRecord(data.usage) ? data.usage : {}) };
        break;
      }
    }
  }
  return message;
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/** Messages API runs in flight, across every request. */
let inFlight = 0;

/** The models `GET /v1/models` lists: the aliases Claude Code resolves to its newest of each. */
const MODEL_ALIASES: ReadonlyArray<{ id: string; display_name: string }> = [
  { id: "fable", display_name: "Fable — the newest your Claude Code runs" },
  { id: "opus", display_name: "Opus — the newest your Claude Code runs" },
  { id: "sonnet", display_name: "Sonnet — the newest your Claude Code runs" },
  { id: "haiku", display_name: "Haiku — the newest your Claude Code runs" },
];

/**
 * `/v1/messages` and `/v1/models[/id]`, behind the bridge's key. The request
 * guard (Host, Origin, JSON) has already run in `route()`.
 */
export async function messagesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  ctx: { opts: BridgeOptions; cors: Record<string, string> },
): Promise<void> {
  const requestId = `req_bridge_${randomBytes(12).toString("hex")}`;
  const headers = { ...ctx.cors, "request-id": requestId };
  const fail = (error: ApiError, extra: Record<string, string> = {}) => sendError(res, error, { ...headers, ...extra }, requestId);

  const key = ctx.opts.apiKey;
  const xApiKey = header(req, "x-api-key");
  const authorization = header(req, "authorization");
  if (!key || !checkApiKey({ xApiKey, authorization }, key)) {
    return fail({
      status: 401,
      type: "authentication_error",
      message:
        xApiKey || authorization
          ? "invalid x-api-key"
          : "x-api-key header is required. The bridge's key is in ~/.toondao/api-key (or TOONDAO_API_KEY).",
    });
  }

  if (path === "/v1/models" || path.startsWith("/v1/models/")) {
    if (req.method !== "GET") return fail({ status: 404, type: "not_found_error", message: `Use GET for ${path}.` });
    if (path === "/v1/models") {
      const data = MODEL_ALIASES.map((m) => modelObject(m.id, m.display_name));
      return sendJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }, headers);
    }
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    if (!isSafeModel(id)) return fail({ status: 404, type: "not_found_error", message: `model: ${id}` });
    const alias = MODEL_ALIASES.find((m) => m.id === id);
    return sendJson(res, 200, modelObject(id, alias?.display_name ?? id), headers);
  }

  if (path !== "/v1/messages") {
    return fail({ status: 404, type: "not_found_error", message: `${path} is not available through the bridge.` });
  }
  if (req.method !== "POST") return fail({ status: 404, type: "not_found_error", message: "Use POST /v1/messages." });

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return err instanceof BodyTooLarge
      ? fail({ status: 413, type: "request_too_large", message: err.message })
      : fail({ status: 400, type: "invalid_request_error", message: "The request body is not valid JSON." });
  }
  const parsed = parseMessagesRequest(body);
  if (!parsed.ok) return fail(parsed.error);
  const request = parsed.request;

  let readDir: string | null = null;
  if (request.project) {
    readDir = await snapshotReadDir(request.project.slug, request.project.snapshot, ctx.opts.projectsHome ?? TOONDAO_HOME);
    if (!readDir) {
      return fail({
        status: 400,
        type: "invalid_request_error",
        message: "toondao.project: that snapshot is not available. GET /v1/projects lists the ones there are.",
      });
    }
  }

  const limit = ctx.opts.apiConcurrency ?? DEFAULT_API_CONCURRENCY;
  if (inFlight >= limit) {
    return fail(
      {
        status: 429,
        type: "rate_limit_error",
        message: `The bridge is already running ${limit} requests; each is a whole Claude Code process. Try again shortly.`,
        retryAfter: 2,
        shouldRetry: true,
      },
    );
  }
  inFlight += 1;
  try {
    await run(res, request, readDir, ctx.opts, headers, requestId);
  } finally {
    inFlight -= 1;
  }
}

async function run(
  res: ServerResponse,
  request: ApiRequest,
  readDir: string | null,
  opts: BridgeOptions,
  headers: Record<string, string>,
  requestId: string,
): Promise<void> {
  const ignoredHeader: Record<string, string> = request.ignored.length
    ? { "toondao-ignored-params": request.ignored.join(", ") }
    : {};
  const translator = createMessagesTranslator({
    id: `msg_bridge_${randomBytes(12).toString("hex")}`,
    model: request.model,
    stopSequences: request.stopSequences,
    maxTokens: request.maxTokens,
    structured: request.jsonSchema !== null,
    relativeTo: readDir,
  });

  const controller = new AbortController();
  let clientGone = false;
  let timedOut = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      clientGone = true;
      controller.abort();
    }
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MAX_RUN_MS);
  const started = Date.now();

  // Streaming: hold the status line until there is a message to stream, so a run
  // that fails first (model not found, window spent) gets a real HTTP error.
  let streaming = false;
  const held: ApiEvent[] = [];
  const collected: ApiEvent[] = [];
  const deliver = (events: ApiEvent[]) => {
    if (!request.stream) {
      collected.push(...events);
      return;
    }
    if (!streaming) {
      held.push(...events);
      if (!translator.state.started) return;
      res.writeHead(200, {
        ...headers,
        ...ignoredHeader,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      streaming = true;
      events = held.splice(0);
    }
    for (const event of events) res.write(sseFrame(event));
  };

  let failure: ApiError | null = null;
  const { system, line } = toStreamInput(request.messages);
  try {
    for await (const event of runClaude({
      bin: opts.claudeBin,
      model: request.model,
      toolScope: request.webTools.length ? "research" : "none",
      system,
      line,
      allowedTools: request.webTools,
      readDir,
      effort: request.effort,
      researchTools: [...request.webTools, "ToolSearch"],
      noConnectors: true,
      withoutUserSettings: !request.userInstructions,
      jsonSchema: request.jsonSchema,
      maxOutputTokens: request.maxTokens,
      signal: controller.signal,
    })) {
      deliver(translator.push(event));
      if (translator.state.stopRequested && !controller.signal.aborted) controller.abort();
    }
  } catch (err) {
    failure = { status: 500, type: "api_error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && !failure) {
    failure = { status: 500, type: "api_error", message: `The run took longer than ${MAX_RUN_MS / 60000} minutes and was stopped.` };
  }

  const state = translator.state;
  if (clientGone) {
    res.end();
  } else {
    const closing = translator.finish(failure);
    if (state.failure && !state.started) {
      sendError(res, state.failure, { ...headers, ...ignoredHeader }, requestId);
    } else if (request.stream) {
      deliver(closing);
      res.end();
    } else if (state.failure) {
      sendError(res, state.failure, { ...headers, ...ignoredHeader }, requestId);
    } else {
      collected.push(...closing);
      const message = accumulateMessage(collected) ?? {};
      sendJson(
        res,
        200,
        {
          ...message,
          toondao: { tools: state.tools, rate_limit: state.rateLimit, ignored: request.ignored, notices: state.notices },
        },
        { ...headers, ...ignoredHeader },
      );
    }
  }

  const scope = [request.webTools.length ? "web" : "none", readDir ? "project" : "", request.jsonSchema ? "json" : ""]
    .filter(Boolean)
    .join("+");
  logRun({
    model: state.model,
    toolScope: `api ${scope}${request.effort ? ` effort=${request.effort}` : ""}`,
    ms: Date.now() - started,
    aborted: clientGone,
    finished: state.done,
    ok: !state.failure,
    usage: {
      inputTokens: state.usage.input_tokens,
      cacheCreationInputTokens: state.usage.cache_creation_input_tokens,
      cacheReadInputTokens: state.usage.cache_read_input_tokens,
      outputTokens: state.usage.output_tokens,
    },
    rateLimit: state.rateLimit,
    toolCalls: state.tools.length,
    apiKeySource: state.apiKeySource,
  });
}

function modelObject(id: string, displayName: string) {
  // The bridge does not know release dates; the epoch says so rather than inventing one.
  return { type: "model", id, display_name: displayName, created_at: "1970-01-01T00:00:00Z" };
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string>) {
  res.writeHead(status, { ...headers, "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, error: ApiError, headers: Record<string, string>, requestId: string) {
  sendJson(
    res,
    error.status,
    { type: "error", error: { type: error.type, message: error.message }, request_id: requestId },
    {
      ...headers,
      ...(error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}),
      ...(error.shouldRetry !== undefined ? { "x-should-retry": String(error.shouldRetry) } : {}),
    },
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function invalid(message: string): { ok: false; error: ApiError } {
  return { ok: false, error: { status: 400, type: "invalid_request_error", message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
