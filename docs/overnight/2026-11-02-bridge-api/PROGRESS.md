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

- 00:50 · probed `claude -p` 2.1.312 (Haiku 5.5): raw `stream_event`s are the API's own SSE events; images (base64 and URL) and PDFs pass through stream-json; `--json-schema` works inline only; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` hits `max_tokens` and Claude Code then retries 3×; SIGINT still yields `message_delta` + a `result`; an unknown model gives `api_error_status: 404` · recordings in the session scratchpad · —
