/**
 * The Messages API front door (bridge/messages-api.ts), without running Claude
 * Code: the request classes, the command line, and the event translation fed
 * with events recorded from a real `claude -p` (test/fixtures/claude-code, trimmed
 * of fetched web pages and session ids). The process and HTTP plumbing is checked
 * against the real CLI and the official SDK by hand (docs/bridge-api.md).
 */
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { validateHeaderValue, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accumulateMessage,
  apiErrorForResult,
  createMessagesTranslator,
  ignoredHeaderValue,
  messagesRoute,
  parseMessagesRequest,
  sseFrame,
  type ApiEvent,
  type ApiRequest,
} from "../bridge/messages-api.ts";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_ORIGINS,
  argsFor,
  corsHeaders,
  isMessagesApiPath,
  isSchemaArg,
  runClaude,
  runEnv,
  schemaArg,
  toStreamInput,
  type BridgeOptions,
} from "../bridge/claude-code.ts";
import { checkApiKey, loadApiKey } from "../bridge/api-key.ts";

function fixture(name: string): Array<Record<string, unknown>> {
  const text = readFileSync(new URL(`./fixtures/claude-code/${name}.jsonl`, import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Feed a whole run through a translator, as the route does, and close it. */
function translate(events: Array<Record<string, unknown>>, opts: Partial<Parameters<typeof createMessagesTranslator>[0]> = {}) {
  const t = createMessagesTranslator({ id: "msg_test", model: "haiku", ...opts });
  const out: ApiEvent[] = [];
  for (const event of events) out.push(...t.push(event));
  out.push(...t.finish());
  return { events: out, state: t.state, message: accumulateMessage(out) };
}

const names = (events: ApiEvent[]) => events.map((e) => e.event);

function ok(body: unknown): ApiRequest {
  const parsed = parseMessagesRequest(body);
  if (!parsed.ok) throw new Error(`expected a valid request, got: ${parsed.error.message}`);
  return parsed.request;
}

function refused(body: unknown): string {
  const parsed = parseMessagesRequest(body);
  if (parsed.ok) throw new Error("expected a refusal");
  expect(parsed.error).toMatchObject({ status: 400, type: "invalid_request_error" });
  return parsed.error.message;
}

const hello = [{ role: "user", content: "hi" }];

describe("request: what is honoured", () => {
  it("takes the fields Claude Code can honour", () => {
    const request = ok({
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "Be brief." }, { type: "text", text: "Be kind." }],
      messages: hello,
      stream: true,
      max_tokens: 2048,
      stop_sequences: ["END"],
      output_config: { effort: "high" },
    });
    expect(request).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      maxTokens: 2048,
      stopSequences: ["END"],
      effort: "high",
      webTools: [],
      ignored: [],
    });
    expect(request.messages[0]).toEqual({ role: "system", content: "Be brief.\n\nBe kind." });
  });

  it("maps the web server tools onto Claude Code's lookups, and tool_choice none takes them away", () => {
    const tools = [{ type: "web_search_20260209", name: "web_search" }, { type: "web_fetch_20260209", name: "web_fetch" }];
    expect(ok({ model: "opus", messages: hello, tools }).webTools).toEqual(["WebSearch", "WebFetch"]);
    expect(ok({ model: "opus", messages: hello, tools, tool_choice: { type: "none" } }).webTools).toEqual([]);
    expect(ok({ model: "opus", messages: hello, tools, tool_choice: { type: "auto" } }).webTools).toHaveLength(2);
  });

  it("turns a JSON schema into the one argument --json-schema takes", () => {
    const request = ok({
      model: "opus",
      messages: hello,
      output_config: { format: { type: "json_schema", schema: { type: "object", properties: { a: { type: "integer" } } } } },
    });
    expect(request.jsonSchema).toBe('{"type":"object","properties":{"a":{"type":"integer"}}}');
    expect(refused({ model: "opus", messages: hello, output_config: { format: { type: "json_schema", schema: [] } } })).toMatch(
      /schema: must be a JSON object/,
    );
  });

  it("passes images and documents on with only the fields Claude Code reads", () => {
    const request = ok({
      model: "opus",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA", extra: 1 }, cache_control: {} },
            { type: "document", source: { type: "url", url: "https://example.com/a.pdf" }, title: "A", citations: { enabled: true } },
            { type: "text", text: "What is this?" },
          ],
        },
      ],
    });
    expect(request.messages[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "document", source: { type: "url", url: "https://example.com/a.pdf" }, title: "A" },
      { type: "text", text: "What is this?" },
    ]);
  });

  it("drops what earlier replies carried — thinking, the server's own tool loop — and a reply left empty", () => {
    const request = ok({
      model: "opus",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "a1" }] },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "x" }] },
        { role: "user", content: "q2" },
      ],
    });
    expect(request.messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: "q2" },
    ]);
  });

  it("reads the toondao extension: a project snapshot, and the person's own instructions", () => {
    const request = ok({
      model: "opus",
      messages: hello,
      toondao: { project: { slug: "osmo-dock", snapshot: "2026-10-07T14-55-02Z" }, user_instructions: true },
    });
    expect(request.project).toEqual({ slug: "osmo-dock", snapshot: "2026-10-07T14-55-02Z" });
    expect(request.userInstructions).toBe(true);
    expect(ok({ model: "opus", messages: hello }).userInstructions).toBe(false);
    expect(refused({ model: "opus", messages: hello, toondao: { project: { slug: "x" } } })).toMatch(/toondao.project/);
  });
});

