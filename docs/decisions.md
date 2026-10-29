# Decisions

One paragraph per decision: what was decided, what else was considered, and
why this one. Invariants that follow from these live in `CLAUDE.md`; what the
code does now lives in the code.

**Accepted** decisions are on `main`. **Proposed** decisions arrive with
`feature/reading-first` (which includes `feature/branch-windows`), from P-22
on with `feature/claude-code-bridge`, P-27 with `feature/aside-promise`, and
from P-28 on with `feature/learn-from-project`; they are claimed intent until
checked against the code and merged.

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
ancestry. This is the spec's own suggestion. *Superseded by P-27.*

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

**P-27 · An aside keeps its opening move's promise for as long as you talk in it
(supersedes A-3).** Every departure — Explain, Just this, Lost me here — is a
context root, as Just this already was (A-1). A later turn in an aside carries the
aside's opening prompt, rebuilt from the same template and the same carved-out
context, then the aside's own turns, and nothing from above the aside; an aside
inside an aside is carved from the aside it left. Considered: A-3, under which the
second message of an Explain aside silently carried the whole thread, and a
follow-up after a crop carried the tail the crop had discarded. An aside exists to
leave a conversation with just enough of it: the whole thread blurs the model's
focus and the reader's alike. What an aside teaches goes back to the thread by
To thread (P-12).

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

### Claude Code bridge

**P-22 · Run the user's own Claude Code behind a local bridge that poses as a
provider.** A small local server takes the app's ordinary OpenAI-style request,
runs `claude -p` as the user's own signed-in process, and streams the answer
back in the same shape, so the app changes by one adapter. Considered: using the
subscription's OAuth token directly (exactly what Anthropic prohibits, and a
credential the app would then hold), and embedding the Agent SDK (the same
authentication rules, plus a heavy dependency). The official, unmodified binary
with the user's own login is the use Claude Code documents for scripts.

**P-23 · Every request is a fresh, stateless run.** A new `claude -p` in one
empty working folder, the same for every request, no session saved, the payload
sent whole as one stream-json message with one block per turn. Considered:
mapping each spine to a Claude Code session and resuming it, which would reuse
the prompt cache but make Claude Code's session file a second history to keep in
sync — and a second author of the prompt besides `assembleContext()`. Stateless
runs can still share the cache, because the prefix is byte-identical between
requests: one block per turn, and nothing per-run in the context Claude Code
builds ahead of ToonDao's prompt. Measured: with a fresh folder per run, which
Claude Code writes into that context, no request read anything from the cache;
with one folder, the next turn of a 10k-token thread read all of it back and
wrote 55 new tokens. Stream-json input is also the only way to send an image.

**P-24 · Tools follow the policy, and research means lookup only.** Explain may
use web search and fetch, Just this and Lost me here get no tools at all, and
ordinary replies follow one setting (`toolScopeFor()`), because an outside source
is context too. Considered: Claude Code's default tool set (thirty tools, about
21 times the input per request, including tools that run commands and write
files), and `--restricted` (safe, but it drops the account's claude.ai
connectors). ToolSearch is not shown to the reader: it only loads another tool.
Inside an aside, every turn follows the move that opened it (P-27): an Explain
aside can keep looking things up; a Just this or Lost me here aside never can,
whatever the setting, which now decides the thread alone.

**P-25 · Show the usage window, and record usage on every reply.** The window is
shared with everything else the account does, so a long reading session can lock
the same account out of Claude Code; the composer shows how much is spent, and
the inspector says what Claude Code added that the record cannot show.

**P-26 · Sharing the bridge needs Anthropic's approval.** Anthropic's Agent SDK
documentation says: "Unless previously approved, Anthropic does not allow third
party developers to offer claude.ai login or rate limits for their products".
Someone running the bridge with their own login is using Claude Code as
documented; publishing it so that others use their subscriptions through it
makes its author that third-party developer, whether or not money is involved.
Considered: sharing anyway because each user signs in to the unmodified binary
themselves, which the terms do allow — but the SDK note is explicit, and the
risk would land on other people's accounts. Ask first.

### Learning from a project

