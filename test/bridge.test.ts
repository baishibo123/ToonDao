/**
 * The Claude Code bridge, without running Claude Code: the request guard, the
 * payload conversion, the command line and the event mapping are pure, and they
 * are where a mistake would be silent — a leaked flag, a lost turn, a tool call
 * nobody sees. The process plumbing is checked against the real CLI by hand.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_TOOLS,
  argsFor,
  corsHeaders,
  createSseMapper,
  guardRequest,
  isSafeModel,
  modelProblem,
  summarizeToolInput,
  toRateLimit,
  toStreamInput,
} from "../bridge/claude-code.ts";
import { decodeBridgeFrame, type BridgeFrame } from "@/lib/bridgeProtocol";

const ORIGINS = ["http://localhost:5273"];

/** Split mapper output back into frames the way the app's SSE reader would. */
function decode(frames: string[]): BridgeFrame[] {
  const out: BridgeFrame[] = [];
  for (const chunk of frames.join("").split("\n\n")) {
    if (!chunk.trim()) continue;
    let event = "message";
    const data: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      if (line.startsWith("data: ")) data.push(line.slice(6));
    }
    const frame = decodeBridgeFrame(event, data.join("\n"));
    if (frame) out.push(frame);
  }
  return out;
}

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const messageStart = { type: "stream_event", event: { type: "message_start" } };

describe("request guard", () => {
  it("serves the app's own pages", () => {
    const guard = guardRequest(
      { method: "POST", origin: ORIGINS[0], host: "127.0.0.1:8788", contentType: "application/json" },
      ORIGINS,
      8788,
    );
    expect(guard.ok).toBe(true);
  });

  it("refuses any other web page, which could otherwise spend the subscription", () => {
    const guard = guardRequest(
      { method: "POST", origin: "https://evil.example", host: "127.0.0.1:8788", contentType: "application/json" },
      ORIGINS,
      8788,
    );
    expect(guard).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a non-JSON post, so a browser cannot skip the CORS preflight", () => {
    const guard = guardRequest(
      { method: "POST", origin: ORIGINS[0], host: "127.0.0.1:8788", contentType: "text/plain" },
      ORIGINS,
      8788,
    );
    expect(guard).toMatchObject({ ok: false, status: 415 });
  });

  it("refuses a foreign Host, which is what DNS rebinding looks like", () => {
    const guard = guardRequest(
      { method: "GET", host: "attacker.example:8788" },
      ORIGINS,
      8788,
    );
    expect(guard).toMatchObject({ ok: false, status: 403 });
  });

  it("allows a same-machine client with no Origin, such as curl", () => {
    expect(guardRequest({ method: "GET", host: "localhost:8788" }, ORIGINS, 8788).ok).toBe(true);
  });

  it("sends CORS headers only to an allowed origin", () => {
    expect(corsHeaders(ORIGINS[0], ORIGINS)["Access-Control-Allow-Origin"]).toBe(ORIGINS[0]);
    expect(corsHeaders("https://evil.example", ORIGINS)).toEqual({});
    expect(corsHeaders(undefined, ORIGINS)).toEqual({});
  });
});

describe("model names", () => {
  it("accepts aliases and full ids", () => {
    for (const model of ["opus", "sonnet", "haiku", "fable", "claude-opus-5", "claude-haiku-4-5-20251001"]) {
      expect(isSafeModel(model)).toBe(true);
    }
  });

  it("refuses anything the CLI could read as a flag or that carries spaces", () => {
    for (const model of ["--dangerously-skip-permissions", "-p", "opus --tools default", "", "a".repeat(80)]) {
      expect(isSafeModel(model)).toBe(false);
    }
  });
});

