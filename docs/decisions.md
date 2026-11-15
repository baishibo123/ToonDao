# Decisions

One paragraph per decision: what was decided, what else was considered, and
why this one. Invariants that follow from these live in `CLAUDE.md`; what the
code does now lives in the code.

**Accepted** decisions are on `main`. **Proposed** decisions arrive with
`feature/reading-first` (which includes `feature/branch-windows`), from P-22
on with `feature/claude-code-bridge`, P-27 with `feature/aside-promise`,
from P-28 on with `feature/learn-from-project`, and from P-39 on with
`overnight/2026-11-02-bridge-api`; they are claimed intent until checked against
the code and merged.

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
all, at any level or none — every turn written in full. Explained since: for
Sonnet 5, Claude Code puts its environment, model, token-budget and date blocks
after the request's text instead of in the system prompt, so the prefix a turn
caches ends in them, and the next turn, whose new turns come before them, never
contains it. An identical request still hits (13,000 read). ToonDao cannot move
those blocks — `--exclude-dynamic-system-prompt-sections` is ignored with a custom
system prompt — so on Sonnet 5 every turn through the bridge is paid in full.
This is the bridge's shape, not Sonnet's: in one ordinary Claude Code session,
where each turn arrives as a message of its own, Sonnet 5 read back 12,785 and
12,889 tokens on its second and third turns. Recovering that would mean keeping
a Claude Code session per thread, the alternative P-23 turned down.

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

**P-38 · Text size is a setting with a few steps.** Settings → Display offers
Small, Default, Large and Larger (0.92×, 1×, 1.12×, 1.25×). Every pixel font size
in the stylesheets is multiplied by one variable, `--text-scale`; spacing and
layout stay as they are. Considered: CSS `zoom` on the page, which scales
everything at once but moves the coordinates the selection toolbar and
popovers are placed by; and a slider, which the person did not ask for —
a few steps are quicker to pick and to tell apart.

### The bridge as an API

**P-39 · The bridge also speaks the Anthropic Messages API, for the person's
other chat shells.** `POST /v1/messages` takes the API's request and answers with
its Message object, SSE event sequence and error envelope, so a shell built on an
official SDK works by changing its base URL and key (`docs/bridge-api.md`); a
zero-dependency terminal shell, `examples/terminal-chat.mjs`, is the reference
client. Claude Code's raw stream events already are the API's events, so the
bridge translates only the seam: the several model calls of Claude Code's tool
loop are shown as one message. Considered: publishing ToonDao's own route as the
protocol — it already serves OpenAI-shaped shells, but carries text only, one
string per message, and ToonDao's own extension; and a protocol of our own, which
every client would need an adapter for. The model is Claude, and the shape a
shell for Claude already speaks is its API. ToonDao's route is unchanged. For the
person's own shells on their own machine: P-26 applies unchanged, and more
sharply, since an API-shaped endpoint makes a subscription usable by any app that
takes a base URL.

**P-40 · A Messages API field is honoured, ignored in the open, or refused —
never faked.** Honoured: model, system, messages (text, images, documents),
stream, max_tokens, stop_sequences, output_config's effort and json_schema, and
the web_search and web_fetch server tools, which become Claude Code's own
lookups with no connectors. Ignored, and named back in a
`toondao-ignored-params` header: fields that cannot change what a correct answer
looks like — sampling settings, metadata, cache_control, a tool's max_uses.
Refused with a 400: what the run would silently fail to deliver — client tools (a
stateless `claude -p` run is not a loop in which the client runs them), forced
tool use and prefill (which current models refuse too). Two of the honoured
fields are kept by ending the run: at a `max_tokens` stop Claude Code asks the
model to resume, three times, and then fails (measured), so the bridge stops at
the first one and answers as the API would; a stop sequence is watched in the
streamed text. A schema becomes one `--json-schema=` argument, re-serialised by
the bridge, because Claude Code takes it inline only (a file path was refused);
the person kept this exception on 2026-11-02.
Considered: ignoring everything unknown silently, as compatibility layers often
do — a shell would get an answer that quietly skipped its stop sequence or its
tool; and refusing everything not honoured, which would break SDK defaults like
`temperature` that change nothing about a correct answer.

