# Decisions

One paragraph per decision: what was decided, what else was considered, and
why this one. Invariants that follow from these live in `CLAUDE.md`; what the
code does now lives in the code.

**Accepted** decisions are on `main`. **Proposed** decisions arrive with
`feature/reading-first` (which includes `feature/branch-windows`) and are
claimed intent until checked against the code and merged.

---

## Accepted

### Context assembly

**A-1 · Isolated nodes are context roots.** A `full-ancestry` walk stops at, and
includes, a node whose own policy is `isolated`. The spec says a windowed node's
follow-ups return to full ancestry and is silent on isolated ones; applying the
same rule would mean that one turn after "answer about only this sentence", the
model silently receives the whole ancestry the user just excluded. Lineage
continues above the node; context stops there.

**A-2 · `windowed`, `truncated` and `isolated` assemble to exactly one user
message.** Their templates inline the context as prose, so sending the turns as
real messages too would duplicate every token. The count shown is the true
count — one — rather than a friendlier number.

**A-3 · A windowed node's follow-ups do not inherit the window (§11 Q1).** The
window governs the first prompt only; after that the branch has ordinary
ancestry. This is the spec's own suggestion.

**A-4 · `assembledPreview` is historical (§11 Q4).** It is recorded before the
request goes out and never recomputed, so the inspector shows what was actually
sent even after a template is edited. Editing a template changes future nodes
only.

**A-5 · Token counts are `chars / 4`, always shown with `~` (§11 Q3).** An exact
per-provider tokenizer is a large download that buys nothing here: the inspector
exists to show *which* messages were sent, not to bill for them.

**A-6 · `assembleContext()` takes an optional fourth argument.** The spec's
signature is `(node, store, templates)`; the system prompt and pacing come from
settings, and a module-level variable would break purity, so they arrive as
`opts`. Still pure and deterministic.

**A-7 · A quote is a `>` blockquote, not a fenced block.** §3 and §4 disagree;
§4 defines the templates, and a blockquote is what the borrowed gesture looks
like.

### Anchors and rendering

**A-8 · A crop is anchored to a point.** The anchor is zero-length at the cut, so
`anchor.text === content.slice(start, end)` stays true, and the discarded tail
stays recoverable from the source node, which is never mutated. Copying the tail
into the anchor would only make a second, staler copy.

**A-9 · Gesture nodes store a human-readable `content`.** The transcript has to
show something, and a re-rendered template in place of a message is unreadable.
Where a template has no slot for the user's words, a typed note is appended as a
paragraph rather than dropped.

**A-10 · Markdown is rendered mdast → React directly**, not via rehype as §7
suggests. mdast carries the same positions with one fewer lossy hop, and it lets
`anchor.ts` annotate leaf indices during its walk and the renderer read them
back; re-deriving them in a second walk would let any disagreement silently
shift every anchor in a message.

**A-11 · A click on a link does not open the toolbar.** A toolbar over a link
makes rendered links unusable, and ordinary use must stay ordinary.

### Data

**A-12 · An export never contains an API key.** Export files end up in shared
folders and bug reports. Base URLs and model names do travel, so an import is
one key away from working.

**A-13 · An id collision remaps the whole import.** Remapping only the colliding
ids would silently re-parent nodes onto the wrong tree. When anything collides,
every id gets a fresh one together and the shape is preserved.

**A-14 · A per-branch model override is stored on the user node** and found by
walking up the lineage. That is what makes it per-branch: a branch made below the
switch keeps the model, one made above it does not.

### Interaction

**A-15 · Retries are variants of one turn (§11 Q2)**, switched in place with
`‹ ›`, not separate thoughts.

**A-16 · Shortcuts use ⌘⇧.** The unshifted combinations belong to the browser (⌘T
opens a tab); a shortcut that has to fight the browser is not a shortcut.

---

## Proposed

### What the product is

**P-1 · The product is the reading moves, not the graph.** The two-graph model
(lineage ≠ context) is the mechanism, and it stays exactly as it was. What
changes is what the product puts in front of the reader: the moments that make
an AI answer hard to read — an unknown term, losing the thread, wanting to answer
one sentence, wanting a passage on its own — each get one named move, and every
surface that showed *structure* instead (a tree canvas, a window manager, a
payload count on every message) is removed or put behind a click. Considered:
keeping every structural view and adding the moves on top; rejected because each
view spends the reader's attention on the data model instead of on the text,
which is the one cost this product exists to reduce.

### Structure

**P-2 · A pane shows one spine.** A spine is turns joined by `continuation` or
`quote-reply`; a lens, a crop or an isolation departs and becomes a spine of its
own. A quote reply stays in the pane it was made in, because replying to a
passage is the conversation carrying on (§5.4). The thread shows the root spine
and nothing else; an aside shows one departure. Considered: rendering the full lineage path in the thread (what the
app did before), which spliced any branch you navigated into onto the end of the
thread with nothing marking the seam. The rule is the user's own: a window is a
linear conversation.

**P-3 · Navigation goes through `focusNode()`.** Sidebar rows, fork marks,
variant switches, the Later list and shortcuts all ask it where a node belongs,
and it either moves the thread's cursor or opens the aside chain that owns the
node. Considered: letting each caller move the cursor, which is how branches
leaked into the thread; one router is the only way the invariant holds by
construction.

