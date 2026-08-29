# ToonDao

A local-first, BYOK chat client built on one idea: **a conversation's tree
structure and a conversation's context assembly are two different graphs**, and
every shipping chat product collapses them into one.

In every other client, what gets sent to the model is mechanically
`path from root to current node` — always, invisibly, with no way to change it.
Here, context assembly is a per-node, user-inspectable policy object that is
decoupled from tree position.

```bash
npm install
npm run dev
```

No backend, no auth, no accounts. Everything lives in IndexedDB in your browser.
Add a provider base URL and key in Settings and you are running.

### Hosted providers

Three presets ship configured: **OpenAI-compatible**, **Anthropic** (native
`/v1/messages`), and **OpenRouter**, which is the quickest way to reach many
vendors through one key — it speaks the OpenAI wire format and returns
`access-control-allow-origin: *`, so the browser talks to it directly with no
proxy. Its model ids are vendor-namespaced (`anthropic/claude-haiku-4.5`), and
the preset defaults to Haiku.

Pick a provider under **Settings → Provider → Active**, paste your key into that
provider's own **API key** field, and adjust **Model** if you want a different
one. Base URL is editable for every provider, so any relay (中转) endpoint works
too.

Model ids go stale as vendors retire them. To check the OpenRouter preset
against the live catalogue:

```bash
npm run check:models
```

### Trying it without a key

```bash
npm run dev:mock
```

Starts a tiny OpenAI-compatible SSE server on `localhost:8787`. Then in the app:
**Settings → Provider → Active → "Mock server (dev, no key)"**. That preset is
already pointed at `http://localhost:8787/v1`, so there is nothing to edit and
no key to enter — streaming, all four gestures and the tree all work.

It speaks the real wire format,
so it exercises the actual adapter rather than a mock inside the app, and it
appends every request body to `dev/requests.jsonl`. That log is how the
acceptance scenarios in this repo were checked: you can read it to confirm that
the payload the context inspector claims is the payload that actually went out.

---

## The two graphs

**Graph A — Lineage.** `parentId` / `childrenIds` / `origin`. "This thought came
out of that thought." One parent per node. This is what the transcript and the
tree draw. It records provenance of inquiry.

**Graph B — Context.** `contextPolicy`, resolved by `assembleContext()`. "These
messages were in the prompt when this node was generated." Derived per node.

**A child in Graph A may inherit nothing in Graph B.** That is not a bug to be
smoothed over; it is the product. A node that says "explain only this phrase,
ignore everything else" is structurally a child — it was born at that moment and
belongs at that place in the tree — and contextually a fresh start.

Because context is no longer "obviously everything above", the user cannot infer
it, so every node and the composer carry a chip like
`4 messages · ~1,240 tok · windowed` that expands into the exact payload. If the
user cannot see what the model sees, the premise collapses.

---

## Where things are

| Path | What it is |
|---|---|
| `src/types.ts` | The data model. Source of truth. Graph A and Graph B are separate fields and nothing conflates them. |
| `src/lib/assembleContext.ts` | **The only place a prompt is ever constructed.** All five policies, one switch. |
| `src/lib/anchor.ts` | DOM selection → raw-markdown offsets. The hard problem, solved in isolation. |
| `src/lib/draft.ts` | **The only place a `ContextPolicy` is constructed for a new node.** Gesture → policy, one mapping. |
| `src/components/Markdown.tsx` | Block-anchored renderer. Emits the `data-src-*` attributes `anchor.ts` reads back. |
| `src/lib/templates.ts` | Seed templates. User-editable, stored in IndexedDB, never read from a call site. |
| `src/lib/treeLayout.ts` | Turn grouping, trunk/branch classification and the trunk layout. Pure, no layout library. |
| `src/lib/transfer.ts` | JSON export/import with full tree fidelity. |
| `src/providers/` | One `Provider` interface; OpenAI-compatible and native Anthropic adapters behind it. |
| `test/` | 180 tests. Acceptance scenarios from §9 are asserted against assembled payloads, not vibes. |

Two invariants worth preserving, both checkable with grep:

- **`assembleContext()` is the sole constructor of prompts.** No component builds
  a message array.
  ```bash
  grep -rnE "ChatMessage\[\]|role: \"(user|assistant|system)\"" src
  ```
  Every surviving hit should be one of: `assembleContext.ts` itself; a provider
  adapter reshaping an already-assembled array for its vendor's wire format; a
  type annotation; or `parsePayload()`, which renders a *stored* preview in the
  inspector and is display-only.

- **`planSubmission()` in `draft.ts` is the sole constructor of policies for new
  nodes.** The composer, the selection toolbar and the concept popover all route
  through it, so they cannot drift into inventing policies of their own.
  ```bash
  grep -rnE "kind: \"(full-ancestry|windowed|truncated|isolated|quoted)\"" src
  ```
  Hits outside `draft.ts` should only be `transfer.ts`, which *deserializes*
  policies from an export file rather than choosing them.