**P-28 · A project is learned from a harvest that code gathers.** A study
conversation about a project starts from one page, built by `bridge/harvest.ts`
— a port of the learn-project skill's `harvest.py` — from the project's Claude
Code sessions (the person's prompts, the errors they hit, compaction summaries,
each turn's last answer), its git history, its notes and its file list, within a
token budget that keeps prompts and errors first. Every source is optional and
the page says which were found: of the nine projects on this machine built with
Claude Code, all had sessions, six had git history and three had decision
records, so nothing may assume ADRs. Considered: letting the model read the
folder (osmo dock holds about 1.35M tokens of text, most of it third-party
repositories; study about 200k), and calling the skill's script from the bridge,
which would tie ToonDao to one person's `~/.claude/skills`. Code reads
everything for free; the model reads a page sized for one sitting and opens files
when it needs them. The skill stays the reference for the method, so a change to
one is made in both. Where the port departs from it: a prompt typed while Claude
was busy (a `queued_command` attachment) is kept; a failed command's error keeps
the line naming the failure, not only "Exit code 1"; and redaction never takes
Chinese text for a password's value, because prose about passwords is what a
project like osmo dock is there to teach. The harvest also reads Claude Code's
own memory for the project — the `memory/` folder beside its transcripts, whose
notes are lessons already written down — and matches a session by the folder's
given path as well as its resolved one, since a session records whichever it
ran in. *Amended by P-30: `harvest.py` has since taken up the three departures
above.*

**P-29 · A project is added by picking its folder in the system's dialog, and
kept as dated snapshots.** "Add a project…" in Settings asks the bridge to open
macOS's own folder dialog (`osascript`, `choose folder`). The folder the person
picks is harvested and frozen under `~/.toondao/projects/<slug>/<snapshot id>/`
— `harvest.md`, every session in full, the transcripts copied through
`redact()`, and a manifest with the git commit — and `project.json` lists the
snapshots, oldest first. A snapshot is never overwritten, so a clean "just
imported" start can always be returned to, and every file is owner-only.
Considered: the browser's folder picker, which never reveals a folder's absolute
path, and the model will need it to read the project; typing a path into the
app, which would have a web request name a folder for the bridge to act on; and
a terminal command alone, which works anywhere but is not one step in the app —
it stays, as `npm run harvest -- "<folder>" --snapshot`, the way to add a
project off macOS. With the dialog, a folder is chosen only by the person's own
click, so no page that got past the bridge's guards could point it anywhere;
after that a project is named by its slug.

**P-30 · The skill took up the port's departures, and both drop a subagent's
report (amends P-28).** On 2026-10-07 the learn-project skill's `harvest.py`
took up the three departures P-28 lists: a prompt typed while Claude was
busy is kept, a failed command's error keeps the line naming the failure, and
redaction never takes Chinese text for a password's value. In those the port
no longer departs from the skill. The skill also went one step further, and
the port follows: a `queued_command` attachment marked `isMeta` is dropped.
Such an attachment is a background subagent handing back its final report
(`origin.kind` "peer", the prompt opening with `<agent-message from="…">` and
"[Subagent hand-back]"). Kept, each one read as something the person asked
and split the turn it arrived in. On this machine they were 3 of 73 queued
commands, beside 63 task notifications the noise prefixes already drop and 7
prompts the person typed. The test is the harness's own `isMeta` mark, as for
user records, rather than the report's wording.

**P-31 · A model reads a project only through a snapshot.** A run that may read
a project starts in the snapshot's `read/` folder — the harvest, every session
in full, and a copy of the project's own files: what git tracks or would track,
minus credential files by name, files over 1 MB, and anything past 5,000 files
or 64 MB — with only Read, Grep and Glob, and `--permission-mode dontAsk`.
Claude Code reads inside its working directory without asking and asks before
reading anywhere else; dontAsk refuses every such ask, so nothing else on the
machine can be read. The transcripts stay beside `read/`, never in it. A request
names the snapshot by slug and id; the bridge finds the folder in its registry
and refuses one it does not hold. Considered: letting the model read the live
project folder — always current, but it holds what git ignores (osmo dock's
`traces/` carries Wi-Fi passphrases), and it changes under a conversation that
has already drawn its map; and adding the snapshot with `--add-dir` to an empty
working directory — as confined, but the model would have to be told where the
folder is, while its working directory is already in the context Claude Code
gives it. Built while Claude Code was signed out, so the refusal outside the
snapshot is documented behaviour, not yet observed.

**P-32 · A learning conversation is an ordinary conversation, pinned to a
snapshot.** "Start learning" on a project opens a conversation pinned to the
project's latest snapshot, whose first message is the `learning_map` template:
the learn-project skill's method — five to ten modules, each anchored in an
incident, a decision or a place in the code, with a recall, a mechanism and a
transfer question — kept general, so nothing assumes decision records and the
language follows the reader. The map is the first reply, so every turn of the
thread carries it, and every later turn reads the snapshot it was drawn from,
even after a new one is taken. Tools follow the moves: the thread may read the
snapshot (and the web if the reader allows it), Explain may use both, Just this
and Lost me here neither. Considered: a brief kept beside the conversation,
written in the original Claude Code session — more steps for the person, and out
of reach of the reading moves; and reading the newest snapshot on every turn,
which would let a turn read files the map never saw. It needs the Claude Code
provider, and the button says so when another is chosen.

**P-33 · A person's own Claude Code instructions come along, and the inspector
says so.** Claude Code adds `~/.claude/CLAUDE.md` — the person's standing
instructions — to every request the bridge makes, as it does in their own
sessions; it surfaced when the first learning map came back in English and said
so, citing them. Kept: they are the person's own words (the language they want
answers in, for one), and they do not change between requests, so the cache
holds. Considered: `--setting-sources` without `user`, which would drop their
other settings too; and copying the instructions into ToonDao's system prompt, a
second copy to keep in sync. The inspector now names them among what Claude Code
adds, and the learning-map template defers to them on language instead of
overriding them.

