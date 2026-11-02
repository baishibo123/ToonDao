#!/usr/bin/env node
/**
 * A chat shell that is not ToonDao: a terminal conversation over the bridge's
 * Messages API (docs/bridge-api.md), with no dependencies — plain fetch and an
 * SSE reader — so it doubles as the smallest complete client to copy from.
 *
 *   npm run bridge                      # in one terminal
 *   npm run chat                        # in another
 *
 * It keeps the conversation itself and sends all of it every turn, as any API
 * client does; the bridge holds nothing between requests. Lines typed at the
 * prompt are messages, except these:
 *
 *   /model <name>     opus, sonnet, haiku, fable, or a full id like claude-opus-5-5
 *   /effort <level>   low, medium, high, xhigh, max — or off
 *   /web on|off       let the model search and read the web
 *   /system <text>    set the system prompt (empty to clear)
 *   /reset            start over
 *   /quit
 *
 * Settings: TOONDAO_BRIDGE_URL (default http://127.0.0.1:8788), TOONDAO_API_KEY
 * (default: the contents of ~/.toondao/api-key).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const BASE = (process.env.TOONDAO_BRIDGE_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
const KEY = process.env.TOONDAO_API_KEY ?? readKey();
const tty = process.stdout.isTTY;
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

const settings = { model: "opus", effort: null, web: false, system: "" };
let history = [];

function readKey() {
  try {
    return readFileSync(join(homedir(), ".toondao", "api-key"), "utf8").trim();
  } catch {
    console.error("No key: start the bridge once (npm run bridge) to create ~/.toondao/api-key, or set TOONDAO_API_KEY.");
    process.exit(1);
  }
}

/** One request, streamed: prints the reply as it comes and returns the assistant turn to keep. */
async function send() {
  const body = {
    model: settings.model,
    max_tokens: 16000,
    stream: true,
    messages: history,
    ...(settings.system ? { system: settings.system } : {}),
    ...(settings.effort ? { output_config: { effort: settings.effort } } : {}),
    ...(settings.web ? { tools: [{ type: "web_search_20260209", name: "web_search" }, { type: "web_fetch_20260209", name: "web_fetch" }] } : {}),
  };
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`${res.status} ${error.error?.type ?? ""}: ${error.error?.message ?? res.statusText}`);
  }

  let text = "";
  let footer = {};
  for await (const { event, data } of readSSE(res.body)) {
    switch (event) {
      case "message_start":
        footer.model = data.message.model;
        break;
      case "content_block_delta":
        if (data.delta.type === "text_delta") {
          text += data.delta.text;
          process.stdout.write(data.delta.text);
        }
        break;
      case "content_block_start":
        // A second text block follows a lookup; keep the two apart on screen.
        if (data.content_block.type === "text" && text && !text.endsWith("\n")) {
          text += "\n\n";
          process.stdout.write("\n\n");
        }
        break;
      case "message_delta":
        footer = { ...footer, stop: data.delta.stop_reason, usage: data.usage };
        break;
      case "toondao.tool":
        process.stdout.write(dim(`${text && !text.endsWith("\n") ? "\n" : ""}  ⌕ ${data.name}: ${data.query}\n`));
        break;
      case "toondao.rate":
        footer.window = data;
        break;
      case "error":
        throw new Error(`${data.error.type}: ${data.error.message}`);
    }
  }
  process.stdout.write("\n");
  const u = footer.usage ?? {};
  const read = u.cache_read_input_tokens ?? 0;
  const window = typeof footer.window?.utilization === "number" ? ` · ${footer.window.window} window ${Math.round(footer.window.utilization * 100)}%` : "";
  console.log(
    dim(`  ${footer.model} · ${footer.stop} · in ${(u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read} (${read} cached) · out ${u.output_tokens ?? 0}${window}`),
  );
  return { role: "assistant", content: text };
}

/** Server-sent events from a fetch body: `{ event, data }` per frame. */
async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
    }
  }
}

function command(line) {
  const [name, ...rest] = line.slice(1).split(" ");
  const arg = rest.join(" ").trim();
  switch (name) {
    case "model":
      if (arg) settings.model = arg;
      return `model: ${settings.model}`;
    case "effort":
      settings.effort = !arg || arg === "off" ? null : arg;
      return `effort: ${settings.effort ?? "Claude Code's default"}`;
    case "web":
      settings.web = arg === "on";
      return `web: ${settings.web ? "on" : "off"}`;
    case "system":
      settings.system = arg;
      return `system prompt: ${arg ? JSON.stringify(arg) : "none"}`;
    case "reset":
      history = [];
      return "new conversation";
    case "quit":
      process.exit(0);
    default:
      return "commands: /model <name>, /effort <level|off>, /web on|off, /system <text>, /reset, /quit";
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
console.log(dim(`ToonDao bridge at ${BASE} · model ${settings.model} · /help for commands`));
rl.setPrompt("you › ");
// Piped input (a script) echoes each line itself instead of showing a prompt.
if (tty) rl.prompt();
let busy = Promise.resolve();
rl.on("line", (line) => {
  // Lines that arrive while a reply streams (a pasted script, say) wait their turn.
  busy = busy.then(async () => {
    const input = line.trim();
    if (!input) return;
    if (input.startsWith("/")) {
      if (!tty) console.log(`you › ${input}`);
      console.log(dim(command(input)));
      return;
    }
    if (!tty) console.log(`you › ${input}`);
    history.push({ role: "user", content: input });
    try {
      history.push(await send());
    } catch (err) {
      history.pop();
      console.log(`\n${dim("  ✗")} ${err.message}`);
    }
  }).finally(() => tty && rl.prompt());
});
rl.on("close", () => busy.then(() => process.exit(0)));
