# Design — the bridge as a Messages API (2026-11-02)

Brief (the user, 2026-11-02): turn what ToonDao does with the Claude Code CLI
into an API-like product — a protocol plus an integration doc — so chat shells
other than ToonDao can use the same framework. Align with the Anthropic API
wherever the CLI lets us; skip what it cannot control. Free design latitude.

## Shape in one paragraph

The bridge already runs `claude -p` per request for ToonDao. It gains a second
front door, `POST /v1/messages`, that speaks the Anthropic Messages API wire
format: same request fields, same response object, same SSE event sequence, same
error envelope. Any client built for the API — the official SDKs with `baseURL`
pointed at the bridge, curl, a hand-written shell — works unchanged as long as it
stays inside what Claude Code can honour. Every request field is in one of three
classes: **honoured** (mapped to a CLI flag, the stdin message, or the event
translation), **ignored in the open** (cannot change what a correct answer looks
like; named back in a `toondao-ignored-params` header), or **refused** with a
400 (it promises a capability the run would silently fail to deliver). ToonDao's
own route, `/v1/chat/completions`, is unchanged.

## Flow

```
 another shell (SDK, curl, examples/terminal-chat.mjs)     ToonDao app
        │ POST /v1/messages  + x-api-key                        │ POST /v1/chat/completions
        ▼                                                       ▼
   route() ── guardRequest() ─────┬──────────────────────── chat()   (unchanged)
                                  ▼
                       [messagesRoute()]
                          │ [checkApiKey()] ◀── [loadApiKey()] ◀── ~/.toondao/api-key | TOONDAO_API_KEY
                          │ [parseMessagesRequest()] ──▶ 400 invalid_request_error
                          │ toStreamInput()* ──▶ { system file, one stdin line }
                          ▼
                       runClaude()* ── argsFor()* ── spawn claude -p ──▶ stream-json events
                          │
                          ▼
              [createMessagesTranslator()]   push(event) → ApiEvent[]   finish(failure) → ApiEvent[]
                          │                  (asks for the run to stop at a stop sequence / max_tokens)
                ┌─────────┴──────────┐
           stream: true          stream: false
           [sseFrame()]          [accumulateMessage()]
                │                     │
                ▼                     ▼
     SSE, headers held until     one Message JSON, or the
     message_start (so a run     HTTP error a failed run maps to
     that fails first gets a     ([apiErrorForResult()])
     real HTTP error)
```

`*` = existing, extended. New pieces are in `[ ]`.

## Signatures

### `bridge/api-key.ts`

- `loadApiKey(opts?: { env?: NodeJS.ProcessEnv; file?: string }): Promise<{ key: string; source: "env" | "file" | "created" }>`
  — env/file → the key. `TOONDAO_API_KEY` if set, else the key file, else a new
  random key written owner-only (0600) to `~/.toondao/api-key`.
- `checkApiKey(headers: { xApiKey?: string; authorization?: string }, key: string): boolean`
  — request headers → match. Accepts `x-api-key: <key>` or `Authorization: Bearer <key>`, compared in constant time.

### `bridge/messages-api.ts`

- `parseMessagesRequest(body: unknown): { ok: true; request: ApiRequest } | { ok: false; error: ApiError }`
  — JSON body → validated request, or the first problem as an `invalid_request_error`.
  Classifies every field: honoured / ignored (listed in `request.ignored`) / refused.
- `schemaArg(schema: unknown): string | null`
  — an `output_config.format.schema` → canonical JSON for `--json-schema=`, or null if it is not a JSON object under 64 KB.
- `createMessagesTranslator(opts: TranslatorOptions): { push(event): ApiEvent[]; finish(failure?: ApiError | null): ApiEvent[]; state }`
  — Claude Code stream-json events → Messages API events. Merges Claude Code's
  internal tool-loop messages into one API message, re-indexes content blocks,
  passes text and thinking blocks through, hides tool_use, counts web lookups
  into `usage.server_tool_use`, emulates `stop_sequences` and `max_tokens` by
  asking the run to stop, and sums usage over the internal messages.