describe("request: what is ignored, in the open", () => {
  it("names back every field it accepts but cannot honour", () => {
    const request = ok({
      model: "opus",
      messages: hello,
      temperature: 0.2,
      top_p: 0.9,
      metadata: { user_id: "u" },
      service_tier: "auto",
      some_future_field: true,
      thinking: { type: "enabled", budget_tokens: 2048 },
      output_config: { effort: "low", task_budget: { type: "tokens", total: 20000 } },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3, allowed_domains: ["example.com"] }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(request.ignored).toEqual([
      "temperature",
      "top_p",
      "metadata",
      "service_tier",
      "some_future_field",
      "output_config.task_budget",
      "thinking",
      "web_search.max_uses",
      "web_search.allowed_domains",
      "tool_choice.disable_parallel_tool_use",
    ]);
    // Effort and the tool itself are still honoured.
    expect(request.effort).toBe("low");
    expect(request.webTools).toEqual(["WebSearch"]);
  });

  it("says nothing about adaptive thinking, which is what Claude Code does anyway", () => {
    expect(ok({ model: "opus", messages: hello, thinking: { type: "adaptive" } }).ignored).toEqual([]);
    expect(ok({ model: "opus", messages: hello, thinking: { type: "adaptive", display: "summarized" } }).ignored).toEqual([
      "thinking.display",
    ]);
  });
});

describe("request: what is refused", () => {
  it("refuses client tools — they need a loop in which the client runs them", () => {
    expect(
      refused({ model: "opus", messages: hello, tools: [{ name: "get_weather", input_schema: { type: "object" } }] }),
    ).toMatch(/client tools/);
    expect(refused({ model: "opus", messages: hello, tools: [{ type: "bash_20250124", name: "bash" }] })).toMatch(
      /bash_20250124 is not available/,
    );
    expect(
      refused({ model: "opus", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] }] }),
    ).toMatch(/client tools/);
  });

  it("refuses forced tool use, as the API does on current models", () => {
    expect(refused({ model: "opus", messages: hello, tool_choice: { type: "any" } })).toMatch(/"any" and "tool"/);
    expect(refused({ model: "opus", messages: hello, tool_choice: { type: "tool", name: "web_search" } })).toMatch(/"auto"/);
  });

  it("refuses a prefilled reply and a system turn inside the conversation", () => {
    expect(refused({ model: "opus", messages: [...hello, { role: "assistant", content: "Sure," }] })).toMatch(/Prefilling/);
    expect(refused({ model: "opus", messages: [...hello, { role: "system", content: "x" }] })).toMatch(/top-level `system`/);
  });

  it("refuses what would otherwise fail silently or reach the command line", () => {
    expect(refused({ model: "--dangerously-skip-permissions", messages: hello })).toMatch(/Not a model name/);
    expect(refused({ messages: hello })).toMatch(/model: Field required/);
    expect(refused({ model: "opus", messages: [] })).toMatch(/at least one message/);
    expect(refused({ model: "opus", messages: [{ role: "user", content: [] }] })).toMatch(/must not be empty/);
    expect(refused({ model: "opus", messages: hello, output_config: { effort: "extreme" } })).toMatch(/effort/);
    expect(refused({ model: "opus", messages: hello, max_tokens: 0 })).toMatch(/max_tokens/);
    expect(refused({ model: "opus", messages: hello, stop_sequences: ["  "] })).toMatch(/stop_sequences/);
    expect(refused({ model: "opus", messages: hello, mcp_servers: [{ type: "url", url: "https://x", name: "x" }] })).toMatch(
      /MCP servers/,
    );
    // An empty list says nothing, so it is not refused.
    expect(ok({ model: "opus", messages: hello, mcp_servers: [] }).ignored).toEqual([]);
  });
});