**P-4 · The outline has one row per spine, and the oldest continuation holds the
line.** Where a turn has two children that could each continue it, a stable
index needs one answer that does not change as you navigate. Considered: giving
the line to the one you are reading (what the tree canvas did), which reorders
rows under the pointer. Retries never get a row.

**P-5 · A branch is named after the passage it came from.** The passage is what
the reader pointed at, so it is the most recognisable thing about a branch; the
typed ask is often empty by design. A crop has no passage and falls back to its
ask. One function (`branchLabel`) names the sidebar row, the aside's title and
the mark in the transcript, so one branch never has three names.

**P-6 · Remove the tree canvas.** It drew the conversation's shape across the
reading column at watermark strength and took three design passes (record:
`docs/decisions/tree-shape.md` at `ea0ce30`). Considered: keeping it behind a
toggle. Removed because it answered "what shape is this thinking", which the
reader rarely asks mid-answer, at the cost of drawing over the text they are
reading; the outline answers "where are my side questions" and the fork marks
answer "where did one leave from".

### Asides

**P-7 · A departure opens beside the thread, not in front of it.** The aside pane
is a docked column. Considered: floating in-app windows (the previous pass,
`feature/branch-windows`) and browser popups. Windows cover the passage they are
about and have to be dragged, resized and stacked — managing them is exactly the
overhead the reader should not pay; popups lose the shared store and database. A
margin sits next to the text, so the question and its passage are read side by
side. Below 1100px the pane overlays the thread rather than squeezing it.

**P-8 · One aside at a time, with a breadcrumb.** A question raised inside an
aside opens a deeper one in the same pane; the frames above it become a
breadcrumb, and Esc backs out one level. Considered: several open panes side by
side. One at a time keeps a single side question in focus, and the outline lists
all of them anyway.

**P-9 · Each pane owns its gesture, its leaf and its retries.** A quote docked
in an aside goes to that aside's composer; a retry inside an aside moves that
aside's leaf; a send from an aside is `detached` and never moves the thread's
cursor. Everything else — the nodes, the templates, the model — is shared.
Considered: one global pending gesture and one cursor, which is what made a
branch opened in one pane change another.

**P-10 · A crop stays an aside.** Considered: treating "lost me here" as a rewind
of the thread — the reply after the cut *becomes* the conversation, the way
"wait, back up" works when talking. Kept as an aside because the user asked for
it, and because in reading the original answer remains the text you return to:
you get help past the hard part on the side, then keep reading. Worth revisiting.

**P-11 · The carried payload is shown before the first send.** It opens directly
above the aside's composer and collapses once there is a reply to read. Before
the first send it is the only moment knowing what will be carried can still
change what you type.

**P-12 · "To thread" is a quote reply.** Inside an aside the toolbar can quote a
passage into the thread's composer, so a side conversation ends the way one does
between people — you come back with what you learned. Considered: a new "bring
back" gesture with its own policy. Rejected: carrying a passage into a
conversation is what a quote already is.

### Reading moves

**P-13 · The toolbar is Explain, Later, Reply, Just this** — named for what a
reader does, in one row, with Explain and Later side by side because they answer
the same question. Considered: the spec's vocabulary ("Ask about only this",
"Explain in context"), which describes the mechanism rather than the intent.

**P-14 · Remove "Compare with…" and "New line from here".** The first was the
lens with seeded text. The second began on `main` as "Branch from here", which
moved the thread's cursor back to an earlier message — impossible once the
cursor is spine-bound — and became a `fork` gesture that opened an ordinary
question in a window of its own. Neither is a reading move, and each cost a
choice every time the toolbar appeared. Existing data holding such a branch is
still named and navigable.

**P-15 · Later: park a passage instead of chasing it.** An unfamiliar term
creates false urgency to drill into it mid-read; the lens alone only offered
"drill in now". Later is the other half of the triage — marked in place, listed
in the sidebar, explained when you are ready. Considered: a global bookmarks
list, and doing nothing (a note-taking app's job). Per conversation, because a
parked term only makes sense next to the answer it came from.

**P-16 · Later is stored on the conversation record.** `Conversation.later` is an
optional field, so there is no Dexie version bump and an older build opening the
same database ignores it. Considered: a new table, which needs a version bump
that makes the database unopenable by `main` afterwards.

**P-17 · Asking about a parked passage clears it.** Any gesture sent on exactly
that passage takes it off the list; opening it and closing it again does not.
The list is what is still owed, so it has to drain, or it becomes a graveyard.

**P-18 · The `‹ ›` switcher offers only replies to the same question.** It used
to offer every sibling, which on a user node meant separate conversations
presented as versions of one message.

### Quiet

**P-19 · Show the payload only where it differs from the page.** In the thread,
what is sent is exactly the conversation on screen, so the per-message chip is
gone; messages sent with anything else say so in words above their text, and
every message has a "context" action for the exact payload. The composer shows
the chip only in an aside or with a quote pending. Considered: keeping the chip
everywhere, as §1 frames the inspector — rejected because a number on every
message is paid for on every message and is almost never news.

**P-20 · Pace answers, on by default.** A standing instruction asks the model for
one idea at a time, fitting on one screen, stopping at a checkpoint with one
real question. Every other move repairs an answer after the fact; this one asks
for an answer the reader can hold. On by default and merged into existing
settings, so it works without anyone finding it; one checkbox turns it off.

**P-21 · Pacing is a template.** The wording is the editable `pacing` template,
appended after the user's own system prompt. Considered: a hardcoded string,
which would break the rule that every injected prompt text is user-editable.
