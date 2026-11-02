# Progress — the bridge as a Messages API (2026-11-02)

Branch `overnight/2026-11-02-bridge-api`, from `feature/learn-from-project` (4454aa6).
Main checkout was clean when the branch was made.

## Requirements

- [ ] A protocol that chat shells other than ToonDao can use to reach the Claude Code framework (brief: "给一份协议…别的形式的对话壳也能用到")
- [ ] Parameters aligned with the API wherever the CLI can honour them (brief: "能和 API 对齐的参数对齐")
- [ ] What cannot be controlled is skipped — ignored in the open or refused, never silently faked (brief: "没法控制的就直接跳过")
- [ ] An integration doc (brief: "给一份对接文档")
- [ ] A working product, proven with a client that is not ToonDao (brief: "做这么一个产品出来")
- [ ] ToonDao's own route keeps working (`npm test`, type-check)

## Log

- 23:50 (Nov 1) · probed `claude -p` 2.1.312 (Haiku 5.5): raw `stream_event`s are the API's own SSE events; images (base64 and URL) and PDFs pass through stream-json; `--json-schema` works inline only; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` hits `max_tokens` and Claude Code then retries 3×; SIGINT still yields `message_delta` + a `result`; an unknown model gives `api_error_status: 404` · recordings in the session scratchpad · —
- 00:06 · walking skeleton: `POST /v1/messages` non-streaming and streaming, key check, Anthropic error envelope · curl against a bridge on :8799 started with a clean environment → 401 without a key; 200 Message (`claude-haiku-5-5`, usage, `toondao-ignored-params: temperature`); SSE sequence message_start → block → message_delta → message_stop · —
- 00:07 · the official Anthropic TypeScript SDK (0.123.0, read-only from ~/ChoiceLess) as the client · `sdk-check.mjs` → 10/10 PASS: create, stream + finalMessage, multi-turn, AuthenticationError, BadRequestError (client tool), NotFoundError (unknown model), models.list · —
- 00:09 · unit suite for the request classes, the command line and the translator, fed with recorded Claude Code runs (text, web search, max_tokens, structured, unknown model) · `npx vitest run` → 339 passed (299 before + 40); `tsc -p tsconfig.json` clean · see next commit
- 00:12 · each honoured field end to end through the route (official SDK, bridge on :8799, cap 2) · `layers.mjs` → PASS max_tokens (stopped at 40 out, 1.7 s, no Claude Code retries), stop_sequences ("7" → "1, 2, 3, 4, 5, 6, "), output_config.format (valid JSON), image, PDF, web_search (1 search counted, no tool blocks reach the client), concurrency (3 at once → 200, 200, 429 with retry-after 2 / x-should-retry true), CORS preflight echo, foreign origin → 403 permission_error · —
- 00:13 · `toondao.user_instructions` · "which language do your instructions name?" → default "NONE" (615 tokens in), on → "Chinese" (1,323) · —
- 00:14 · `toondao.project` on a synthetic one-file project snapshotted into a throwaway projects home, bridge started in-process · "secret word" → "PELICAN" via Glob + Read; unknown snapshot → 400 · —
- 00:16 · `examples/terminal-chat.mjs` (`npm run chat`), a zero-dependency shell · scripted session → multi-turn memory ("teal"), `/web on` lookup shown and answered, `/effort low` reaches the CLI (bridge log `effort=low`), a flag-shaped model name → 400 shown, not sent · see next commit