## Running the tests

```bash
npm test
```

`test/acceptance.test.ts` is the §9 checklist, one `describe` per scenario, each
asserted against the payload `assembleContext()` actually produces. Scenario 5
(anchor integrity) lives in `test/anchor.dom.test.tsx`, where it is driven
through real DOM Ranges over the real renderer.

---

## Decisions

### Answers to the spec's open questions (§11)

**1. Does a `windowed` node's own follow-up inherit the window?**
No — the branch keeps its own subtree ancestry from the branch point down. The
window governs the initial prompt only. This is the spec's own suggestion and it
is what the code does. Tested in `assembleContext.test.ts` ("§11 Q1").

**2. Are `regenerate` siblings full nodes or a collapsed variant stack?**
A collapsed stack with a `2/3` switcher — they are not different thoughts. The
transcript shows the switcher on any node with siblings; the tree collapses
retry siblings onto one glyph rather than fanning them out.

**3. Token counting: exact tokenizer or heuristic?**
`chars/4`, always labelled with a `~`. An exact per-provider tokenizer costs a
large WASM download and buys nothing: the inspector's job is to show *which
messages* are in the payload, not to bill for them. `src/lib/tokens.ts`.

**4. Do existing nodes re-render their `assembledPreview` when a template is
edited?**
No. The preview is a historical record of what was actually sent. The inspector
labels it `as sent` and prefers it over a fresh assembly whenever it exists.
Editing a template changes future nodes only.

### Decisions the spec did not ask for

**Isolated nodes are context roots.** `full-ancestry` walks stop at — and
include — a node whose own policy is `isolated`. The spec is explicit that a
windowed node's follow-ups return to full ancestry, and silent about isolated
ones. Applying the same rule there would mean that one turn after asking "answer
about only this sentence", the model silently receives the entire ancestry the
user just excluded, which makes §5.3 a lie. So an isolated node terminates the
Graph B walk while leaving its `parentId` untouched: lineage continues above it
in Graph A and stops there in Graph B. This is the §1 thesis applied to its own
consequences. Tested under `isolated (§5.3) > acts as a context root`.

**`windowed`, `truncated` and `isolated` each assemble to exactly one user
message.** Their templates inline the context as prose via `{{context_turns}}`
and `{{truncated_context}}`, so sending the turns *also* as real messages would
duplicate every token. The context chip reports the true count — `1 message` —
rather than a friendlier number, with the inlined turn count beside it. An
honest 1 is worth more than a comfortable 4.

**The tree lays out one dot per *turn*, not one per message.** A user→assistant
edge is always a `continuation` and always present, so drawing it doubles the
depth of the tree while carrying no information. Collapsing the pair onto one
dot means every edge that survives is a *decision* — a continuation, a lens, a
crop, an isolation, a quote — which is what §6 asks the edge typography to
carry. It also answers §11 Q2 for free: retries are replies to the same user
node, so they collapse into a ring around one dot rather than fanning out as
separate thoughts. The dot is split into two bands, user above and assistant
below, so an edge anchored to a character offset inside a reply leaves the rim
at the height that offset corresponds to.

**Two of the six origin kinds are the trunk; the other four branch.** Replying
to what the model said (`continuation`) and quoting a passage of it
(`quote-reply`) *are* the conversation carrying on, so they run straight down a
single vertical spine. A lens, a crop or an isolation is a departure from that
line, so it leaves sideways on an arc and becomes a spine of its own —
continuations extend it, a further gesture forks off it again, one column
further out. Branches on branches, all the way down. The result is that a glance
answers "where is the thread, and what came off it" with no labels at all: depth
reads vertically (`y` is exactly `depth * ROW_GAP`, so equal turns line up
across every branch) and departure reads horizontally.

**Where a turn has two continuations, the trunk goes to the one you are
reading.** Only one child can occupy the line, and the alternative — handing it
to whichever was sent first — would leave you on a branch while reading the
thread. The trunk is the thread you are actually in; the sibling keeps its
continuation styling and hangs off as a branch.

**The tree is not a window.** A floating panel with a title bar is a second
application sitting on top of the first: chrome to look past, a thread to hide,
and a drag nobody asked for. The lineage and the conversation are one artifact,
so they share one canvas — the thread floats as a card on the left, the tree
lives on the open ground beside it, and the out-of-focus stretches drift behind
the card's margins. The stage is full-bleed and sits *under* the thread; what it
hands the canvas is a viewport, the open ground, so the tree fits and centres
itself in the part you can actually see while staying free to bleed past it.

