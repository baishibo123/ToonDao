# The outline and the branch window

A record of the decisions behind putting every branch in the sidebar as its own
row, and giving every branch a window of its own. The README says what the
surfaces *are*; this says what we chose, what we turned down, and what each
choice cost.

Both changes answer the same complaint: a conversation with eight branches in it
was a single scrolling column, and the only map of the branches was a canvas of
unlabelled dots. You could see the *shape* of the thinking and you could read
*one path* through it, but you could not get a list of the things you had asked.

The work ran in two passes. The first put branches in the sidebar and opened a
window when you made one — but left the chat box rendering the full lineage path,
so navigating into a branch still spliced it into the main window. Section 0
records the rule the second pass introduced to fix that, and it is the rule the
rest of this document should be read against.

---

## 0. A window is one linear conversation

**Context.** After the first pass, a branch had a window *when you made it*, but
the main chat box still rendered `pathToRoot(activeNodeId)` — the whole lineage
from the root to wherever the cursor was. Clicking a branch row in the sidebar
moved that cursor into the branch, so the main window showed trunk turns and then
branch turns, in one column, with nothing marking the seam. The complaint was
exact: everything still ended up in the same window, and it read as nested.

**Decision.** A window shows **one spine** and never any part of another. A spine
is a run of turns joined by `continuation` and `quote-reply` edges; retries are
attempts at one turn, not a line of their own. Everything else departs, and a
departure only ever appears in its own window.

Three consequences, and they are the whole of the second pass:

1. **The cursor is spine-bound.** `activeNodeId` may only sit on the root spine.
   `mainSpineCursor()` enforces it on load and after a delete, so even a cursor
   persisted by an older build cannot reopen the app halfway down a lens.
2. **Navigation is routed, not free.** Every "go to this node" — sidebar row,
   tree dot, fork mark, variant switch, `⌥↑`/`⌥↓` — goes through `focusNode()`,
   which asks which spine the node is on and either moves the cursor or opens
   that spine's window. `setActiveLeafFrom()` is gone: it walked *down* through
   whatever fork was last visited, which is precisely the splice.
3. **The transcript marks departures instead of containing them.** A branch that
   is never rendered inline is unreachable from the message that caused it, so
   each message now lists the branches that left it as chips that open their
   windows. Without this the sidebar would be the only way in, and the passage
   that provoked a branch would carry no trace of it.

**Why the cut is at continuation and quote-reply.** It is the cut the data model
already makes — `isTrunkKind()`, shared with the tree canvas — and the one the
user's own framing makes: a reply is the next thing you said, and everything else
is a second thing you are now doing. §5.4 already argued this for quote replies:
they borrow the messaging-app convention, and in a messaging app replying to a
message does not open anything.

**Cost.** You can no longer type into the middle of a thread by navigating there;
the composer is always at the end of the spine it belongs to. Asking something
else off an earlier message is now an explicit gesture that opens a window — see
1.4. The old "Branch from here", which silently moved the cursor backwards, is
gone, and good: it was the same splice under a friendlier name.

---

## 1. What is a row?

### 1.1 A row is a thread, not a turn and not a node

**Context.** The obvious reading of "every branch gets its own record" is one row
per node, or one row per turn. A 54-turn conversation then has 54 rows and the
outline is a second, worse transcript.

**Decision.** A row is a *thread*: one run of turns joined by trunk-kind edges
(`continuation`, `quote-reply`). Every departure — a lens, a crop, an isolation —
starts a row of its own, nested under the thread it left.

**Why this cut.** It is the same cut `treeLayout.ts` already makes for the
canvas, and `outline.ts` imports `isTrunkKind()` rather than restating it, so the
sidebar cannot come to disagree with the map about what a branch is. It is also
the cut that matches the request: "all of the branch chats should have their own
record" — a branch, not a message.

**Cost.** A row's label has to be chosen rather than read off a field. See 1.3.