describe("model problems, in words that point at the fix", () => {
  it("recognises another provider's model name", () => {
    expect(modelProblem("anthropic/claude-opus-5")).toMatch(/another provider's model name/);
    expect(modelProblem("anthropic/claude-opus-5")).toMatch(/claude-opus-5-5/);
  });

  it("refuses a flag plainly, and passes a real name", () => {
    expect(modelProblem("--dangerously-skip-permissions")).toBe(
      "Not a model name: --dangerously-skip-permissions",
    );
    expect(modelProblem("claude-opus-5-5")).toBeNull();
  });
});

describe("payload → one Claude Code message", () => {
  it("sends a single-message payload as it is — what the lens, crop and isolation assemble to", () => {
    const { system, line } = toStreamInput([
      { role: "system", content: "Pace your answers." },
      { role: "user", content: "Treat the text above as the entire context." },
    ]);
    expect(system).toBe("Pace your answers.");
    const message = JSON.parse(line);
    expect(message.type).toBe("user");
    expect(message.message.content).toEqual([
      { type: "text", text: "Treat the text above as the entire context." },
    ]);
  });

  it("writes a multi-turn payload as a transcript, one block per turn, oldest first", () => {
    const { line } = toStreamInput([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    const blocks = JSON.parse(line).message.content.map((b: { text: string }) => b.text);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatch(/Reply to the final User turn/);
    expect(blocks.slice(1)).toEqual(["User:\nq1", "Assistant:\na1", "User:\nq2"]);
  });

  it("keeps the previous request's blocks as an exact prefix, which is what caching matches on", () => {
    const before = [
      { role: "user" as const, content: "q1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "q2" },
    ];
    const after = [...before, { role: "assistant" as const, content: "a2" }, { role: "user" as const, content: "q3" }];
    const a = JSON.parse(toStreamInput(before).line).message.content;
    const b = JSON.parse(toStreamInput(after).line).message.content;
    expect(b.slice(0, a.length)).toEqual(a);
  });

  it("falls back to a neutral system prompt rather than Claude Code's coding one", () => {
    const { system } = toStreamInput([{ role: "user", content: "hi" }]);
    expect(system).toBe("You are Claude, a helpful AI assistant.");
  });
});

describe("the command line", () => {
  const common = { model: "opus", systemFile: "/tmp/x/system-prompt.txt", allowedTools: DEFAULT_ALLOWED_TOOLS };

  it("always replaces the system prompt from a file and writes no session", () => {
    const args = argsFor({ ...common, toolScope: "none" });
    expect(args).toContain("-p");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe(common.systemFile);
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("gives `none` no tools, no MCP servers and one turn", () => {
    const args = argsFor({ ...common, toolScope: "none" });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args).not.toContain("--allowedTools");
  });

  it("gives `research` only the lookup tools, and never anything that runs or writes", () => {
    const args = argsFor({ ...common, toolScope: "research" });
    const tools = args[args.indexOf("--tools") + 1].split(",");
    expect(tools.sort()).toEqual(["ToolSearch", "WebFetch", "WebSearch"]);
    for (const dangerous of ["Bash", "Write", "Edit", "NotebookEdit", "CronCreate", "RemoteTrigger"]) {
      expect(args.join(" ")).not.toContain(dangerous);
    }
    expect(Number(args[args.indexOf("--max-turns") + 1])).toBeGreaterThan(1);
  });
});

describe("Claude Code events → SSE", () => {
  it("streams text deltas as OpenAI-shaped chunks", () => {
    const { map } = createSseMapper();
    const frames = [textDelta("Thermo"), textDelta("haline")].flatMap(map);
    expect(decode(frames)).toEqual([
      { kind: "text", text: "Thermo" },
      { kind: "text", text: "haline" },
    ]);
  });

  it("puts a paragraph break between the text before a tool call and the answer after it", () => {
    const { map } = createSseMapper();
    const frames = [messageStart, textDelta("Let me look that up."), messageStart, textDelta("It is…")].flatMap(map);
    const text = decode(frames)
      .map((f) => (f.kind === "text" ? f.text : ""))
      .join("");
    expect(text).toBe("Let me look that up.\n\nIt is…");
  });

  it("reports each tool call once, with what it looked up", () => {
    const { map, summary } = createSseMapper();
    const call = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "WebSearch", input: { query: "thermohaline circulation" } }] },
    };
    const frames = [call, call].flatMap(map);
    expect(decode(frames)).toEqual([
      { kind: "tool", tool: { name: "WebSearch", query: "thermohaline circulation" } },
    ]);
    expect(summary.toolCalls).toBe(1);
  });

  it("does not report ToolSearch, which only loads a tool and brings nothing in", () => {
    const { map, summary } = createSseMapper();
    const frames = map({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t0", name: "ToolSearch", input: { query: "select:WebSearch" } }] },
    });
    expect(frames).toEqual([]);
    expect(summary.toolCalls).toBe(0);
  });

  it("passes on the usage window, which is shared with the rest of the account's use", () => {
    const { map } = createSseMapper();
    const frames = map({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1790403000,
        rateLimitType: "five_hour",
        unifiedWindows: { five_hour: { utilization: 0.16, resetsAt: 1790403000 } },
      },
    });
    expect(decode(frames)).toEqual([
      {
        kind: "rate",
        rateLimit: { status: "allowed", window: "five_hour", utilization: 0.16, resetsAt: 1790403000 },
      },
    ]);
  });

  it("ends a successful run with its usage, then [DONE]", () => {
    const { map, summary } = createSseMapper();
    const frames = map({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 633, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 72 },
    });
    expect(decode(frames)).toEqual([
      {
        kind: "usage",
        usage: { inputTokens: 633, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 72 },
      },
      { kind: "done" },
    ]);
    expect(summary).toMatchObject({ finished: true, ok: true });
  });

  it("turns a failed run into an error the reader can act on", () => {
    const { map, summary } = createSseMapper();
    const frames = map({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    expect(decode(frames)).toEqual([
      { kind: "error", message: "Not logged in · Please run /login" },
      { kind: "done" },
    ]);
    expect(summary.ok).toBe(false);
  });

  it("explains running out of tool steps instead of passing on a code", () => {
    const { map } = createSseMapper();
    const [error] = decode(map({ type: "result", subtype: "error_max_turns", is_error: false }));
    expect(error.kind).toBe("error");
    expect(error.kind === "error" && error.message).toMatch(/most tool steps/);
  });

  it("ignores the events that have nothing for the reader", () => {
    const { map } = createSseMapper();
    for (const event of [
      { type: "system", subtype: "status", status: "requesting" },
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 },
      { type: "system", subtype: "post_turn_summary" },
      { type: "stream_event", event: { type: "content_block_stop" } },
    ]) {
      expect(map(event)).toEqual([]);
    }
  });

  it("reports the model Claude Code resolved, so an alias never hides the version", () => {
    const { map } = createSseMapper();
    const frames = map({ type: "system", subtype: "init", apiKeySource: "none", model: "claude-opus-5" });
    expect(decode(frames)).toEqual([{ kind: "model", model: "claude-opus-5" }]);
  });

  it("says how to fix a model the installed Claude Code is too old for", () => {
    const { map } = createSseMapper();
    const [error] = decode(
      map({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or later is required",
      }),
    );
    expect(error.kind === "error" && error.message).toMatch(/claude update/);
  });

  it("does not repeat the fix when the server already gave it", () => {
    const { map } = createSseMapper();
    const server =
      "API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
    const [error] = decode(map({ type: "result", subtype: "success", is_error: true, result: server }));
    const message = error.kind === "error" ? error.message : "";
    expect(message.match(/claude update/gi)).toHaveLength(1);
    expect(message).toMatch(/No need to restart the bridge/);
  });

  it("remembers which credential Claude Code used", () => {
    const { map, summary } = createSseMapper();
    map({ type: "system", subtype: "init", apiKeySource: "none" });
    expect(summary.apiKeySource).toBe("none");
  });
});

