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
| (inside an aside) | take it back — **To thread** | what you learned is quoted into the thread |

One more, on the model's side: with **Pace answers** on (the default), the model
is asked for one idea at a time, stopping at a checkpoint with a question.

The thread is always one linear conversation. Asides open beside it, never in
it, and nest — an aside can have asides of its own, with a breadcrumb home.
Every aside is also a row in the sidebar, nested under what it left.

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

Press `?` in the app for keyboard shortcuts.

### Use a Claude subscription instead of an API key

If you have Claude Code — through a school's or company's Claude seat, say —
ToonDao can run on your own subscription:

1. Install Claude Code and sign in once: run `claude`.
2. In a second terminal: `npm run bridge` (Node 22.18 or newer).
3. In ToonDao: **Settings → Provider → Active → "Claude Code (local bridge)"**.
   Its status — running, signed in — is shown right there.

Each message starts your own `claude -p` in an empty temporary folder, with
Claude Code's coding prompt replaced by ToonDao's, nothing saved to your Claude
Code history, and no tools unless the message's move allows them: **Explain**
may search and read the web, **Just this** and **Lost me here** never can, and
ordinary replies can if you turn on *Let replies look things up*. Every lookup is
listed above the reply it went into.

It costs nothing per token, but every request counts toward your subscription's
usage window, which is shared with the rest of your Claude Code use; the
composer shows how much of it is spent. Claude Code also adds a few hundred
tokens of its own context to each request, and the inspector says so on every
reply that came through it.

**Before sharing the bridge with others**, read decision P-26 in
`docs/decisions.md`: Anthropic's terms restrict third-party apps that let people
use their Claude subscriptions, and distributing this needs Anthropic's approval.

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
| `src/lib/bridgeProtocol.ts` | The wire contract between the app and the bridge, shared by both ends. |
| `src/lib/toolScope.ts` | The only place that decides whether a message may use outside sources. |
| `CLAUDE.md` | Invariants that must keep holding. |
| `docs/decisions.md` | Why things are the way they are. |

## Security

Your API key is stored in this browser's IndexedDB. That is not secure against
anything else running in the same browser — an extension or an injected script
can read it. This is a local-first personal tool; use a key you are willing to
rotate. Exports never contain keys.

## Non-goals

No backend, accounts, sync or multiplayer. No RAG or document ingestion. No
agentic tool use. No mobile-first layout. No automatic concept extraction by a
second model call — the click is the interface, and a background pass would make
it slow, costly and non-deterministic.