### 1.2 Retries do not appear at all

**Decision.** A retry is a second assistant reply to one user node, so it does
not open a turn, and the outline never shows it.

**Why.** A retry is not a different question. It collapses into the row it was
tried in for the same reason it collapses into one dot with a variant ring on the
canvas: the alternative is that pressing *retry* three times adds three rows that
all say the same thing.

### 1.3 A branch is named after the passage it came from

**Decision.** The label is the anchored passage — the text you pointed at — and
falls back to the ask you typed. A crop has no passage (its anchor is a *point*,
the cut line), so it falls back to the ask, and then to "Picked up from the cut".

**Why.** The passage is the most recognisable thing about a branch, because it is
the thing the user chose. The ask is often empty by design: for three of the four
gestures an empty message is meaningful, so a label built from the ask alone
would leave rows blank exactly where the gesture was most deliberate.

`branchLabel()` is one function used by the sidebar row, the window title and the
transcript's fork mark, because those are three views of one branch and must not
name it three ways.

### 1.4 An ordinary question off an earlier message is a departure too

**Context.** The selection toolbar's "Branch from here" moved the cursor to an
earlier message so the next thing you typed forked off it. Under section 0 that
is exactly the move that is no longer allowed.

**Decision.** It becomes a gesture like the others — `fork` — and opens a window.
Its policy is the *ordinary* one (`full-ancestry`, a `continuation` edge); the
only thing that makes it a departure is where it attaches. The label says "New
line from here".

**Why.** Two ordinary lines of thought off one message are two conversations, and
the invariant says two conversations are two windows. It also keeps the sidebar
honest: the second continuation off a turn was already a row of its own (see
section 2), so it should have been a window all along.

**Cost.** A sixth gesture kind, for a policy that already existed. `draft.ts` is
still the only place a policy is constructed, and `gestureOpensWindow()` still
derives the window decision from `plan.forks`, so nothing new can drift.

---

## 2. Stability versus liveness

**Context.** A turn can have two continuations — you came back later and asked
something else in the same register — and only one can hold the spine. The canvas
gives it to whichever one you are currently reading, so that the trunk is always
the thread you are actually in.

**Decision.** The outline gives it to the *oldest*, always. So the canvas and the
outline can disagree about which continuation is "the" thread.

**Why.** They are answering different questions. The canvas is a live map of
where you are; the outline is an index. A row that reorders itself as you
navigate is not an index — you would lose your place in the list every time you
used the list. Finder does not rename a folder because you opened a file in it.

**Cost.** One real inconsistency between two views of the same tree, which is
exactly the kind of thing this codebase otherwise refuses (see the shared
vocabulary in `policyMeta.ts`). It is documented here and in the header of
`outline.ts` because it will look like a bug to the next reader.

---

## 3. Why a window, and why not a browser window

### 3.1 A branch is a second thing you are doing, not the next thing you said

**Context.** Before this change, branching moved the transcript: the composer's
pending gesture was sent, `activeNodeId` moved onto the new node, and the thread
you were reading was replaced by the branch. The branch was legible and the place
you left was not.

**Decision.** A branching gesture opens a floating window in front of the thread,
with its own transcript and its own composer. The thread does not move.

**Why.** The two things are concurrent in the user's head — you asked what a term
meant *because* you were reading a particular sentence, and you are not finished
with the sentence. Keeping both on screen is the whole value; it also puts the
carried payload next to the passage it was carved from, so the context inspector
finally has something to be inspected *against*.

**Cost.** `submit()` needed a `detached` mode, and the ids of the nodes it
creates had to become observable before the stream finishes (`onCommitted`) — an
awaited result would leave a new window empty for the whole generation and then
fill it in one jump. Note that `detached` was necessary but not sufficient: it
stops a *send* from moving the thread, and section 0 is what stops *navigation*
from doing the same thing.

### 3.2 An in-app panel, not `window.open()`

