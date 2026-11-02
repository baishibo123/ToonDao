# The bridge as a Messages API

The ToonDao bridge runs your own signed-in Claude Code (`claude -p`) for every
request. ToonDao talks to it in its own protocol; **any other chat shell can talk
to it in the Anthropic Messages API's** — the same request fields, response
object, streaming events and errors. A client built for the API works by
changing two settings: the base URL and the key.

```
your shell ── POST /v1/messages ──▶ bridge (127.0.0.1:8788) ── stdin/stdout ──▶ claude -p ──▶ your Claude subscription
   (SDK, curl, anything)            one fresh run per request
```

> **For your own shells, on your own machine.** The bridge spends your Claude
> subscription. It listens on 127.0.0.1 only and asks for its own key on every
> request. Giving other people access to your subscription through it — or
> publishing it so that they use theirs — is the third-party use Anthropic's
> terms restrict; see decision P-26 in `docs/decisions.md` before sharing
> anything.

## Quick start

1. Install Claude Code and sign in once: `claude`.
2. Start the bridge (Node 22.18+):

   ```bash
   npm run bridge
   ```

   It prints where the API is and where its key is kept. The first start creates
   the key in `~/.toondao/api-key`, readable only by you.
3. Send a message:

   ```bash
   curl http://127.0.0.1:8788/v1/messages \
     -H "content-type: application/json" \
     -H "x-api-key: $(cat ~/.toondao/api-key)" \
     -d '{"model": "opus", "max_tokens": 4096, "messages": [{"role": "user", "content": "Hello"}]}'
   ```

Or try the bundled terminal shell, which is nothing but a client of this API
(`examples/terminal-chat.mjs`, no dependencies):

```bash
npm run chat
```

### From an Anthropic SDK

Point the client at the bridge; everything else is the SDK as documented.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const client = new Anthropic({
  baseURL: "http://127.0.0.1:8788",
  apiKey: readFileSync(`${homedir()}/.toondao/api-key`, "utf8").trim(),
});