describe("tool summaries", () => {
  it("shows the query for a search and the URL for a fetch", () => {
    expect(summarizeToolInput("WebSearch", { query: "Ekman transport" })).toBe("Ekman transport");
    expect(summarizeToolInput("WebFetch", { url: "https://example.org/a", prompt: "summarise" })).toBe(
      "https://example.org/a",
    );
  });

  it("falls back to the first text field for a connector, flattened and capped", () => {
    const long = `find\n\n${"x".repeat(200)}`;
    const summary = summarizeToolInput("mcp__claude_ai_PubMed__search", { term: long, limit: 5 });
    expect(summary.startsWith("find x")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(120);
  });

  it("reads a rate limit with no per-window detail", () => {
    expect(toRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 5 })).toEqual({
      status: "rejected",
      window: "five_hour",
      utilization: null,
      resetsAt: 5,
    });
    expect(toRateLimit(null)).toBeNull();
  });
});

describe("the protocol, app side", () => {
  it("decodes plain OpenAI chunks, so the bridge also reads as an ordinary provider", () => {
    expect(decodeBridgeFrame("message", JSON.stringify({ choices: [{ delta: { content: "hi" } }] }))).toEqual({
      kind: "text",
      text: "hi",
    });
    expect(decodeBridgeFrame("message", "[DONE]")).toEqual({ kind: "done" });
    expect(decodeBridgeFrame("message", "not json")).toBeNull();
  });
});
