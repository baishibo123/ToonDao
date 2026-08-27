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
| `src/providers/` | One `Provider` interface; OpenAI-compatible and native Anthropic adapters behind it. |
| `test/` | 95 tests. Acceptance scenarios from §9 of the spec are asserted against assembled payloads. |

Two invariants worth preserving, both checkable with grep:

- `assembleContext()` is the sole constructor of prompts. No component builds a
  message array.
- `planSubmission()` in `draft.ts` is the sole constructor of policies for new
  nodes. The composer, the selection toolbar and the concept popover all route
  through it, so they cannot drift into inventing policies of their own.

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