describe("the conversation as one Claude Code message", () => {
  it("keeps an image in its place, after the speaker of its turn", () => {
    const image = { type: "image" as const, source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const { line } = toStreamInput([
      { role: "user", content: [image, { type: "text", text: "What is this?" }] },
      { role: "assistant", content: "A red square." },
      { role: "user", content: "And its colour?" },
    ]);
    const blocks = JSON.parse(line).message.content;
    expect(blocks.slice(1)).toEqual([
      { type: "text", text: "User:" },
      image,
      { type: "text", text: "What is this?" },
      { type: "text", text: "Assistant:\nA red square." },
      { type: "text", text: "User:\nAnd its colour?" },
    ]);
  });

  it("sends a single question with an image exactly as asked", () => {
    const image = { type: "image" as const, source: { type: "url", url: "https://example.com/x.png" } };
    const { line } = toStreamInput([{ role: "user", content: [image, { type: "text", text: "Which logo?" }] }]);
    expect(JSON.parse(line).message.content).toEqual([image, { type: "text", text: "Which logo?" }]);
  });

  it("writes text blocks exactly as ToonDao's strings, so the cache matches across both doors", () => {
    const asStrings = toStreamInput([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    const asBlocks = toStreamInput([
      { role: "user", content: [{ type: "text", text: "q1" }] },
      { role: "assistant", content: [{ type: "text", text: "a1" }] },
      { role: "user", content: [{ type: "text", text: "q2" }] },
    ]);
    expect(asBlocks.line).toBe(asStrings.line);
  });
});

describe("the command line for an API run", () => {
  const common = { model: "opus", systemFile: "/tmp/x/system-prompt.txt", allowedTools: ["WebSearch"] };

  it("offers only the lookups a request declared, without connectors, and never anything wider", () => {
    const args = argsFor({
      ...common,
      toolScope: "research",
      researchTools: ["WebSearch", "ToolSearch", "Bash", "Write"],
      noConnectors: true,
    });
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,ToolSearch");
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--strict-mcp-config"))).toEqual(["WebSearch"]);
    for (const dangerous of ["Bash", "Write", "Edit"]) expect(args.join(" ")).not.toContain(dangerous);
  });

  it("keeps ToonDao's research run as it was: every lookup, and the connectors", () => {
    const args = argsFor({ ...common, toolScope: "research", allowedTools: DEFAULT_ALLOWED_TOOLS });
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch,ToolSearch");
    expect(args).not.toContain("--strict-mcp-config");
    expect(args).not.toContain("--safe-mode");
  });

  it("turns the person's own customizations off when asked, which keeps their permission rules", () => {
    const args = argsFor({ ...common, toolScope: "none", safeMode: true });
    expect(args).toContain("--safe-mode");
    // Not --setting-sources: leaving the user's settings out would drop their deny rules too.
    expect(args).not.toContain("--setting-sources");
  });

  it("passes a schema as one --json-schema= argument, with two more turns for the structured reply", () => {
    const schema = '{"type":"object"}';
    const args = argsFor({ ...common, toolScope: "none", jsonSchema: schema });
    expect(args).toContain(`--json-schema=${schema}`);
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
    // Anything that is not schemaArg()'s own output never reaches the command line.
    for (const bad of ["--dangerously-skip-permissions", '{"a": 1}', "[1]", "{"]) {
      expect(argsFor({ ...common, toolScope: "none", jsonSchema: bad }).join(" ")).not.toContain("--json-schema");
    }
  });

  it("re-serialises schemas, and refuses anything that is not a JSON object under 64 KB", () => {
    expect(schemaArg({ b: 1, a: [true] })).toBe('{"b":1,"a":[true]}');
    expect(isSchemaArg(schemaArg({ type: "object" }))).toBe(true);
    for (const bad of [null, "{}", [], 42, { big: "x".repeat(70 * 1024) }]) expect(schemaArg(bad)).toBeNull();
  });
});

describe("Claude Code events → one Messages API message", () => {
  it("streams a plain answer as the API's event sequence", () => {
    const { events, message, state } = translate(fixture("text"));
    expect(names(events)).toEqual([
      "message_start",
      "content_block_start",
      ...Array(6).fill("content_block_delta"),
      "content_block_stop",
      "toondao.rate",
      "message_delta",
      "message_stop",
    ]);
    expect(message).toMatchObject({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: "你好，很高兴见到你。" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 2, cache_creation_input_tokens: 1256, cache_read_input_tokens: 0, output_tokens: 13 },
    });
    expect(state.rateLimit).toMatchObject({ status: "allowed", window: "five_hour" });
  });

  it("merges a web lookup's tool loop into one message, with its lookups counted and its tool calls hidden", () => {
    const { events, message, state } = translate(fixture("web-search"));
    const content = (message?.content ?? []) as Array<{ type: string; text?: string }>;
    expect(content.map((b) => b.type)).toEqual(["thinking", "thinking", "text"]);
    expect(content[2]?.text).toMatch(/Node\.js/);
    // Indices run across Claude Code's three calls without a gap or a repeat.
    const starts = events.filter((e) => e.event === "content_block_start").map((e) => e.data.index);
    expect(starts).toEqual([0, 1, 2]);
    expect(events.filter((e) => e.event === "message_start")).toHaveLength(1);
    // ToolSearch only loads WebSearch; the lookup itself is reported.
    expect(state.tools).toEqual([{ name: "WebSearch", query: "latest stable Node.js version 2026" }]);
    expect(events.filter((e) => e.event === "toondao.tool")).toHaveLength(1);
    // Usage summed over the calls equals what Claude Code reports for the whole run.
    expect(message?.usage).toEqual({
      input_tokens: 6,
      cache_creation_input_tokens: 7879,
      cache_read_input_tokens: 4524,
      output_tokens: 592,
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    });
  });

  it("ends the reply at the first max_tokens stop, as the API would, instead of letting Claude Code retry", () => {
    const t = createMessagesTranslator({ id: "msg_test", model: "haiku", maxTokens: 16 });
    const out: ApiEvent[] = [];
    let askedToStopAt = -1;
    fixture("max-tokens").forEach((event, i) => {
      out.push(...t.push(event));
      if (t.state.stopRequested && askedToStopAt < 0) askedToStopAt = i;
    });
    out.push(...t.finish());
    const message = accumulateMessage(out);
    expect(askedToStopAt).toBeGreaterThan(0);
    expect(message?.stop_reason).toBe("max_tokens");
    // Only the first call is this reply's; the retries Claude Code went on to make are not.
    expect(message?.usage).toMatchObject({ input_tokens: 2, cache_creation_input_tokens: 1267, output_tokens: 16 });
    expect(out.filter((e) => e.event === "error")).toHaveLength(0);
  });

  it("without max_tokens, reports what Claude Code's own retries ended in", () => {
    const { events, state } = translate(fixture("max-tokens"));
    expect(state.failure).toMatchObject({ status: 500, type: "api_error" });
    expect(events.at(-1)).toMatchObject({ event: "error", data: { type: "error", error: { type: "api_error" } } });
  });

  it("answers a structured request with the validated JSON as its text", () => {
    const { events, message, state } = translate(fixture("structured"), { structured: true });
    expect(message?.content).toEqual([{ type: "text", text: '{"answer":4}' }]);
    expect(message?.stop_reason).toBe("end_turn");
    expect(state.tools).toEqual([]);
    expect(names(events)).not.toContain("toondao.tool");
  });

  it("turns a failure before any output into nothing to stream — the route answers with an HTTP status", () => {
    const { events, state } = translate(fixture("unknown-model"));
    expect(events).toEqual([]);
    expect(state.started).toBe(false);
    expect(state.failure).toMatchObject({ status: 404, type: "not_found_error" });
  });

  it("reports a run that ended without a result", () => {
    const silent = translate([]);
    expect(silent.events).toEqual([]);
    expect(silent.state.failure?.message).toMatch(/ended without an answer/);
    const cutOff = translate(fixture("text").slice(0, 5));
    expect(cutOff.events.at(-1)).toMatchObject({ event: "error" });
  });
});

describe("stop sequences", () => {
  const run = (chunks: string[], stopSequences: string[]) => {
    const events: Array<Record<string, unknown>> = [
      { type: "stream_event", event: { type: "message_start", message: { model: "claude-haiku-5-5", usage: { input_tokens: 5 } } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
      ...chunks.map((text) => ({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      })),
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } },
      { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" },
    ];
    const t = createMessagesTranslator({ id: "m", model: "haiku", stopSequences });
    const out: ApiEvent[] = [];
    /** The text sent after each Claude Code event, so what went out before a match can be checked. */
    const sentPerEvent: string[] = [];
    for (const event of events) {
      const emitted = t.push(event);
      out.push(...emitted);
      sentPerEvent.push(
        emitted
          .filter((e) => e.event === "content_block_delta")
          .map((e) => String((e.data.delta as { text?: string }).text ?? ""))
          .join(""),
      );
    }
    out.push(...t.finish());
    return { message: accumulateMessage(out), state: t.state, sentPerEvent };
  };

  it("cuts the reply before the sequence, even when it arrives split across deltas", () => {
    const { message, state } = run(["Hello wor", "ld. ST", "OP and more"], ["STOP"]);
    expect(message?.content).toEqual([{ type: "text", text: "Hello world. " }]);
    expect(message).toMatchObject({ stop_reason: "stop_sequence", stop_sequence: "STOP" });
    expect(state.stopRequested).toBe(true);
  });

  it("never sends a piece of a sequence that is still completing", () => {
    // Events: message_start, block start, "abc ST", "OP", …
    const { sentPerEvent } = run(["abc ST", "OP"], ["STOP"]);
    expect(sentPerEvent[2]).toBe("abc"); // " ST" is held: it could be the start of STOP
    expect(sentPerEvent[3]).toBe(" "); // the match releases what came before it, and nothing of it
    expect(sentPerEvent.join("")).toBe("abc ");
  });

  it("sends everything when no sequence matches, and picks the earliest of several", () => {
    expect(run(["no match ", "here"], ["STOP"]).message?.content).toEqual([{ type: "text", text: "no match here" }]);
    const both = run(["one END two STOP"], ["STOP", "END"]);
    expect(both.message).toMatchObject({ stop_sequence: "END", content: [{ type: "text", text: "one " }] });
  });

  it("names the sequence that completes first, as generation would have stopped there", () => {
    // "END" is complete three characters before "ENDING" is, wherever they are listed.
    for (const chunks of [["abc ENDING"], ["abc EN", "DING"]]) {
      expect(run(chunks, ["ENDING", "END"]).message).toMatchObject({
        stop_sequence: "END",
        content: [{ type: "text", text: "abc " }],
      });
    }
  });

  it("never splits a surrogate pair while holding text back", () => {
    const { message } = run(["ab😀", "cd"], ["xyz"]);
    expect(message?.content).toEqual([{ type: "text", text: "ab😀cd" }]);
  });
});

describe("errors, as the API reports them", () => {
  it("maps Claude Code's HTTP status onto the API's error types", () => {
    expect(apiErrorForResult({ api_error_status: 404, result: "no such model" }, null)).toMatchObject({
      status: 404,
      type: "not_found_error",
    });
    expect(apiErrorForResult({ api_error_status: 529 }, null)).toMatchObject({ status: 529, type: "overloaded_error", shouldRetry: true });
    // Claude Code's own sign-in failing is not the client's key being wrong.
    expect(apiErrorForResult({ api_error_status: 401 }, null)).toMatchObject({ status: 500, type: "api_error" });
  });

  it("tells a client not to retry a spent usage window, and when it resets", () => {
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    const error = apiErrorForResult(
      { api_error_status: 429, result: "limit" },
      { status: "rejected", window: "five_hour", utilization: 1, resetsAt },
    );
    expect(error).toMatchObject({ status: 429, type: "rate_limit_error", shouldRetry: false });
    expect(error.retryAfter).toBeGreaterThan(3500);
  });
});

describe("delivery", () => {
  it("writes SSE frames the way the API does", () => {
    expect(sseFrame({ event: "message_stop", data: { type: "message_stop" } })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });

  it("folds thinking, its signature and text the way the SDKs do", () => {
    const message = accumulateMessage([
      { event: "message_start", data: { type: "message_start", message: { id: "m", content: [], usage: { input_tokens: 1 } } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } },
      { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
      { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi" } } },
      { event: "toondao.tool", data: { type: "toondao.tool", name: "WebSearch", query: "q" } },
      { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } } },
    ]);
    expect(message).toMatchObject({
      content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 3 },
    });
  });

  it("routes only the Messages API's paths to it", () => {
    for (const path of ["/v1/messages", "/v1/models", "/v1/models/opus", "/v1/messages/count_tokens"]) {
      expect(isMessagesApiPath(path)).toBe(true);
    }
    for (const path of ["/v1/chat/completions", "/v1/health", "/v1/projects", "/v1/messagesx"]) {
      expect(isMessagesApiPath(path)).toBe(false);
    }
  });

  it("lets a browser shell send the SDK's headers and read the API's", () => {
    const headers = corsHeaders("http://localhost:5273", ["http://localhost:5273"], "x-api-key, anthropic-version, x-stainless-os");
    expect(headers["Access-Control-Allow-Headers"]).toBe("x-api-key, anthropic-version, x-stainless-os");
    expect(headers["Access-Control-Expose-Headers"]).toMatch(/request-id/);
    expect(corsHeaders("http://localhost:5273", ["http://localhost:5273"], "x\r\nInjected: 1")["Access-Control-Allow-Headers"]).toBe(
      "content-type",
    );
  });
});

describe("the bridge's own key", () => {
  it("accepts the key as x-api-key or as a bearer token, and nothing else", () => {
    expect(checkApiKey({ xApiKey: "tdk-abc" }, "tdk-abc")).toBe(true);
    expect(checkApiKey({ authorization: "Bearer tdk-abc" }, "tdk-abc")).toBe(true);
    expect(checkApiKey({ xApiKey: "tdk-abd" }, "tdk-abc")).toBe(false);
    expect(checkApiKey({ xApiKey: "tdk-ab" }, "tdk-abc")).toBe(false);
    expect(checkApiKey({}, "tdk-abc")).toBe(false);
    expect(checkApiKey({ xApiKey: "" }, "")).toBe(false);
  });

  it("creates a key readable by its owner only, then keeps using it; the environment's wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toondao-key-"));
    const file = join(dir, "nested", "api-key");
    const created = await loadApiKey({ env: {}, file });
    expect(created.source).toBe("created");
    expect(created.key).toMatch(/^tdk-[\w-]{40,}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadApiKey({ env: {}, file })).toEqual({ key: created.key, source: "file" });
    expect(await loadApiKey({ env: { TOONDAO_API_KEY: "tdk-from-env" }, file })).toEqual({ key: "tdk-from-env", source: "env" });
    await writeFile(file, "tdk-edited\n");
    expect((await loadApiKey({ env: {}, file })).key).toBe("tdk-edited");
    expect(await readFile(file, "utf8")).toBe("tdk-edited\n");
  });

  it("never hands the key to Claude Code", () => {
    expect(runEnv({ PATH: "/usr/bin", TOONDAO_API_KEY: "tdk-secret" })).toEqual({ PATH: "/usr/bin" });
    expect(runEnv({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", TOONDAO_API_KEY: "tdk-secret", HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});


/* A model call's stream as Claude Code relays it, for the cases no recording has. */
const call = (id: string, blocks: Array<{ type: "text" | "thinking"; text: string }>, opts: { stop?: boolean } = {}) => [
  { type: "stream_event", event: { type: "message_start", message: { id, model: "claude-haiku-5-5", usage: { input_tokens: 10 } } } },
  ...blocks.flatMap((block, i) => [
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: i,
        content_block: block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: i,
        delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "thinking_delta", thinking: block.text },
      },
    },
    ...(opts.stop === false && i === blocks.length - 1 ? [] : [{ type: "stream_event", event: { type: "content_block_stop", index: i } }]),
  ]),
  ...(opts.stop === false
    ? []
    : [
        { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 7 } } },
        { type: "stream_event", event: { type: "message_stop" } },
      ]),
];
const success = { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" };

/** The rules the SDKs' stream readers rely on: one start, blocks opened in order, no delta to a closed block. */
function orderProblems(events: ApiEvent[]): string[] {
  const problems: string[] = [];
  const api = events.filter((e) => !e.event.startsWith("toondao."));
  if (api.filter((e) => e.event === "message_start").length !== 1 || api[0]?.event !== "message_start") problems.push("message_start");
  const open = new Set<number>();
  let next = 0;
  for (const { event, data } of api) {
    const index = data.index as number;
    if (event === "content_block_start" && index !== next++) problems.push(`start ${index} out of order`);
    if (event === "content_block_start") open.add(index);
    if (event === "content_block_delta" && !open.has(index)) problems.push(`delta to closed ${index}`);
    if (event === "content_block_stop" && !open.delete(index)) problems.push(`stop of closed ${index}`);
  }
  if (open.size) problems.push("blocks left open");
  return problems;
}

describe("a stream that breaks", () => {
  it("closes a broken-off call's blocks before the retry's, says so, and marks them", () => {
    const { events, state } = translate([
      ...call("msg_a", [{ type: "text", text: "The answer" }], { stop: false }),
      ...call("msg_b", [{ type: "text", text: "The answer is 42." }]),
      success,
    ]);
    expect(orderProblems(events)).toEqual([]);
    expect(state.interrupted).toEqual([0]);
    expect(events.filter((e) => e.event === "toondao.notice")).toHaveLength(1);
    // A non-streaming reply leaves the broken-off block out (the route filters on `interrupted`).
    const content = (accumulateMessage(events)?.content ?? []) as unknown[];
    expect(content.filter((_, i) => !state.interrupted.includes(i))).toEqual([{ type: "text", text: "The answer is 42." }]);
  });

  it("takes a message Claude Code got whole, when it fell back from streaming, as the reply", () => {
    const usage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 9 };
    const whole = (content: unknown[]) => ({
      type: "assistant",
      message: { id: "msg_whole", model: "claude-haiku-5-5", role: "assistant", content, usage },
    });
    // Reported as one event per block, as Claude Code does for streamed messages too.
    const { events, message } = translate([
      whole([{ type: "thinking", thinking: "", signature: "sig" }]),
      whole([{ type: "text", text: "The full answer." }]),
      success,
    ]);
    expect(orderProblems(events)).toEqual([]);
    expect(message?.content).toEqual([
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "The full answer." },
    ]);
    expect(message?.usage).toMatchObject(usage); // counted once, not once per event
  });

  it("never takes Claude Code's own error text for the reply, nor repeats a streamed message", () => {
    expect(translate(fixture("unknown-model")).events).toEqual([]);
    expect(translate(fixture("text")).message?.content).toEqual([{ type: "text", text: "你好，很高兴见到你。" }]);
  });
});

describe("the ignored-fields header", () => {
  it("carries any field name a client can send, as a header can carry it", () => {
    const names = ["temperature", "温度", "a,b", "x".repeat(200), ...Array.from({ length: 40 }, (_, i) => `f${i}`)];
    const value = ignoredHeaderValue(names);
    expect(() => validateHeaderValue("toondao-ignored-params", value)).not.toThrow();
    expect(value).toMatch(/^temperature, %E6%B8%A9%E5%BA%A6, a%2Cb, x{77}\.\.\., f0, /);
    expect(value).toMatch(/\(\+12 more\)$/);
  });
});

describe("a run the client has already left", () => {
  it("starts nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toondao-abort-"));
    const marker = join(dir, "started");
    const bin = join(dir, "fake-claude");
    await writeFile(bin, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(bin, 0o755);
    const signal = AbortSignal.abort();
    const events = [];
    for await (const event of runClaude({ bin, model: "haiku", toolScope: "none", system: "s", line: "{}", allowedTools: [], signal })) {
      events.push(event);
    }
    expect(events).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The route, in-process, with a stand-in for Claude Code              */
/* ------------------------------------------------------------------ */

/** A `claude` that prints recorded events whatever it is asked, and notes that it ran. */
async function standIn(events: Array<Record<string, unknown>>) {
  const dir = await mkdtemp(join(tmpdir(), "toondao-route-"));
  const file = join(dir, "events.jsonl");
  await writeFile(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const bin = join(dir, "fake-claude");
  await writeFile(bin, `#!/bin/sh\ntouch '${join(dir, "ran")}'\ncat '${file}'\n`);
  await chmod(bin, 0o755);
  return { bin, ran: () => existsSync(join(dir, "ran")) };
}

function fakeRequest(method: string, headers: Record<string, string>, body?: unknown, hold?: Promise<void>) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const stream = (async function* () {
    if (hold) await hold;
    yield* chunks;
  })();
  return Object.assign(stream, { method, headers }) as unknown as IncomingMessage;
}

/** Records what the route sends, refusing header values the way Node's own response does. */
function fakeResponse() {
  const listeners: Array<() => void> = [];
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    writableFinished: false,
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      for (const [name, value] of Object.entries(headers)) validateHeaderValue(name, value);
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    write(chunk: string) {
      res.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
      res.writableFinished = true;
      return res;
    },
    on(event: string, fn: () => void) {
      if (event === "close") listeners.push(fn);
      return res;
    },
    leave: () => listeners.forEach((fn) => fn()),
  };
  return res;
}

async function callRoute(
  bin: string,
  path: string,
  init: { method?: string; key?: string | null; body?: unknown; hold?: Promise<void> } = {},
) {
  const opts: BridgeOptions = { port: 8788, allowedOrigins: DEFAULT_ORIGINS, allowedTools: [], claudeBin: bin, apiKey: "tdk-test" };
  const headers: Record<string, string> = init.key === null ? {} : { "x-api-key": init.key ?? "tdk-test" };
  const res = fakeResponse();
  const done = messagesRoute(fakeRequest(init.method ?? "POST", headers, init.body, init.hold), res as unknown as ServerResponse, path, {
    opts,
    cors: {},
  });
  return { res, done };
}

const sseEvents = (body: string) =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => ({ event: /^event: (.*)$/m.exec(frame)?.[1] ?? "", data: JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? "null") }));

