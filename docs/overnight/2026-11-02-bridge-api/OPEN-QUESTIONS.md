# Open questions — the bridge as a Messages API (2026-11-02)

Every place the work would have stopped to ask. Sorted by revert cost × failure
cost, highest first.

### Q1: Who may use this API
- Chose for now: the person's own shells on their own machine only. The bridge
  still binds 127.0.0.1, every `/v1/messages` call needs the bridge's key, and
  the doc opens by saying this is not a way to give anyone else access to a
  subscription (P-26 applies unchanged, and more sharply: an Anthropic-shaped
  endpoint makes a subscription usable by any app that takes a base URL).
- Alternatives: none that keep P-26 — serving other people needs Anthropic's approval first.
- If wrong: an app pointed at the bridge can spend the whole five-hour window
  (an agent loop retrying, say); shared beyond the machine it is the third-party
  use P-26 describes — surfaces in the usage window, or in an account notice.
- Revert cost: policy, not code; the concurrency cap (Q7) limits the first risk.

### Q2: Do API runs carry the person's own Claude Code settings (`~/.claude/CLAUDE.md`)?
- Chose for now: no by default — API runs use `--setting-sources project,local`,
  so a shell gets the API's behaviour (its own system prompt and nothing else);
  `toondao.user_instructions: true` turns them back on. ToonDao's route keeps P-33.
  Measured: with them, "Say hi in three words" came back in Chinese and the run
  carried 1,256 tokens of context; without them, English and 548.
- Alternatives: follow P-33 everywhere (one behaviour for both doors).
- If wrong: other shells answer in English when you wanted your standing
  instructions everywhere — visible on the first reply.
- Revert cost: one default in `parseMessagesRequest()`.

### Q3: A structured-output schema reaches the command line
- Chose for now: `output_config.format` (`json_schema`) is honoured. Claude Code's
  `--json-schema` takes only inline JSON (a file path was refused: "not valid
  JSON"), so the schema is parsed, re-serialised by `schemaArg()`, capped at
  64 KB, and passed as one `--json-schema=<json>` argument. A re-serialised object
  starts with `{` and is a single argv element, so it can never be read as a flag;
  `argsFor()` checks again. This amends the invariant "nothing a request carries
  becomes a command-line flag" the way model and effort already do.
- Alternatives: refuse `output_config.format` with a 400.
- If wrong: a request could shape argv — but only as one JSON value of one flag.
- Revert cost: delete the mapping, refuse instead (a few lines + a test).

### Q4: `max_tokens` is honoured by stopping the run
- Chose for now: the run gets `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, and at the first
  `max_tokens` stop the bridge ends the run and answers `stop_reason: "max_tokens"`
  with what was produced, as the API would. Measured: left alone, Claude Code
  answers a `max_tokens` stop by asking the model to "Resume directly" — three
  more calls — and then fails.
- Alternatives: ignore `max_tokens` (Claude Code's default limit applies).
- If wrong: shells that habitually send `max_tokens: 1024` get cut-off answers
  from thinking-heavy models — exactly what the real API would do to them.
- Revert cost: one condition in the translator.

### Q5: Thinking blocks are passed through
- Chose for now: yes, as Claude Code receives them — empty `thinking` text plus a
  `signature`, which is what the API returns by default on current models.
  Replayed thinking blocks in a later request are dropped.
- Alternatives: drop them, so `content[0]` is always text.
- If wrong: a naive shell that reads `content[0].text` shows nothing — but it
  would break the same way against the real API.
- Revert cost: one line.

### Q6: Base branch
- Chose for now: `overnight/2026-11-02-bridge-api` from `feature/learn-from-project`
  (4454aa6), the newest line and the only one with the bridge's latest state; `main` has no bridge.
- If wrong: this work can only land after that line does.
- Revert cost: the commits touch the bridge and docs only; cherry-pick onto another base.

### Q7: A cap on runs in flight
- Chose for now: at most 4 `/v1/messages` runs at once (`TOONDAO_API_CONCURRENCY`);
  the fifth gets `429 rate_limit_error` with `retry-after: 2` and `x-should-retry: true`,
  which the SDKs back off on by themselves. ToonDao's route is not capped.
- If wrong: a shell that fans out more than four requests waits.
- Revert cost: one number.

### Q8: Claude Code runs out of tool steps
- Chose for now: `stop_reason: "end_turn"` plus a notice (`toondao.notice` event,
  `toondao.notices` in the body). `pause_turn` would invite a continuation the
  bridge refuses (a final assistant turn); an error would throw away the answer.
- Revert cost: one branch in the translator.

### Q9: What `/v1/models` lists
- Chose for now: the aliases Claude Code resolves (`fable`, `opus`, `sonnet`,
  `haiku`); any safe full id is answered by `/v1/models/{id}`. `created_at` is
  the Unix epoch — the bridge does not know release dates.
- Revert cost: a constant.

### Q10 (FUTURE): ToonDao's own route has no key yet
- `/v1/chat/completions` still answers any local non-browser client. Closing it
  needs the app to send a key — the pairing-code work already planned
  (bridge security, next after learning-from-project).

### Q11 (FUTURE): a bridge started inside a Claude Code session inherits `ANTHROPIC_BASE_URL`
- `runEnv()` drops `CLAUDE*` but keeps `ANTHROPIC_*`; inside the desktop app that
  points Claude Code at the host's gateway. Tonight's live tests start the bridge
  with a clean environment instead.

### Q12 (FUTURE): finer web-tool options
- `web_fetch.allowed_domains` could become `--allowedTools "WebFetch(domain:…)"`;
  `max_uses` has no CLI counterpart. Ignored and named back for now.