**P-41 · The Messages API asks for the bridge's own key, and leaves the person's
own Claude Code settings out unless asked.** 127.0.0.1 is reachable by every
account on the machine, and a shell sends a key anyway, so `/v1/messages`
answers only with the key in `~/.toondao/api-key` (created owner-only on the
first start) or `TOONDAO_API_KEY`; it is not a Claude credential and never
reaches Claude Code. ToonDao's own route has none yet; the pairing code planned
for the bridge's security pass is where it gets one. API runs use Claude Code's
`--safe-mode`: CLAUDE.md, hooks, skills, plugins and MCP servers off,
permission rules on, so a shell gets its system prompt and nothing else while
the person's own deny rules still hold. Measured: asked which language its
instructions name, a run answered "NONE" with 615 tokens of context, and
"Chinese" with 1,323 when the person's `~/.claude/CLAUDE.md` came along; two
identical safe-mode runs share the cache; a WebFetch deny rule (given with
`--settings`) took the tool away in safe mode. That a user-file deny rule holds
is Claude Code's documented behaviour ("permissions work normally"), not
observed: this machine's settings have none. `toondao.user_instructions: true`
brings P-33's behaviour back. Considered: P-33 for both doors — one behaviour,
but every shell would carry instructions written for Claude Code; and
`--setting-sources project,local` (the first version), which leaves the user's
settings file out entirely, deny rules with it. The person kept the default
(off) on 2026-11-02.

### Pictures

**P-42 · A reply's SVG is drawn, as an image.** Claude writes no raster images,
but it draws well in SVG. A fenced block (`svg`, `xml`, `html` or unlabelled)
whose source is one finished `<svg>…</svg>` element is shown as a picture on a
white sheet, with its source under a toggle; until the closing tag streams in
it stays code. The picture is an `<img>` from a `data:` URL, never markup put
into the page: an SVG loaded as an image runs no script and fetches nothing, so
the renderer still never injects a reply's HTML. The namespace a model often
leaves out is added (an image draws nothing without it), and a viewBox-only
drawing is sized by its viewBox rather than the 300 px default. Selecting the
picture quotes the whole block. Considered: Mermaid as well — easier diagrams,
but a large dependency; the person chose SVG only (2026-11-03).

**P-43 · A question can carry files: images, PDFs and text files, as part of
its turn.** The composer takes them from 📎, a paste (a screenshot; a paste that
also has text stays text) or a drop, at most ten per message. Each is read once,
when it is added, into what will be sent and stored on the question's node as
an optional field (no schema version): an image larger than 1568 px on its long
edge — what Claude sees at most — is shrunk, as PNG or JPEG, under the API's
5 MB; a PDF goes as it is, up to 10 MB; anything else is sent only if its bytes
are UTF-8 text, up to 400 KB. A file belongs to its turn, so it goes wherever
the turn is sent whole: every later turn of the thread re-sends it (the cache
covers the repeat), and a departure — a window, a cut, a passage — carries its
carved-out text without the files in it, though its own files go with it.
Images and PDFs reach the model as themselves: Anthropic image and document
blocks, the same blocks on Claude Code's stdin through the bridge (verified:
Haiku read a PNG's colour and a PDF's word in one run), and OpenAI's
`image_url` and `file` parts. Text files are written into the message through
the user-editable `attachment` template, fenced, before the question's words,
so they read the same on every provider and the wording stays a template; this
replaced sending them as text documents, which only Claude takes. The record of
what was sent names each file instead of copying it. The bridge admits only
base64 images of the four types the API takes and base64 PDFs
(`decodeContent()`), never a URL to fetch. An export carries the files, so it
grows with them. Considered: a separate Dexie table for files, which keeps node
records small but needs a version bump an older build cannot open.

**P-44 · Rewind asks an earlier question again, and keeps what followed it as a
fork.** ↺ on a question in the thread puts its words, files and any model,
effort or pace it set back in the box, under a band that says what will happen,
and dims that question and everything after it. Sending adds the new question
under the same reply, and the reply's `line` names it, so it holds the thread
in both statements of the spine rule (`spineChild()` and `spineNext`); without
a `line` the oldest still holds it, as P-4 says. The earlier question and its
tail stay in the tree untouched and become a nested row and a fork mark, read
and continued as an aside: nothing is deleted. A rewound quote reply keeps its
quote. Deleting the version on the line gives the line back to the oldest.
On the first question ↺ starts a new conversation instead, with the question
in its box: a first question hangs off no reply, and a second root would have
nothing to open as an aside from. The new conversation keeps the old one's pace
and the project snapshot it learns from; the old one stays whole (the person
chose this, 2026-11-03). Not offered inside an aside. Considered:
deleting the tail, as Claude Code's rewind does — simpler, but it takes the
asides and parked passages under it; and moving the line to whichever child
was read last, which P-4 rejected because rows would move as you navigate. A
rewind moves the line once, on purpose.