describe("the route", () => {
  it("asks for the key, in the API's error envelope", async () => {
    const { res, done } = await callRoute("/nonexistent", "/v1/messages", { key: null, body: {} });
    await done;
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ type: "error", error: { type: "authentication_error" }, request_id: expect.stringMatching(/^req_bridge_/) });
  });

  it("lists the model aliases, and answers a malformed model id with a 404", async () => {
    const list = await callRoute("/nonexistent", "/v1/models", { method: "GET" });
    await list.done;
    expect(JSON.parse(list.res.body).data.map((m: { id: string }) => m.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    const bad = await callRoute("/nonexistent", "/v1/models/%E0%A4%A", { method: "GET" });
    await bad.done;
    expect(bad.res.status).toBe(404);
    expect(JSON.parse(bad.res.body).error.type).toBe("not_found_error");
  });

  it("answers a request as one Message, with ignored fields of any name named back", async () => {
    const claude = await standIn(fixture("text"));
    const { res, done } = await callRoute(claude.bin, "/v1/messages", {
      body: { model: "haiku", messages: [{ role: "user", content: "hi" }], 温度: 0.5 },
    });
    await done;
    expect(res.status).toBe(200);
    expect(res.headers["toondao-ignored-params"]).toBe("%E6%B8%A9%E5%BA%A6");
    expect(JSON.parse(res.body)).toMatchObject({
      type: "message",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: "你好，很高兴见到你。" }],
      toondao: { ignored: ["温度"] },
    });
  });

  it("streams in the API's order, the status line held until there is a message", async () => {
    const claude = await standIn(fixture("web-search"));
    const { res, done } = await callRoute(claude.bin, "/v1/messages", {
      body: { model: "haiku", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ type: "web_search_20260209", name: "web_search" }] },
    });
    await done;
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toMatch(/text\/event-stream/);
    const events = sseEvents(res.body);
    expect(orderProblems(events)).toEqual([]);
    expect(events.at(-1)?.event).toBe("message_stop");
  });

  it("answers a failure before any output with its HTTP status, even when streaming", async () => {
    const claude = await standIn(fixture("unknown-model"));
    const { res, done } = await callRoute(claude.bin, "/v1/messages", {
      body: { model: "claude-nonexistent-9", stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    await done;
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error.type).toBe("not_found_error");
  });

  it("leaves a broken-off call's partial text out of a non-streaming reply", async () => {
    const claude = await standIn([
      ...call("msg_a", [{ type: "text", text: "The answer" }], { stop: false }),
      ...call("msg_b", [{ type: "text", text: "The answer is 42." }]),
      success,
    ]);
    const { res, done } = await callRoute(claude.bin, "/v1/messages", { body: { model: "haiku", messages: [{ role: "user", content: "q" }] } });
    await done;
    const body = JSON.parse(res.body);
    expect(body.content).toEqual([{ type: "text", text: "The answer is 42." }]);
    expect(body.toondao.notices).toHaveLength(1);
  });

  it("starts no run for a client that left while its request was being read", async () => {
    const claude = await standIn(fixture("text"));
    let release = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { res, done } = await callRoute(claude.bin, "/v1/messages", { body: { model: "haiku", messages: [{ role: "user", content: "hi" }] }, hold });
    res.leave();
    release();
    await done;
    expect(claude.ran()).toBe(false);
  });
});