- `apiErrorForResult(result: Record<string, unknown>, rateLimit: RateLimit | null): ApiError`
  — a failed `result` event → HTTP status + Anthropic error type (+ retry hints).
- `accumulateMessage(events: ApiEvent[]): Record<string, unknown>`
  — the event sequence → the Message object a non-streaming request returns (folds like the SDK's MessageStream).
- `sseFrame(event: ApiEvent): string` — one API event → `event: …\ndata: …\n\n`.
- `messagesRoute(req, res, path, ctx: { opts: BridgeOptions; cors: Record<string, string> }): Promise<void>`
  — `/v1/messages` and `/v1/models[/id]`: authenticate, parse, run, answer in the API's shapes.

### `bridge/claude-code.ts` (extended)

- `toStreamInput(messages)` — `content` may now be `string | InputBlock[]` (text, image, document); a text-only payload produces byte-identical output to before.
- `argsFor({ …, researchTools?, noConnectors?, withoutUserSettings?, jsonSchema? })`
  — narrower research tool sets (never wider than `RESEARCH_TOOLS`), no connectors,
  `--setting-sources project,local`, `--json-schema=` (re-checked, +2 turns).
- `runClaude({ …, maxOutputTokens? })` — sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for that run only.
- `runEnv(env)` — also drops `TOONDAO_API_KEY`, so the bridge's key never reaches Claude Code.
- `corsHeaders(origin, allowed, requestHeaders?)` — echoes the preflight's requested headers (SDKs send `x-api-key`, `anthropic-version`, `x-stainless-*`) and exposes `request-id`, `toondao-ignored-params`, `retry-after`, `x-should-retry`.

### `examples/terminal-chat.mjs`

- A zero-dependency terminal chat shell over `/v1/messages` (streaming): history,
  `/model`, `/effort`, `/web`, `/reset`; shows lookups and the usage window.

## Field classes (summary; the doc has the full table)

| Honoured | How |
|---|---|
| `model` | `--model` (checked by `isSafeModel`); the response names the resolved id |
| `system` | `--system-prompt-file` |
| `messages` (text, image, document) | one stream-json message, transcript as today |
| `stream` | SSE or one JSON body |
| `max_tokens` | `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; the run is stopped at the first `max_tokens` stop (Claude Code would retry) |
| `stop_sequences` | watched in the text stream; the run is stopped at a match |
| `output_config.effort` | `--effort` |
| `output_config.format` (json_schema) | `--json-schema=`; the validated JSON is the reply text |
| `tools`: `web_search_*`, `web_fetch_*` | WebSearch / WebFetch only, no connectors |
| `tool_choice` `auto` / `none` | none drops the tools |
| `toondao.project`, `toondao.user_instructions` | snapshot read (P-31); the person's own Claude Code settings (P-33) |

Ignored and named back: `temperature`, `top_p`, `top_k`, `metadata`,
`service_tier`, `cache_control`, `inference_geo`, `speed`, `context_management`,
`fallbacks`, `container`, `thinking` other than adaptive, server-tool options
(`max_uses`, domains, …), any unknown top-level field.

Refused (400): custom/client tools and every non-web server tool, `tool_choice`
`any`/`tool`, `tool_use`/`tool_result` blocks, a mid-conversation `system` turn,
a final assistant turn (prefill), `mcp_servers`.

## Changes during the night

- `schemaArg()` / `isSchemaArg()` moved to `claude-code.ts`, beside `argsFor()`:
  every rule about what reaches the command line stays in one file.
- `route()` loads `messages-api.ts` with a dynamic import: the module builds on
  `claude-code.ts`, so a static import would be a cycle.
- A guard failure (Host, Origin, content type) on an API path now answers in the
  API's error envelope; ToonDao's paths keep theirs.
- `finish()` emits all closing events — including the structured-output text
  block — once the process has ended, so a run the bridge cut short still reports
  the cut call's usage (Claude Code sends `message_delta` after SIGINT).
- `readBody()` split out of `readJson()`, so the API route can answer bad JSON
  with a 400 instead of reading it as an empty object.