**P-34 · A conversation is named by the model, in one small request, and a
title the person typed is never replaced.** After a conversation's first reply
finishes, and whenever the person presses ↻ beside its title, one request goes
to the same provider and model: the `title` template filled by
`assembleTitle()` with the person's messages on the thread (the first and the
latest four, 240 characters each) and the first 400 characters of the latest
reply, with no system prompt, no pacing and a 40-token cap — about 250 tokens
in, plus what Claude Code adds when it goes through the bridge. A title the
person typed is marked `titleSource: "set"` and is never replaced
automatically; ↻ acts on the open conversation only, and only when pressed.
Considered: the first words of the first message (what it was, and what the
person asked to replace), asking the answer itself to carry a title line
(it would cost nothing extra, but the reply on screen would carry a line meant
for the app, and pacing asks for an answer that ends in a question), and
renaming as the conversation drifts (a request the person did not ask for, on
every few turns). This is the one model call the app makes on its own, and it
is not concept extraction: it reads what the thread already says and never
enters a payload.

**P-35 · Deleting a conversation asks first.** The ✕ sits beside the row that
opens a conversation, and a delete takes every message and aside with it, with
no undo. A dialog names the conversation and says so; Cancel has the focus, so
Enter, Esc and a click outside all keep it. Considered: an undo toast, which
needs deletes to be deferred or reversible in the database — more than a
question that costs one click.

**P-36 · Thinking effort is chosen per branch, like the model.** Claude Code's
`--effort` levels (low, medium, high, xhigh, max — what its desktop app offers)
are picked beside the model in the composer when the provider is the bridge.
The choice is recorded on the question and found by walking up the lineage
(`branchEffort()`), so it holds from there down the branch, asides included,
until a later question chooses another; each reply records the level it was
written with. A request may carry only one of the five names: the bridge drops
anything else, and `argsFor()` checks again before it becomes a flag.
Considered: one level per conversation, and one for the whole app — a branch is
where a person decides a question deserves more thought. Measured through the
bridge on a 14k-token thread: switching the level between turns keeps the
prompt cache (Opus and Haiku read 14,223 and 14,222 tokens back after a switch,
as after a turn at the same level). Separately, Sonnet 5 read nothing back at
all, at any level or none — every turn written in full; not yet explained.

**P-37 · Pace answers belongs to a conversation, and a branch can switch it.**
A new conversation takes Pace answers from Settings when it is created, and
keeps that value if Settings changes later. "pace" under the message box
switches it for one question and everything below it, asides included, found by
walking the lineage (`branchPacing()`) the way a model or an effort is. Asides
inherit the thread's value and can switch it for themselves, because a simple
side question does not need a paced lesson. Considered: one switch per
conversation with asides always following it — simpler, but the person asked to
switch it in a branch. Pacing sits in the system message, so a turn that
switches it starts a new prompt-cache prefix; turns after it reuse that one.