**A long tree is focused, not shrunk.** Fitting a 40-turn conversation into a
400px canvas puts it at 30% zoom, where the dots stop being distinguishable and
the map stops being a map. The resting view refuses to go below 100% and puts
the turn you are reading in the dead centre of the open canvas — which is where
the focus mask is centred too, so "sharp" and "the conversation I am looking at"
are the same place. The rest overflows, and the mask fades and blurs it out, so
the edge reads as "there is more" rather than as a crop. Hovering the canvas
dissolves the mask and eases the view out to the whole tree; leaving it puts you
back. `here` and `all` pin either end of that for good.

**Off-path collapse is measured from the active path, not from the root.** §6
asks for auto-collapse "below a depth threshold". Collapsing every off-path
branch at its first level hides the entire rest of the conversation behind one
badge; not collapsing turns a long conversation into spaghetti. Two levels of
each off-path branch stay visible and the remainder becomes a count badge, so
the map always shows where the current line of thought sits and what was tried
around it.

**A crop is anchored to a point, not a range.** `origin.anchor` for a
`structural-crop` is zero-length at the cut offset. This keeps the invariant
`anchor.text === content.slice(anchor.start, anchor.end)` true, and the
discarded tail stays recoverable from the source node — which is never mutated —
so copying it into the anchor would only create a second, staler copy.

**Gesture nodes always store a non-empty, human-readable `content`.** The
transcript has to render something, and re-rendering the full template in place
of a message would be unreadable. Where a gesture's template has no slot for the
user's own words (`structural_crop`, `isolated_selection`), a typed note is
appended as a trailing paragraph rather than silently dropped.

### Deviations from the spec

**Markdown is rendered mdast → React directly, not
`remark-rehype` → `rehype-react`.** §7 suggests the hast route. mdast carries the
same `position` data with one fewer lossy hop, and — the real reason — it lets
`anchor.ts` annotate leaf indices onto the tree during its flattening walk and
have the renderer read them back. The alternative is for the renderer to
re-derive leaf indices from a second traversal, where any disagreement between
the two walks would silently shift every anchor in the message. Reading the
annotation makes that class of bug impossible.

**`assembleContext()` takes an optional fourth argument.** The signature in §3 is
`(node, store, templates)`. The global system prompt lives in settings, and
threading it through a module-level variable would break purity, so it arrives as
`opts.systemPrompt`. Still pure, still deterministic.

**§3 says the `quoted` policy appends the quote "as a fenced block"; §4 says the
quote is rendered "as a `>` blockquote".** §4 wins — it is the section that
defines the templates, and a blockquote is what the gesture it borrows from
looks like.

---

**An export never contains an API key.** Export files get put in Dropbox and
attached to issues. Base URLs and model names do come along, so an import is one
paste away from working again.

**An id collision rewrites the whole import together, not the colliding parts.**
Partially remapping would silently re-parent nodes onto the wrong tree, which is
precisely the corruption a data-fidelity feature must not introduce. When
anything collides, every id in the bundle is given a fresh one and the tree
shape is preserved intact.

**Keyboard shortcuts are modified with Shift as well as Cmd/Ctrl.** The
unshifted combinations belong to the browser — ⌘T opens a tab, ⌘N a window. A
shortcut that has to fight the browser is not a shortcut.

**A per-branch model override is stored on the user node and inherited by
walking up the lineage.** That is what makes it per-*branch*: a branch made
under a node that switched models keeps that model, a branch made above it does
not, and everything else falls through to the provider default.

**A click on a rendered link does not open the selection toolbar.** §5.1 asks
for click-to-term on assistant messages, but a toolbar covering a link makes
rendered links unusable, and §5.5 asks that ordinary use stay ordinary.

---

## Keyboard

| | |
|---|---|
| `Enter` / `Shift+Enter` | Send / newline |
| `Esc` | Drop the pending gesture, then close whatever is open, then stop generating |
| `⌘⇧T` | Show/hide the tree |
| `⌘⇧N` | New conversation |
| `⌘⇧I` | Inspect the payload of the current message |
| `⌘⇧,` | Settings |
| `⌥↑` / `⌥↓` | Previous / next sibling branch |
| `⌥⌫` | Stop generating |
| `?` | Shortcut list |

Inside the tree canvas, arrow keys walk parent/child/sibling and `Enter`
navigates to a card.

---

## Security

Your API key is stored in this browser's IndexedDB. That is **not** secure
against anything else running in the same browser — an extension or an injected
script can read it. This is a local-first personal tool, not a hardened one. Use
a key you are willing to rotate. Settings says the same thing in one line, where
it matters.

---

## Non-goals

No 3D knowledge universe. No multiplayer, accounts, sync, or backend of any
kind. No RAG or document ingestion. No agentic tool use. No mobile-first layout —
desktop web is the target, and tablet merely is not actively broken. No automatic
concept extraction via a second model call: the click gesture is the interface,
and a background LLM pass would make it slow, expensive and non-deterministic.
