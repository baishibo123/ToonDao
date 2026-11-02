/**
 * Check the running bridge's Messages API against the real Claude Code.
 *
 *   npm run bridge                 # in one terminal
 *   npm run check:api              # in another; add --web for a web lookup too
 *
 * The bridge translates Claude Code's stream-json events into the API's, and
 * those events belong to Claude Code: a `claude update` can change them without
 * a word. The unit suite replays recordings, so it cannot notice; this asks the
 * live bridge, with a handful of small requests (Haiku unless --model says
 * otherwise) that count toward the subscription's usage window. Deliberately NOT
 * part of `npm test`.
 *
 * Settings: TOONDAO_BRIDGE_URL (default http://127.0.0.1:8788), TOONDAO_API_KEY
 * (default: the contents of ~/.toondao/api-key).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const BASE = (process.env.TOONDAO_BRIDGE_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
const MODEL = args.includes("--model") ? args[args.indexOf("--model") + 1] : "haiku";
const KEY = process.env.TOONDAO_API_KEY ?? readKey();

function readKey() {
  try {
    return readFileSync(join(homedir(), ".toondao", "api-key"), "utf8").trim();
  } catch {
    console.error("No key: start the bridge once (npm run bridge), or set TOONDAO_API_KEY.");
    process.exit(2);
  }
}

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const post = (body, key = KEY) =>
  fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify(body),
  });
const ask = (content, extra = {}) => ({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content }], ...extra });
const textOf = (message) => (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");

/** Every frame of a streamed response, in order. */
async function frames(res) {
  const out = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (event && data) out.push({ event, data: JSON.parse(data) });
    }
  }
  return out;
}

/** The ordering rules the SDKs' stream readers enforce, as one list of problems. */
function orderProblems(events) {
  const problems = [];
  const api = events.filter((e) => !e.event.startsWith("toondao."));
  if (api[0]?.event !== "message_start") problems.push(`first event is ${api[0]?.event}`);
  if (api.at(-1)?.event !== "message_stop") problems.push(`last event is ${api.at(-1)?.event}`);
  if (api.at(-2)?.event !== "message_delta") problems.push("no message_delta before message_stop");
  const open = new Set();
  const seen = new Set();
  for (const { event, data } of api) {
    if (event === "content_block_start") {
      if (seen.has(data.index)) problems.push(`block ${data.index} started twice`);
      if (data.index !== seen.size) problems.push(`block ${data.index} out of order`);
      seen.add(data.index);
      open.add(data.index);
    } else if (event === "content_block_delta" && !open.has(data.index)) {
      problems.push(`delta for block ${data.index}, which is not open`);
    } else if (event === "content_block_stop") {
      if (!open.delete(data.index)) problems.push(`stop for block ${data.index}, which is not open`);
    }
  }
  if (open.size) problems.push(`blocks left open: ${[...open]}`);
  return problems;
}

const health = await fetch(`${BASE}/v1/health`).then((r) => r.json()).catch(() => null);
if (!health) {
  console.error(`No bridge at ${BASE}. Start it with: npm run bridge`);
  process.exit(2);
}
check("Claude Code is installed and signed in", health.installed && health.loggedIn, `${health.version ?? "not found"}`);

const anonymous = await post(ask("hi"), "");
check("a request without the key is refused", anonymous.status === 401, `${anonymous.status}`);

const refused = await post(ask("hi", { tools: [{ name: "f", input_schema: { type: "object" } }] }));
check("a client tool is refused, not faked", refused.status === 400 && (await refused.json()).error?.type === "invalid_request_error");

const plainRes = await post(ask("Reply with the single word: ready", { temperature: 0.5 }));
const plain = await plainRes.json();
check("a plain request answers as a Message", plainRes.status === 200 && plain.type === "message" && textOf(plain).length > 0, `${plain.model}: ${JSON.stringify(textOf(plain)).slice(0, 60)}`);
check("the model is named as it ran", typeof plain.model === "string" && plain.model.startsWith("claude-"), plain.model);
check("usage is reported", plain.usage?.output_tokens > 0, JSON.stringify(plain.usage));
check("ignored fields are named back", plainRes.headers.get("toondao-ignored-params") === "temperature");

const streamRes = await post(ask("Count from 1 to 5, separated by commas.", { stream: true }));
const events = await frames(streamRes);
const problems = orderProblems(events);
check("a stream follows the API's event order", streamRes.status === 200 && problems.length === 0, problems.join("; ") || `${events.length} events`);

const capped = await (await post(ask("Write a 300-word story about a lighthouse.", { max_tokens: 30 }))).json();
check("max_tokens ends the reply where the API would", capped.stop_reason === "max_tokens", `${capped.stop_reason}, out ${capped.usage?.output_tokens}`);

const stopped = await (await post(ask("Count from 1 to 20, separated by commas, nothing else.", { stop_sequences: ["7"] }))).json();
check(
  "a stop sequence ends the reply before it",
  stopped.stop_reason === "stop_sequence" && stopped.stop_sequence === "7" && !textOf(stopped).includes("7"),
  JSON.stringify(textOf(stopped)),
);

const schema = { type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false };
const structured = await (await post(ask("What is 6 times 7?", { output_config: { format: { type: "json_schema", schema } } }))).json();
let parsed = null;
try {
  parsed = JSON.parse(textOf(structured));
} catch {}
check("a JSON schema gets JSON back", parsed?.answer === 42, textOf(structured));

if (args.includes("--web")) {
  const webRes = await post(ask("Search the web: what is today's date? One line.", { stream: true, tools: [{ type: "web_search_20260209", name: "web_search" }] }));
  const webEvents = await frames(webRes);
  const delta = webEvents.find((e) => e.event === "message_delta");
  check("a web lookup runs and is counted", (delta?.data.usage?.server_tool_use?.web_search_requests ?? 0) >= 1, webEvents.filter((e) => e.event === "toondao.tool").map((e) => e.data.query).join(" | "));
  const webProblems = orderProblems(webEvents);
  check("a tool loop still streams as one message", webProblems.length === 0, webProblems.join("; ") || `${webEvents.length} events`);
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
