# ToonDao

A chat for reading. Local-first, bring your own key.

Long AI answers are hard to read well. You hit a term you don't know, you lose
the thread halfway down, you want to answer one sentence rather than the whole
reply. An ordinary chat client offers one move for all of it — type another
message — and every detour lands in the same scroll. ToonDao gives each of those
moments a move of its own, and keeps the conversation you are reading one
conversation long.

## The moves

| When the answer… | you… | and |
|---|---|---|
| uses a term you don't know | **Explain** it — click the term | it is answered in an aside beside the thread, carrying only the last few turns |
| uses a term that can wait | park it for **Later** | it is marked in place and listed in the sidebar; asking about it later clears it |
| says something you want to answer | **Reply** — select the passage | it is quoted above your message, in the same conversation |
| has a passage worth examining alone | ask about **Just this** | it is answered in an aside with nothing else attached |
| lost you partway down | cut it — **Lost me here**, on the answer's left edge | an aside picks up from the cut; nothing after it is sent |
| answers a question you wish you had asked differently | **Rewind** — ↺ under your question | you ask it again from there; what followed becomes a side row, nothing deleted (the first question is asked again in a new conversation) |
| (inside an aside) | take it back — **To thread** | what you learned is quoted into the thread |

One more, on the model's side: with **Pace answers** on (the default), the model
is asked for one idea at a time, stopping at a checkpoint with a question.