**P-45 · Word and PowerPoint files are converted to text when attached, in the
browser.** A .docx or .pptx becomes a Markdown text attachment (P-43's path from
there on) plus one image attachment per picture inside it. Word: paragraphs,
headings (by style name, which is the same in every language, or outline
level), numbered and bulleted lists (from numbering.xml), tables, bold and
italic, links, and what a reader sees — tracked deletions and field codes out,
insertions and field results in. PowerPoint: one section per slide in the
deck's order, the title as its heading, body placeholders as bullets by level,
free text boxes as prose, tables, pictures, and the speaker notes. A picture
stands in the text as `[image N: name]`, numbered in the order the images are
sent, because an image block carries no name; one in a format the model cannot
take (EMF, WMF, TIFF, SVG) is named as not sent, and the composer says so. A
zip of up to 30 MB is read, its text held to the text-file limit; .doc and .ppt
are refused with a hint to re-save. The zip reader is ours and inflates with the
platform's `DecompressionStream`, so there is no dependency, and the converter
is loaded with `import()` only when such a file is added. Checked against a
.docx written by macOS `textutil` as well as hand-built parts. Considered: a
tool the model calls — Claude Code's Read cannot open a .docx, and the bridge
never adds a tool that runs commands; an MCP server, local or remote — another
process to run, only on the bridge route, and a remote one sends the file to a
third party; mammoth.js — HTML-first, its Markdown output deprecated, and large.
Spreadsheets (.xlsx) are left for later: they need a sheet parser.

**P-46 · Replies are written in parallel, and each stops only itself.** The
store keeps every reply being written by id (`streams`), not one global
stream, so the thread and an aside answer at the same time and each composer's
■ stops its own pane's reply — the one that is its leaf. Switching conversations
stops nothing (the person's call, 2026-11-03: they may start another answer
elsewhere while one is written); the node map holds only the open conversation,
so a reply whose conversation is not open is written to the database alone
(`setLive()`, and `commitNode()` for a question committed after the switch) and
shows, still streaming, when its conversation is opened again. Deleting a
conversation stops its replies. Esc at the end of its chain stops the thread's
reply; ⌥⌫ the reply of the pane being typed in. Caching is unaffected: a
thread and a departure share no prefix, so their cache entries live side by
side. Considered: keeping one stream and only fixing which button shows ■ —
smaller, but a second request would still overwrite the first's abort.

**P-47 · Every request says what this chat draws.** The model cannot know that
an svg block is shown as a picture (P-42), and without being told it drew ASCII
art or told the person to save a file. The `rendering` template is appended to
the system message of every request, after Settings → System prompt and before
Pacing, so switching pacing keeps the prefix before it. It is a template, so it
can be edited, or emptied to leave it out. Adding it changes every system
message once, so each conversation misses the cache on its next turn.

**P-48 · Formulas are typeset with KaTeX, and quoted as their TeX.** The parse
both the renderer and the anchor resolver read now includes `remark-math`, so
`$…$` and `$$…$$` are math nodes on both sides and cannot disagree. KaTeX and
its stylesheet are loaded the first time a formula is on screen (until then a
formula reads as its source); a conversation without one never downloads them.
KaTeX's output is the one HTML the renderer puts into the page, built by KaTeX
from TeX with `trust: false`, so no formula can make a link, an id or a class;
a formula KaTeX cannot read is shown as its source in the error colour. A
formula is not a text leaf: a selection inside it, or a click on it, takes the
whole formula, so quoting part of one quotes its TeX entire, and
`rangeForAnchor()` maps a formula's range to its element for the click test
and the underline. A display formula is a block a crop can stop at. A dollar
sign that is not math must be written `\$`, which the `rendering` template
(P-47) now tells the model. Installed with the person's approval
(2026-11-03): remark-math 6.0.0 and KaTeX 0.16.47, the major version
remark-math itself depends on. Considered: MathML output alone, with no
stylesheet or fonts — lighter, but rougher in every browser.