const stream = client.messages.stream({
  model: "opus",
  max_tokens: 16000,
  messages: [{ role: "user", content: "Explain backpressure in one paragraph." }],
});
stream.on("text", (text) => process.stdout.write(text));
const message = await stream.finalMessage();
```

```python
import pathlib, anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:8788",
    api_key=(pathlib.Path.home() / ".toondao" / "api-key").read_text().strip(),
)
message = client.messages.create(
    model="opus",
    max_tokens=16000,
    messages=[{"role": "user", "content": "Explain backpressure in one paragraph."}],
)
```

Any other app that takes an Anthropic base URL and key works the same way. Do not
put the bridge's key in `ANTHROPIC_API_KEY` in a shell where you also run
`claude` — Claude Code would try to use it as a real API key.

## Endpoints

| Method | Path | Key | What it does |
|---|---|---|---|
| `POST` | `/v1/messages` | yes | Create a message — the Messages API |
| `GET` | `/v1/models` | yes | The model aliases (`fable`, `opus`, `sonnet`, `haiku`) |
| `GET` | `/v1/models/{id}` | yes | One model by alias or full id |
| `GET` | `/v1/health` | no | Is Claude Code installed and signed in |
| `GET` | `/v1/projects` | no | Project snapshots you can read from (see `toondao.project`) |

`/v1/messages/count_tokens`, batches and the Files API are not available.

## Authentication

Send the bridge's key as `x-api-key: <key>` (what the SDKs do) or as
`Authorization: Bearer <key>`. The key is `TOONDAO_API_KEY` if that is set when
the bridge starts, otherwise the contents of `~/.toondao/api-key`. It starts with
`tdk-` and is not an Anthropic key: the bridge never reads, stores or forwards
your Claude credentials, and this key never reaches Claude Code either.

## Request

Every field of a request is in one of three classes.

- **Honoured** — Claude Code can do what the field asks, and does.
- **Ignored, in the open** — it cannot change what a correct answer looks like.
  The response lists every such field in a `toondao-ignored-params` header (and
  in `toondao.ignored` in a non-streaming body), so nothing is dropped silently.
- **Refused** — it promises something the run would silently fail to deliver.
  The request gets a 400 `invalid_request_error` saying which field and why.

### Honoured

| Field | How the bridge does it |
|---|---|
| `model` (required) | `claude --model`. An alias (`opus`, `sonnet`, `haiku`, `fable`) is resolved by your installed Claude Code; the response's `model` says which version answered. A newer model may need `claude update`. |
| `messages` (required) | `user` and `assistant` turns, as a string or as blocks — see [Content](#content). |
| `system` | A string or a list of text blocks; replaces Claude Code's own coding prompt. |
| `max_tokens` | Optional here. The output limit for the run; at the first `max_tokens` stop the bridge ends the run and answers `stop_reason: "max_tokens"` with what was produced, as the API does. (Left alone, Claude Code would ask the model to resume.) With thinking, a small limit can be spent before any text — as with the API. |
| `stop_sequences` | Watched in the text as it streams. At a match the run is stopped and the reply ends just before the sequence: `stop_reason: "stop_sequence"`, `stop_sequence` names it. Up to 16. |
| `stream` | `true` for server-sent events, otherwise one JSON body. |
| `output_config.effort` | `claude --effort`: `low`, `medium`, `high`, `xhigh`, `max`. |
| `output_config.format` | `{"type": "json_schema", "schema": {…}}` — the reply's text is JSON that validates against the schema (Claude Code's `--json-schema`). Schemas up to 64 KB. |
| `tools` | Only the web server tools: `web_search_*` lets the model search the web, `web_fetch_*` lets it read a page. They run as Claude Code's own WebSearch and WebFetch. No other tool is offered — not your account's connectors either. |
| `tool_choice` | `{"type": "auto"}` (the default) or `{"type": "none"}`, which takes the web tools away. |
| `thinking` | `{"type": "adaptive"}` is what Claude Code does anyway. |

### Ignored, in the open

`temperature`, `top_p`, `top_k`, `metadata`, `service_tier`, `cache_control`,
`inference_geo`, `speed`, `context_management`, `fallbacks`, `container`,
`thinking` other than adaptive (and `thinking.display`), `output_config.task_budget`,
the web tools' options (`max_uses`, `allowed_domains`, `blocked_domains`,
`user_location`, …), `tool_choice.disable_parallel_tool_use`, and any top-level
field the bridge does not know. Current models reject the sampling parameters
anyway. (Inside content blocks, `cache_control` and `citations` are dropped
without a mention; see [Content](#content).)

### Refused

| What | Why |
|---|---|
| Client tools (`input_schema`, `"type": "custom"`) and any server tool other than web search and fetch | A client tool needs a loop in which your code runs it and sends the result back; a stateless `claude -p` run is not that loop. Nothing that runs commands or writes files is ever offered. |
| `tool_use` and `tool_result` blocks in `messages` | They only exist with client tools. |
| `tool_choice` `any` or `tool` | Forced tool use — also rejected by the API on current models. |
| A final `assistant` turn (prefill) | Also rejected by the API on current models. |
| A `system` turn inside `messages` | Put it in the top-level `system`. |
| `mcp_servers` | MCP servers are not available through the bridge. |
| A model name that is not one | Anything shaped like a command-line flag never reaches the command line. |

### Content

| Block | |
|---|---|
| `text` | Yes. A block's own `cache_control` or `citations` is dropped, here and on every block: Claude Code places the cache breakpoints itself. |
| `image` | Yes — `base64` or `url` sources. |
| `document` | Yes — a base64 PDF, plain text (`"type": "text"`), or a `url`; `title` and `context` are kept. |
| `thinking`, `redacted_thinking`, `server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result` | Dropped from earlier `assistant` turns — they belong to the reply that produced them. Send `response.content` back as it is; it works. |
| `tool_use`, `tool_result`, anything else | Refused. |

### The `toondao` extension

One namespaced field for what only the bridge can do:

```json
{
  "model": "opus",
  "messages": [{"role": "user", "content": "Where does this project parse its config?"}],
  "toondao": {
    "project": {"slug": "osmo-dock", "snapshot": "2026-10-07T14-55-02Z"},
    "user_instructions": true
  }
}
```

- `project` — let the model read one of your project snapshots: the harvest
  page and a copy of the project's files, read-only (Read, Grep and Glob, inside
  the snapshot and nowhere else). `GET /v1/projects` lists them; add one from
  ToonDao's Settings → Projects, or with `npm run harvest -- "<folder>" --snapshot`.
- `user_instructions` — `false` by default: a run gets your `system` prompt and
  nothing of yours besides. `true` brings your own Claude Code settings along,
  including `~/.claude/CLAUDE.md` — your standing instructions, as ToonDao uses
  them.

With the SDKs, pass it as an extra body field: in Python `extra_body={"toondao": {...}}`;
in TypeScript add it to the params object (cast the object, since the SDK's
types do not know it).

## Response

### Non-streaming

```json
{
  "id": "msg_bridge_a6bb02f827aaad0d8bff0256",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-5-5",
  "content": [{"type": "text", "text": "Hello there friend!"}],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "usage": {
    "input_tokens": 2,
    "cache_creation_input_tokens": 590,
    "cache_read_input_tokens": 0,
    "output_tokens": 9,
    "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}
  },
  "toondao": {
    "tools": [],
    "rate_limit": {"status": "allowed", "window": "five_hour", "utilization": 0.62, "resetsAt": 1793607600},
    "ignored": ["temperature"],
    "notices": []
  }
}
```

- `content` holds `text` blocks, and `thinking` blocks as Claude Code receives
  them — with empty text and a signature, which is the API's default on current
  models too.
- `stop_reason` is `end_turn`, `max_tokens`, `stop_sequence` or `refusal` —
  never `tool_use` or `pause_turn`.
- `usage` is summed over every model call the reply took: a web lookup is a
  short tool loop inside Claude Code, and you see it as one message.
  `server_tool_use` counts the lookups.
- `toondao` is the extension: `tools` lists each lookup or file read
  (`{"name": "WebSearch", "query": "…"}`), `rate_limit` is your subscription's
  usage window as Claude Code last reported it, `ignored` is the ignored fields,
  and `notices` says when Claude Code ran out of tool steps and the answer may be
  incomplete.

### Streaming

The API's event sequence: `message_start`, then `content_block_start` /
`content_block_delta` / `content_block_stop` per block, then `message_delta`
(stop reason, usage) and `message_stop`. The SDKs' stream helpers
(`messages.stream()`, `.finalMessage()`, `on("text")`) work as with the API.

Three more events carry the extension; the SDKs skip events they do not know, so
they are safe to ignore:

| Event | Data |
|---|---|
| `toondao.tool` | `{"type": "toondao.tool", "name": "WebSearch", "query": "…"}` — sent as the model looks something up |
| `toondao.rate` | `{"type": "toondao.rate", "status": "allowed", "window": "five_hour", "utilization": 0.62, "resetsAt": 1793607600}` |
| `toondao.notice` | `{"type": "toondao.notice", "message": "…"}` |

A run that fails before its first output gets a real HTTP error rather than a
`200` with an error inside: the status line is held until there is a message to
stream. A failure after that arrives as an `error` event, as with the API.

### Headers

| Header | |
|---|---|
| `request-id` | `req_bridge_…`, also in error bodies |
| `toondao-ignored-params` | The ignored fields, comma-separated (absent when none) |
| `retry-after`, `x-should-retry` | On a 429 or 529; the SDKs read both |

## Errors

The API's envelope: `{"type": "error", "error": {"type": "…", "message": "…"}, "request_id": "…"}`.

| Status | `type` | When |
|---|---|---|
| 400 | `invalid_request_error` | A refused or malformed field, or a snapshot that does not exist |
| 401 | `authentication_error` | No key, or not the bridge's key |
| 403 | `permission_error` | A browser page from an origin not in `TOONDAO_ORIGINS` |
| 404 | `not_found_error` | A model your Claude Code does not know (try `claude update`), or a path the bridge does not serve |
| 413 | `request_too_large` | A body over 25 MB |
| 429 | `rate_limit_error` | Your usage window is spent (`x-should-retry: false`, `retry-after` until it resets), or more runs are in flight than the bridge allows (`x-should-retry: true`, `retry-after: 2`) |
| 500 | `api_error` | Claude Code could not start, is signed out, crashed, or ran past 15 minutes |
| 529 | `overloaded_error` | The model is overloaded |

## How it differs from the API

These follow from running Claude Code rather than calling the API, and none of
them is hidden in the response:

- **A process per request.** Each request starts `claude -p`, about 1.5 s
  before the first token. Nothing is kept between requests: send the whole
  conversation every time, as with the API.
- **The conversation arrives as one message.** `claude -p` takes one message, so
  a multi-turn conversation is written out as a transcript, one block per turn
  (`User:` / `Assistant:`). The model answers the last turn; it reads its earlier
  turns rather than having produced them in this run.
- **Claude Code adds context of its own** — about 550 tokens: its environment
  block, and the web tools' definitions when they are on; with
  `user_instructions`, your settings and `CLAUDE.md` as well.
- **Prompt caching is automatic.** Claude Code places the cache breakpoints;
  `cache_control` is ignored. Because every turn's block is written the same way
  each time, a growing conversation reads its earlier turns back: with a
  4,500-token system prompt, the second turn read 3,999 tokens from the cache and
  the third read 4,258 and wrote 366 (Haiku 5.5 and Sonnet 5.5 alike). The first
  two turns differ in shape — a lone question is sent as it is — so the second
  turn re-reads only the system prompt.
- **Thinking is Claude Code's call.** It decides whether and how the model
  thinks; `effort` is the lever you have.
- **No agent loops.** Without client tools, this is for conversation, lookup
  and reading — not for driving your own tools. For that, use Claude Code itself
  or the Claude Agent SDK.
- **It spends your subscription's usage window**, which Claude Code itself and
  ToonDao share; `toondao.rate` and the `rate_limit` field show how much is
  spent. There is no per-token price.

## Browser shells

A web page can use the API when its origin is listed in `TOONDAO_ORIGINS`
(comma-separated; ToonDao's own dev origins are the default). The bridge answers
the CORS preflight with the headers the page asks for, and exposes `request-id`,
`toondao-ignored-params`, `retry-after` and `x-should-retry`. The TypeScript SDK
needs `dangerouslyAllowBrowser: true` in a browser — and the key is then in the
page, so keep such a page to yourself.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8788` | The bridge's port, on 127.0.0.1 |
| `TOONDAO_API_KEY` | (the key file) | Use this key instead of `~/.toondao/api-key` |
| `TOONDAO_API_CONCURRENCY` | `4` | Messages API runs in flight at once; each is a whole Claude Code process |
| `TOONDAO_ORIGINS` | ToonDao's dev origins | Browser origins allowed to call the bridge |
| `CLAUDE_BIN` | `claude` | The Claude Code to run |

## What the bridge guarantees

- It listens on 127.0.0.1 only, refuses a foreign `Host` (DNS rebinding) and any
  browser origin not allowed, and answers `/v1/messages` only with its key.
- No tool that runs commands or writes files is ever offered. The web tools are
  offered only when a request declares them; a project is read only through a
  snapshot, read-only.
- Nothing a request carries becomes a command-line flag except a checked model
  name, an effort level, and a JSON schema the bridge re-serialises itself. The
  system prompt goes through a file, the conversation through stdin.
- Each run starts in the same empty folder, so no project's files or settings
  are in reach, and no session is saved to your Claude Code history.
