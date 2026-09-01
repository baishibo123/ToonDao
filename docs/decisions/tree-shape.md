# The tree: from panel, to canvas, to watermark

A record of the decisions behind `feature/tree-shape-optimization`, grouped by
the question each one answers. The README says what the tree *is*; this says
what we chose, what we turned down, and what each choice cost.

The work ran in three passes, and it is worth saying up front that each pass was
provoked by looking at the previous one rather than by planning: the shape
change made the panel look wrong, and fixing the panel made the reserved column
look wrong. None of the three would have been obvious from the start.

---

## 1. What shape should a conversation be?

### 1.1 Two of the six origin kinds are the trunk; the other four branch

**Context.** The map laid every child out the same way, so twenty turns of an
ordinary conversation zig-zagged across the panel exactly like twenty
deliberate branches. The shape carried no information the node count did not
already carry.

**Decision.** Replying to what the model said (`continuation`) and quoting a
passage of it (`quote-reply`) *are* the conversation carrying on, so they run
straight down one vertical spine. A lens, a crop or an isolation is a departure
from that line, so it leaves sideways on an arc and becomes a spine of its own.
Continuations extend a branch; a further gesture forks off it again, one column
further out. Branches on branches, all the way down.

**Why this cut.** It is the only cut that maps onto something the user did.
Every other candidate — by depth, by policy kind, by token count — would have
been a property of the data rather than a record of a decision, and §6 asks the
tree to record provenance of inquiry.

**Cost.** A turn can have two continuations, and only one can hold the line.
See 1.3.

### 1.2 One dot per turn, and depth is a grid

**Context.** A user→assistant edge is always a continuation and always present.

**Decision.** Collapse the pair onto one dot, so every edge that survives is a
decision. Retries collapse further, into a ring around the dot rather than
siblings fanning out (§11 Q2). Vertical position is exactly `depth * ROW_GAP`,
so equal turns line up across every branch.

**Why.** Halving the depth of the drawing costs nothing, because the edge it
removes could only ever have had one value. The row grid is what lets you read
"these two turns are the same distance in" across branches without counting.

### 1.3 When two continuations compete for the trunk, the active path wins

**Rejected.** Give it to whichever was sent first. Stable, and wrong: you would
routinely be reading a thread that the map had drawn as a branch.

**Decision.** The trunk is the thread you are actually in. The sibling keeps its
continuation styling and hangs off as a branch.

**Cost.** The layout depends on the active node, so it re-flows as you navigate.
Acceptable, because it already did — off-path collapse is measured from the
active path.

### 1.4 Hand-rolled lane packing, and d3-hierarchy goes

**Context.** A tidy-tree algorithm centres parents over children. It will not
give you a straight trunk, by construction.

**Decision.** Place spines into `side:column` lanes, cheapest free lane first,
with a vertical clearance per lane. Forks off the trunk alternate sides; deeper
forks stay on the side they are already on so a branch fans outward and never
crosses back over the trunk.

**Why not keep d3 and post-process.** Rigidly shifting each branch to straighten
the trunk gives each branch a different offset, and two branches that used to
clear each other no longer do. The overlap guarantee is the whole value of the
library, and post-processing throws it away.

**Cost.** ~120 lines we now own, and a dependency dropped. Covered by tests that
assert no two dots overlap and that every dot stays inside the reported bounds.

### 1.5 Cards become dots, and the labels go with them

**Decision.** No text on the canvas. The ring is the origin kind's colour, a
filled core means the turn has an answer, a second ring means retries, and the
turn you are reading wears a halo. Words live in the hover card.

**Why.** Once the shape carries the information, seventeen characters of a user
message is noise competing with it — and at the scales the later passes needed,
the labels would not have been legible anyway.

**Cost.** You cannot skim the tree for a phrase. This is the decision most
likely to be worth revisiting; putting short labels back on trunk dots above
some zoom threshold is a small change.

---

## 2. Where should the tree live?

### 2.1 Not in a window

**Context.** It was a floating panel: title bar, drag handle, resize corners,
parked on top of the conversation it describes.

**Decision.** Delete the chrome. The thread and the tree share one canvas.

**Why.** A panel with a title bar is a second application sitting on the first.
The lineage and the conversation are one artifact; presenting them as two panes
asks the reader to do the joining that the product exists to do for them.

### 2.2 Not in a column either

**Context.** The first fix gave the tree a resizable column. Better, and still
wrong: a tree is mostly whitespace, so reserving its bounding box spends far
more room than it uses. A 440px strip of mostly-nothing sat beside a thread
that wanted the width.