**Decision.** A `position: fixed` panel on its own stacking layer.

**Why.** A real popup would lose the shared Zustand store, the shared IndexedDB
connection and the sight of the thread behind it, and the browser would wrap
chrome, a URL bar and its own close semantics around what is one view of one
document. The user asked for a sub-window, not a second copy of the app.

**Cost.** Dragging, resizing, z-order, viewport clamping and focus are ours to
implement. About sixty lines, most of it clamping.

### 3.3 A quote reply does not open a window

**Decision.** Of the four selection gestures, three open a window and
`quote-reply` does not.

**Why.** §5.4 borrows the messaging-app convention, and the convention is that
replying to a message continues the conversation you are in. It is also what the
data model already says: `quote-reply` is a trunk kind, and `plan.forks` is
`false`. `gestureOpensWindow()` therefore *derives* the answer from
`planSubmission()` instead of listing kinds, so a gesture cannot fork in the
payload and behave like a reply on screen.

**Cost.** One more indirection for a reader following the click.

### 3.4 The carried payload starts open, then closes itself

**Decision.** A new window opens with its context inspector expanded, and
collapses it on the first send.

**Why.** Before the first message the payload is the only thing in the window
worth reading, and it is the last moment it can change what you type. After
there is a reply to read, leaving it open would spend most of a small window
previewing the *next* message instead of showing this one.

---

## 4. What one surface may do to another

**Decision.** Three things are per-surface, and only these three: which gesture
is pending, which leaf the composer is attached to, and which node a retry moves
to. Everything else — the nodes, the policies, the
templates, the single in-flight stream — stays global.

**Why.** The window is a view, not a workspace. The moment a window owns nodes,
closing it has to ask a question, and "close this window" should never be able to
lose a conversation. Keeping one stream in flight app-wide is the pre-existing
behaviour and was left alone: two concurrent streams is a change to the provider
layer, not to windowing, and bundling it here would have hidden it.

**Cost.** You cannot generate in two windows at once. The send buttons disable
together, which is honest but will eventually want fixing.

**Mechanism.** A React context (`Surface`) rather than a prop threaded through
the transcript into every message. The default — absent — means the thread, so
every component rendered outside a window behaves exactly as it did before
windows existed.

---

## 5. What the `‹ ›` switcher is for

**Decision.** The variant switcher appears only on a reply, and only offers other
replies to the same question.

**Why.** It used to offer every sibling of the current node. On a user node those
siblings are separate lines of thought, so the control said "these are three
versions of one message" while the layout said "these are three conversations".
The marks and the sidebar already lead to the branches; the switcher's job is the
one thing they cannot do, which is swap an attempt in place.

**Cost.** None found. It also means the switcher is now absent from most branch
roots, where it was previously offering to jump to unrelated branches.

---

## 6. Three bugs this turned up

**Escape did too much.** The composer cleared its pending gesture and then let
the same keypress fall through to the global Escape chain, which would go on to
stop a running stream. Invisible before (the chain's next stop was usually
harmless); with windows it would drop the gesture *and* close the window. The
composer now stops propagation when it handles the key.

**The crop rail could not be reached with a mouse.** `CropRail` returned `null`
until it had cut points to draw, and its own element is one of the things the
measurement that produces those cut points needs — so the ref never mounted, the
measurement never ran, and the rail never appeared. Only the seeded and
programmatically-created crops existed. Found while trying to verify that a crop
click opens a window, since that is the click this change reroutes. The rail now
renders unconditionally and only its marks are conditional.

**A window opened in a hidden tab was stuck in the corner.** A backgrounded tab
reports `innerWidth`/`innerHeight` as 0, and geometry computed from that comes
out at the minimum size at the clamp floor — and is then *stored*, so it stays
wrong after the tab becomes visible. `lib/viewport.ts` treats a non-positive
reading as "not measurable yet". Windows are also re-clamped on resize, because a
window whose title bar is off-screen cannot be dragged back.
