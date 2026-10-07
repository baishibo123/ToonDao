# ToonDao — invariants and conventions

Rules that hold for the life of the project. Why each one exists is in
`docs/decisions.md`; what the code currently does is the code itself.

## The data model

- **Two graphs, never conflated.** Lineage is `parentId` / `childrenIds` /
  `origin` ("this came out of that"). Context is `contextPolicy`, resolved by
  `assembleContext()` ("this was in the prompt"). A child in lineage may inherit
  nothing in context. Nothing in `src/types.ts` or anywhere else may derive one
  from the other.
- **`assembleContext()` is the only constructor of prompts.** No component or
  store builds a message array. Check:
  `grep -rnE "ChatMessage\[\]|role: \"(user|assistant|system)\"" src` — every hit
  must be `assembleContext.ts`, a provider adapter reshaping an assembled array,
  a type, or `parsePayload()` (display only).
- **A departure is a context root.** A user node whose policy is `isolated`,
  `windowed` or `truncated` stops the context walk (`isContextRoot()`) and stands
  in for everything above it with the prompt it was sent as (`departurePrompt()`).
  So a later turn in an aside never re-inherits the thread, and a crop's tail
  never comes back. `isContextRoot()` must agree with `plan.forks`; a test in
  `test/draft.test.ts` holds them together.
- **`planSubmission()` in `src/lib/draft.ts` is the only place a policy is chosen
  for a new node.** Check:
  `grep -rnE "kind: \"(full-ancestry|windowed|truncated|isolated|quoted)\"" src` —
  hits outside `draft.ts` may only be `transfer.ts` (deserialising).
- **Every prompt text the app injects is a template** (`src/lib/templates.ts`,
  user-editable, stored in IndexedDB). Never hardcode prompt wording at a call
  site; read it from the store's `TemplateSet`.
- **`assembledPreview` is historical.** It records what was actually sent and is
  never recomputed.

## Panes and navigation

- **A pane shows exactly one spine.** A spine is turns joined by `continuation`
  or `quote-reply`; everything else departs. The thread shows the root spine; an
  aside shows one departure. No pane renders two spines.
- **`activeNodeId` stays on the root spine.** Everything that moves it must land
  there: `mainSpineCursor()` on load and after a delete, `focusNode()` for
  navigation, and `commitNode()` for a thread send, which extends the root
  spine by construction. Aside sends are `detached` and never move it.
- **`focusNode()` in `src/store/focusNode.ts` is the only router.** Anything that
  means "go to this node" calls it; nothing else decides between the thread and
  an aside.
- **`gestureOpensAside()` derives from `plan.forks`.** Never re-list gesture
  kinds to decide what opens an aside.
- **The spine rule is stated twice and the two must agree**, both in
  `src/lib/outline.ts`: `spineChild()` per node (used by `spineLeaf()`,
  `forksOf()` and the transcript) and `spineNext` inside `buildOutline()` per
  turn (used by the sidebar). Both use `isTrunkKind()` and break ties
  oldest-first. `spineChild()` also honours the remembered choice (which retry
  you are reading); the outline deliberately does not, so its rows never move
  as you navigate. Change one, check the other.

## Persistence and data

- **No Dexie schema version bump without a migration.** Prefer optional fields
  on existing records (as `Conversation.later` does), so an older build opening
  the same database still works.
- **An export never contains an API key.** An id collision on import remaps every
  id in the bundle together, never some of them.
- **The Later list drains.** Sending anything about a parked passage removes it;
  deleting its message prunes it.

## The Claude Code bridge

- **The bridge never handles a credential.** It starts the user's own unmodified
  `claude` and relays its output; it never reads, stores or forwards an OAuth
  token or key.
- **Nothing a request carries becomes a command-line flag.** Model names must pass
  `isSafeModel()`; the system prompt goes through a file and the conversation
  through stdin, never through argv.
- **`toolScopeFor()` in `src/lib/toolScope.ts` is the only place a tool scope is
  decided**, from the question's node, never from a policy alone: inside an aside
  the move that opened it decides every turn (`contextStart()`). The bridge may
  narrow the scope, never widen it, and never adds a tool that runs commands or
  writes files.
- **`src/lib/bridgeProtocol.ts` has no imports.** Node runs it directly from the
  bridge, where the app's `@/` alias does not exist; both ends encode and decode
  through it.
- **The bridge listens on 127.0.0.1 and answers only the app's origins.**
- **A request never names a folder.** A new project's folder comes from the
  system dialog the person clicks through (`chooseFolder()`); a registered one is
  looked up by its slug. The project routes answer with summaries, never with
  what a snapshot holds.
- **Nothing per-run reaches the prompt Claude Code builds.** Every run starts in
  the same empty `RUN_DIR`, with a host session's variables dropped (`runEnv()`).
  A path, id or time that differs between runs turns the prompt cache off for
  every turn of every thread.

## Learning from a project

- **The harvest only reads, and never reads what git ignores.** `projectFiles()`
  lists tracked or trackable files — ignored ones are where captures, traces and
  secrets live — and every text `renderHarvest()` or `renderSession()` emits
  passes `redact()`.
- **Nothing assumes a project has decision records, notes or history.** Every
  source is optional, and the harvest's Sources table says which are missing.
- **A snapshot is private, redacted and never overwritten.** Its files are
  owner-only, transcripts are copied through `redactTranscript()`, and each
  snapshot gets its own dated folder.

## Conventions

- **Display vocabulary lives in `src/lib/policyMeta.ts`.** Glyphs, labels and hue
  variables for every kind come from there; never restate one.
- **Keyboard shortcuts use ⌘⇧ / Ctrl-Shift**, never a bare ⌘ combination the
  browser owns.
- **Language: artifacts are English** — code, comments, commit messages, docs,
  filenames.
- **Every commit builds and passes `npm test` on its own**, so verified commits
  can be cherry-picked onto `main` in order.
- **Unreviewed work stays on a branch.** `main` only receives commits whose design
  has been confirmed.