The thread is always one linear conversation. Asides open beside it, never in
it, and nest — an aside can have asides of its own, with a breadcrumb home.
Asking inside an aside moves that aside into the centre and opens the new one
beside it. Drag the line between them to share the width (double-click resets
it), and ⤢ lets an aside fill the canvas for a closer look until ⤡ or Esc.
Every aside is also a row in the sidebar, nested under what it left. An aside
keeps its move's promise for as long as you talk in it: a follow-up carries what
the move carried plus the aside's own turns, never the rest of the thread.
A reload, or a trip to another conversation and back, finds the same asides
open, the same unsent words in each box and each pane where you left it.
A code block, a formula or a table copies its source from its corner; a
message's **copy** pastes as Markdown into an editor and formatted into a
document. A code block also **saves** as a file, under the name the model
gave it (```` ```python scripts/fetch.py ````), and a reply that names two or
more files saves them as one `.zip` with their folders; a whole reply saves
as `.md`. Scrolled up, a pane offers ↓ back to the end, with a dot while a
reply is still being written there.

A question can carry **files** — images, PDFs, Word and PowerPoint files (read as
text, their pictures alongside) and text or code files — from 📎,
a paste or a drop; they stay with that turn of the thread, and an aside carries
only the text it carved out. When a reply draws in **SVG**, the drawing is shown,
with its source a click away.

Every message has a **context** action showing exactly what the model was sent.
Where a payload is anything other than the conversation on screen, the message
says so above its text, and the composer shows it before you send.

## Run it

```bash
npm install
npm run dev
```

No backend, no accounts. Everything lives in your browser's IndexedDB. Open
**Settings → Provider**, pick a provider, paste its key. Presets ship for
OpenAI-compatible endpoints, Anthropic (native `/v1/messages`) and OpenRouter
(one key, many vendors, callable straight from the browser); every base URL is
editable, so any relay (中转) works too. `npm run check:models` checks the
OpenRouter preset against the live catalogue.

To try it without a key:

```bash
npm run dev:mock
```

then pick **Mock server (dev, no key)** in Settings. The mock speaks the real
wire format and appends every request body to `dev/requests.jsonl`, so you can
confirm that what the context action shows is what actually went out.

Press `?` in the app for keyboard shortcuts. A conversation is named by the model
after its first reply; ↻ beside the title names it again from where it has gone,
and a title you type yourself stays.

### Use a Claude subscription instead of an API key

If you have Claude Code — through a school's or company's Claude seat, say —
ToonDao can run on your own subscription:

1. Install Claude Code and sign in once: run `claude`.
2. In a second terminal: `npm run bridge` (Node 22.18 or newer).
3. In ToonDao: **Settings → Provider → Active → "Claude Code (local bridge)"**.
   Its status — running, signed in — is shown right there.

Each message starts your own `claude -p` in an empty working folder, with
Claude Code's coding prompt replaced by ToonDao's, nothing saved to your Claude
Code history, and no tools unless the move allows them: **Explain** may search
and read the web, for as long as you talk in its aside; **Just this** and **Lost
me here** never can; replies in the thread can if you turn on *Let replies look
things up*. Every lookup is listed above the reply it went into.

The model picker lists versions by name (`claude-opus-5-5`, `claude-opus-5`, …);
the default, `opus`, is whatever newest Opus your installed Claude Code supports,
and each reply records which model actually answered. A newer model can need a
newer Claude Code — if a reply says so, run `claude update`; the bridge picks up
the new version without a restart.

It costs nothing per token, but every request counts toward your subscription's
usage window, which is shared with the rest of your Claude Code use; the
composer shows how much of it is spent. Claude Code also adds context of its
own to each request — including your own `~/.claude/CLAUDE.md` instructions, if
you have them — and the inspector says so on every reply that came through it.

**Before sharing the bridge with others**, read decision P-26 in
`docs/decisions.md`: Anthropic's terms restrict third-party apps that let people
use their Claude subscriptions, and distributing this needs Anthropic's approval.

### Use the bridge from other services and chat shells

The bridge also speaks the Anthropic Messages API, so your other services and
chat shells — anything built on an Anthropic SDK, curl, a script — can run on
the same subscription. Point the client at `http://127.0.0.1:8788` with the key from
`~/.toondao/api-key` (created on the bridge's first start):

```bash
curl http://127.0.0.1:8788/v1/messages \
  -H "content-type: application/json" -H "x-api-key: $(cat ~/.toondao/api-key)" \
  -d '{"model": "opus", "max_tokens": 4096, "messages": [{"role": "user", "content": "Hello"}]}'
```

`npm run chat` is such a shell, in the terminal. What the bridge honours —
streaming, images and PDFs, effort, stop sequences, structured output, web
lookups, reading a project snapshot — what it ignores, and what it refuses is in
[`docs/bridge-api.md`](docs/bridge-api.md), which opens with a five-minute guide
for wiring up a service; the running bridge serves the same document at
`http://127.0.0.1:8788/docs`. It is for your own services on your own machine;
the same P-26 caution applies.

### Learn from a project (in progress)

ToonDao can start a study conversation from a project you built with Claude Code:

1. **Settings → Projects → Add a project…** opens your system's folder dialog
   (macOS, with the bridge running). ToonDao gathers what the project holds about
   how it was built — your Claude Code sessions (your prompts, the errors you
   hit), Claude Code's memory for it, its git history and notes — and keeps a
   dated snapshot under `~/.toondao/projects/`, with a copy of the project's own
   files. **Snapshot again** adds a new one; earlier ones are kept.
2. **Start learning** opens a conversation that reads that snapshot (with the
   Claude Code provider) and begins with a study map: five to ten modules, each
   anchored in something that actually happened in the project, with questions to
   work through one at a time. The conversation stays on the snapshot it started
   from.

The model reads only the snapshot — never the live folder, whatever git ignores,
or credential files — and every file it opens is listed above the reply, like a
lookup. Off macOS, add a project from a terminal with
`npm run harvest -- "<project folder>" --snapshot`.

## Tests

```bash
npm test
```

`test/acceptance.test.ts` is the spec's §9 checklist, asserted against the
payloads `assembleContext()` actually produces; anchor integrity is proven
against real DOM ranges in `test/anchor.dom.test.tsx`.

## Where things are

| Path | What it is |
|---|---|
| `src/types.ts` | The data model. Lineage (`parentId`, `origin`) and context (`contextPolicy`) are separate fields. |
| `src/lib/assembleContext.ts` | The only place a prompt is built. |
| `src/lib/draft.ts` | The only place a gesture becomes a policy. |
| `src/lib/outline.ts` | What a turn and a spine are; the sidebar outline. |
| `src/store/focusNode.ts` | The only place that decides whether a node is shown in the thread or an aside. |
| `src/lib/later.ts` | The Later list. |
| `src/lib/anchor.ts` | Selections in the rendered DOM ↔ offsets in the raw markdown. |
| `src/lib/templates.ts` | Every prompt text the app injects. User-editable in Settings. |
| `src/lib/transfer.ts` | Export and import, with full fidelity. |
| `src/providers/` | OpenAI-compatible, Anthropic and Claude Code adapters behind one interface. |
| `bridge/claude-code.ts` | The local bridge that runs your own Claude Code as a provider. |
| `bridge/messages-api.ts` | The bridge's Messages API, for chat shells other than ToonDao (`docs/bridge-api.md`). |
| `bridge/api-key.ts` | The bridge's own key, which the Messages API asks for. |
| `examples/terminal-chat.mjs` | A terminal chat shell over the Messages API, with no dependencies. |
| `src/lib/bridgeProtocol.ts` | The wire contract between the app and the bridge, shared by both ends. |
| `src/lib/toolScope.ts` | The only place that decides whether a message may use outside sources. |
| `bridge/harvest.ts` | What a project already holds about how it was built, gathered for the model to read first. |
| `bridge/projects.ts` | Projects to learn from: the folder dialog, and dated snapshots under `~/.toondao/projects`. |
| `CLAUDE.md` | Invariants that must keep holding. |
| `docs/decisions.md` | Why things are the way they are. |

## Security

Your API key is stored in this browser's IndexedDB. That is not secure against
anything else running in the same browser — an extension or an injected script
can read it. This is a local-first personal tool; use a key you are willing to
rotate. Exports never contain keys.

## Non-goals

No backend, accounts, sync or multiplayer. No RAG: nothing is retrieved behind
your back — the only outside reading is a web lookup or a file from a project you
added, read-only, and each one is listed with the reply it went into. No tool
that runs commands or writes files. No mobile-first layout. No automatic concept
extraction by a second model call — the click is the interface, and a background
pass would make it slow, costly and non-deterministic. The one call the app makes
on its own is a conversation's title: a few hundred tokens after the first reply,
and never over a title you typed (P-34).