**Decision.** Draw the tree across the whole page — over the thread, over the
composer — at watermark strength, and give the thread the page back.

**Cost.** The tree is now over the text, which only works because of §3.

### 2.3 Only the dots take a pointer event

**Decision.** The whole layer is `pointer-events: none`; the hit discs opt back
in.

**Why.** An overlay that eats clicks is a bug with a nice gradient. Selecting a
passage, scrolling the transcript and hitting send all have to work straight
through the tree, and selection in particular is how three of the four gestures
start.

**Cost.** No capture surface means no drag-to-pan on the background and no
wheel zoom. See 4.1.

---

## 3. How do you read a map that is lying on top of your text?

### 3.1 The cursor carries a light

**Decision.** Outside the light the tree is a ghost at 10–26% opacity, blurred
by about a pixel; inside it the tree is at full strength and sharp. The light
follows the cursor anywhere on the page and drifts home over 420ms when the
cursor leaves.

**Why this is the answer to scale, not just to legibility.** The question was
what happens when the tree grows large. The usual answer is a viewport you pan
around a shape you cannot see. This one puts the whole structure on the page at
once, however large it gets, and lets you read it by sweeping the light across
it. Nothing is ever off-screen to go looking for.

### 3.2 Home is the turn you are reading, and it stays lit

**Context (the bug this started as).** The focus mask was centred on the
highlighted turn, but the resting view clamped itself to keep the tree's ends in
frame. On load the active node is the last leaf, so the clamp pinned the tree's
bottom to the panel bottom and the sharp region landed on the end of the tree
rather than on the dot.

**Decision.** The light rests on the highlighted turn, and that turn keeps its
halo in the watermark rather than fading with everything else.

**Why the halo is exempt.** Otherwise the only way to find yourself in a faded
tree is to go hunting with the cursor, which is exactly the work the map is
supposed to save.

### 3.3 Three layers, and the light is not a re-render

**Decision.** The tree is drawn three times: a blurred watermark, an identical
sharp copy masked to a disc, and an invisible layer of hit targets. Moving the
light writes two CSS custom properties on one element.

**Why.** The obvious implementation — spotlight position in React state — would
reconcile several hundred SVG elements at pointer rate. Custom properties move
the mask in the compositor and touch no React at all.

**Cost.** Three copies of the tree in the DOM. Cheap at conversation scale, and
the two painted copies are what produce the sharp/soft boundary in the first
place.

### 3.4 Hit targets in screen space

**Decision.** The interactive discs are drawn unscaled at each node's projected
position, with a floor of 7px.

**Why.** They are twins of the dots, not the dots themselves. Scaling them with
the tree would make a dot at 45% zoom a 5px target.

### 3.5 The reveal tween is time-based, not per-frame

**Context.** The first version eased by a fixed fraction each frame. Under a
throttled `requestAnimationFrame` it stranded the reveal half-open — caught in
testing, where the preview browser ran a handful of frames per second.

**Decision.** Ease over a fixed duration against `performance.now()`.

**Why.** A slow frame rate should make an animation choppy, not broken.

---

## 4. What we gave up, on purpose

**4.1 Free zoom and pan.** Gone with the window that justified them. Supporting
them needs a pointer-capturing surface under the cursor, which is precisely what
would break text selection (2.3). What is left: the whole tree, a close-up on
the current turn, and drag-a-dot to shift the view. If that proves too tight,
the way back is a capture surface gated on a modifier key.

**4.2 Node labels.** See 1.5.

**4.3 A resizable tree area, and `settings.treePanel`.** The persisted panel
geometry had no reader left once the column went, so it was deleted rather than
left to rot in the settings type.

**4.4 Anchor-offset precision.** An edge anchored to a character offset used to
leave the parent card from a band 29px tall; it now leaves the rim of a 5.6px
dot at the matching height. The semantics survive, legibly reduced — the exact
percentage moved to the hover card.

---

## Where this landed

| | before | after |
|---|---|---|
| tree occupies | a 440px column | no reserved space |
| whole tree visible | on hover, zoomed out | always |
| reading the tree | pan and zoom | sweep the light |
| reading the thread | tree in the way | tree reads through |
| layout engine | d3-hierarchy | ~120 lines, tested |

Three commits: `a151515` shape, `c717fe2` canvas, `86864f2` watermark. 180 tests
pass, and the layout suite grew from 27 to 35 cases — trunk classification,
branch nesting, side alternation, the row grid, and the no-overlap guarantee the
dropped dependency used to provide.