**P-49 · An aside opened from an aside takes the right, and the one it left
takes the centre (supersedes P-8's "in the same pane").** The centre column is
the widest place on screen, and a branch often grows into the line of thought
that matters; keeping the thread there while you work two levels down spent it
on the conversation you had left. So the innermost aside is on the right and
the aside it was asked in is in the centre (`placeOf()`); the thread holds the
centre only while one aside or none is open. Every pane is a sibling in `.main`
and stays mounted, so moving between columns keeps a draft and a scroll
position. ✕ now backs out one level, the reverse of opening, so the centre
slides back; the breadcrumb's Thread closes them all. ↖ on the right scrolls the
pane beside it rather than folding the chain. The divider between the centre
and the right is dragged to share the width, stopping at 320px for the right
and 420px for the centre; the share is a setting (`asideShare`, optional, no
schema change) and a double click resets it. ⤢ lets the right pane fill the
canvas, where a drawing grows to the column, until ⤡ or Esc; it names its
frame, so it lapses once that frame leaves the right. Asked for by the person
(2026-09-26 and 2026-11-04). Considered: a floating window for a closer look —
rejected again for P-7's reasons — and a separate "enter" action that puts a
branch in the centre with nothing beside it, not needed yet.

**P-50 · What was on screen is kept with the conversation.** A conversation's
optional `view` holds its open asides (with any unsent gesture), the wide one,
the thread's unsent quote or rewind, every box's unsent words, files and
choices, and each pane's scroll position as the first message showing plus
an offset into it. It is written 300 ms behind the reader and at once when the
page is hidden, without touching `updatedAt`, and a reload opens the
conversation whose view was written last. On the way back it is checked
against the tree (`restoreView()`): an aside whose messages are gone closes
with every aside opened inside it, and a draft or a mark goes with its pane.
Asked for by the person (2026-11-11) after a browser fault made reloads
frequent; it also means a trip to another conversation and back keeps both.
Considered: localStorage (outside the database the person exports and backs
up), and a table of its own (a schema bump). Exports leave `view` out: it is
not the conversation, and its ids would not survive a remapping import. The
selection, open inspectors and Settings are not kept; losing them costs a
click, not a place.

**P-51 · A block copies its source; a message copies both forms.** A code
block, a display formula and a table each get a copy at their corner, shown
on hover: the code without its fence, the formula as TeX, the table as its
Markdown, because that is what gets pasted where it will run or render. A
message's copy puts its Markdown on the clipboard as plain text and the
rendered reply as HTML (`pastableHtml()`: the page's controls and attributes
removed, a formula kept as MathML), so an editor gets the source and a
document gets the formatting from one button. The buttons are controls, not
text: never quoted, and a press on one is not a reading move. Where the
Clipboard API is refused, the copy command carries both forms. Asked for by
the person (2026-11-11). Considered: a second "copy formatted" button, which
doubles a choice the paste target already makes.

**P-52 · A pane read away from its end offers the way back.** A round ↓
appears at the bottom of a pane once it is more than half a screen above its
end, and stays until the pane is back there; a dot on it says a reply is
still being written below. Pressing it glides to the end and turns following
back on (the follow a scroll up switched off). It is sticky inside the
scroller, so it moves with its pane between columns without a wrapper. Asked
for by the person (2026-11-11), who suggested showing it only while
scrolling up; agreed instead: shown for as long as you are up there, since a
button that hides when you stop scrolling is gone when you reach for it.

**P-53 · A reply's files are saved, not copied out one by one.** The `files`
template, in every system message after `rendering` (P-47), asks the model to
put a file's name after the language on its fence — ```` ```python
scripts/fetch.py ```` — and to leave a snippet that is not a whole file
unnamed. A code block then has **save** beside its copy and shows its path
where the language was; a finished reply has **save** (its Markdown, as
`<title>.md`) and, when it names two or more files, **save N files**: one
`.zip` that keeps their folders, a file named twice saved once with its later
block. `namedPath()` reads the forms models write (`title="…"`, `file=…`,
```` ```python:main.py ````, ```` ```main.py ````), and `safePath()` keeps a
name inside the folder it is unpacked in (no root, drive or `..`). The zip is
written by `zipFiles()` with stored entries and UTF-8 names, about a hundred
lines and no dependency, and read back in the tests by the app's own reader
(P-45). Everything is made in the browser and handed to its download, so the
app writes nowhere the person did not choose, and the bridge still writes no
files. A new template rather than a longer `rendering`: a default that
changes does not reach a template row already stored, and a new one does.
Adding it changes every system message once, so each conversation misses the
cache on its next turn. Asked for by the person (2026-11-13), who chose named
files over a plain save (A) and over writing into a project folder through
the File System Access API (C), which stays undone.

**P-54 · A research reply may take 15 tool steps, a project reply 25.** A
step (Claude Code's `--max-turns`) is one model call and the tools it asked
for, however many ran at once. The limits were 6 and 12, chosen when the
bridge was first written and never revisited; a question checked against
several sources (a dataset's yearly counts, read off three mirrors) ran out
at 6 with nothing but a progress note written between two lookups, under
the notice that the answer so far is above. The limits still stop a run
that loops; they no longer stop one that is working. Considered, not done:
telling the model its budget, so that near the end it answers from what it
has — it needs the bridge's limit in the app's system message, or prompt
text injected by the bridge, which is not a template; and a follow-up call
without tools to sum up, which cannot see the lookups once the run has
ended (`--no-session-persistence`).
