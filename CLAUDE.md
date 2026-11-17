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
- **A file is part of its question's turn** (`ConversationNode.attachments`,
  P-43). It is sent wherever that turn is sent whole and never inside a
  departure's carved-out text; `assembleContext()` decides which messages carry
  files, the adapters in `src/providers/content.ts` only reshape them, and text
  files go into the message through the `attachment` template. A Word or
  PowerPoint file is converted to text in the browser when it is attached
  (`src/lib/convert/`, P-45) — never by a tool or a server.
- **Archiving is display only** (P-58). `archivedAt` and `archivedBranches`
  decide what the sidebar lists (`visibleThreads()`), never the tree, the
  context, the counts or a reply's fork markers.
- **`assembledPreview` is historical.** It records what was actually sent and is
  never recomputed.

## Panes and navigation

- **A pane shows exactly one spine.** A spine is turns joined by `continuation`
  or `quote-reply`; everything else departs. The thread shows the root spine; an
  aside shows one departure. No pane renders two spines.
- **The innermost aside is on the right, the one it left in the centre**
  (`placeOf()` in `src/lib/panes.ts`, P-49); the thread holds the centre only
  while at most one aside is open. Panes move between columns by class, never
  by remounting, so a draft and a scroll position survive the move.
- **`activeNodeId` stays on the root spine.** Everything that moves it must land
  there: `mainSpineCursor()` on load and after a delete, `focusNode()` for
  navigation, and `commitNode()` for a thread send, which extends the root
  spine by construction — a rewind's question lands on it because its reply's
  `line` is set first (P-44). Aside sends are `detached` and never move it.
- **Replies stream in parallel, keyed by node** (`streams`, P-46). A pane's ■
  stops the reply that is its own leaf; switching conversations stops none; a
  reply whose conversation is not open writes to the database only, never into
  the open conversation's node map.
- **`focusNode()` in `src/store/focusNode.ts` is the only router.** Anything that
  means "go to this node" calls it; nothing else decides between the thread and
  an aside.
- **`gestureOpensAside()` derives from `plan.forks`.** Never re-list gesture
  kinds to decide what opens an aside.
- **The spine rule is stated twice and the two must agree**, both in
  `src/lib/outline.ts`: `spineChild()` per node (used by `spineLeaf()`,
  `forksOf()` and the transcript) and `spineNext` inside `buildOutline()` per
  turn (used by the sidebar). Both use `isTrunkKind()`, give the line to the
  child a rewind named in the reply's `line` (P-44), and otherwise break ties
  oldest-first. `spineChild()` also honours the remembered choice (which retry
  you are reading); the outline deliberately does not, so its rows never move
  as you navigate. Change one, check the other.

## Persistence and data

- **No Dexie schema version bump without a migration.** Prefer optional fields
  on existing records (as `Conversation.later` does), so an older build opening
  the same database still works.
- **What was on screen is a conversation's `view`, not its content** (P-50):
  written by `src/store/viewPersistence.ts` without touching `updatedAt`,
  checked against the tree by `restoreView()` before it is shown, and never
  exported. A composer's draft lives in `useUI.drafts`, not in the component.
- **An export never contains an API key.** An id collision on import remaps every
  id in the bundle together, never some of them.
- **A title the person typed is never replaced automatically.** Naming
  (`nameConversation()`) runs on a conversation's first finished reply only
  while `titleSource` is unset, and otherwise only when the person presses ↻.
  Its request is built by `assembleTitle()`, which stays a few hundred tokens.
- **Pace answers is decided at the question.** `assemble()` takes it from the
  question's own switch, else the branch above it (`branchPacing()`), else the
  conversation, else Settings — never from Settings alone.
- **The Later list drains.** Sending anything about a parked passage removes it;
  deleting its message prunes it.

## The Claude Code bridge

- **The bridge never handles a credential.** It starts the user's own unmodified
  `claude` and relays its output; it never reads, stores or forwards an OAuth
  token or key. Its own API key (`bridge/api-key.ts`) is not a Claude credential:
  only the Messages API route checks it, and `runEnv()` keeps it from Claude Code.
- **Nothing a request carries becomes a command-line flag.** Model names must pass
  `isSafeModel()`, a thinking effort `isEffort()`, and a structured-output schema
  is re-serialised by `schemaArg()` and passed as one `--json-schema=` argument
  only if `isSchemaArg()` agrees (Claude Code takes no schema file); the system
  prompt goes through a file and the conversation through stdin, never through argv.
- **`toolScopeFor()` in `src/lib/toolScope.ts` is the only place a tool scope is
  decided** — the web, and which project snapshot may be read — from the
  question's node, never from a policy alone: inside an aside the move that
  opened it decides every turn (`contextStart()`). The bridge may narrow the
  scope, never widen it, and never adds a tool that runs commands or writes
  files. On the Messages API route a request's declared web server tools decide
  it instead (`parseMessagesRequest()`): exactly those lookups, no connectors,
  never more than ToonDao's research scope (`argsFor()` drops anything else).
- **`src/lib/bridgeProtocol.ts` has no imports.** Node runs it directly from the
  bridge, where the app's `@/` alias does not exist; both ends encode and decode
  through it.
- **The bridge listens on 127.0.0.1 and answers only the app's origins** — and,
  on the Messages API route, only a request carrying its key.
- **A request never names a folder.** A new project's folder comes from the
  system dialog the person clicks through (`chooseFolder()`); a registered one is
  looked up by its slug. The project routes answer with summaries, never with
  what a snapshot holds.
- **Nothing per-run reaches the prompt Claude Code builds.** Every run starts in
  the same empty `RUN_DIR` — or, when it may read a project, in that snapshot's
  `read/` folder, the same for every turn of its conversation — with a host
  session's variables dropped (`runEnv()`). A path, id or time that differs
  between runs turns the prompt cache off for every turn of every thread.
- **A model reads a project only through a snapshot's `read/` folder.** Such a
  run starts there with Read, Grep and Glob and `--permission-mode dontAsk`
  (`argsFor()` with `readDir`), so nothing outside it can be read. The folder
  comes from `snapshotReadDir()`, which looks the request's slug and snapshot id
  up in the registry. Transcripts never go in `read/`.

## The Messages API (other chat shells)

- **`/v1/messages` speaks the Anthropic API's own shapes** — request fields,
  Message object, SSE events, error envelope — so an SDK client works by changing
  its base URL and key. Anything only the bridge can do travels in one
  namespaced place: the `toondao` request field, the `toondao` response field,
  `toondao.*` events. Never add an un-namespaced field or event.
- **Every request field is honoured, ignored and named back, or refused — never
  faked.** `parseMessagesRequest()` is the only place a field's class is decided;
  an ignored field is listed in `toondao-ignored-params`, a refused one is a 400.
  Faking a capability the run cannot deliver (a client tool, forced tool use,
  prefill) is the one thing this route must not do.
- **A reply is one message, however many model calls Claude Code made.**
  `createMessagesTranslator()` renumbers blocks across the calls, hides tool
  calls (reported as `toondao.tool`, counted in `usage.server_tool_use`) and sums
  usage; `max_tokens` and `stop_sequences` end the run where the API would stop.
  A call that breaks off and is retried is closed before the retry and noticed;
  a message Claude Code got whole (not streamed) is the reply too, unless it is
  Claude Code's own `<synthetic>` error text.
- **An API run has the person's customizations off and their permission rules
  on** (`--safe-mode`, argsFor's `safeMode`) unless the request sets
  `toondao.user_instructions`, so a shell gets its own system prompt and nothing
  else, while a deny rule in their settings still holds. Never
  `--setting-sources` for this: it drops the deny rules too. ToonDao's route
  keeps P-33.

## Learning from a project

- **The harvest only reads, and never reads what git ignores.** `projectFiles()`
  lists tracked or trackable files — ignored ones are where captures, traces and
  secrets live — and every text `renderHarvest()` or `renderSession()` emits
  passes `redact()`.
- **Nothing assumes a project has decision records, notes or history.** Every
  source is optional, and the harvest's Sources table says which are missing.
- **A snapshot is private, redacted and never overwritten.** Its files are
  owner-only, transcripts are copied through `redactTranscript()`, credential
  files are never copied (`isSecretFile()`), and each snapshot gets its own
  dated folder.
- **A learning conversation stays on its snapshot.** `Conversation.project` pins
  the snapshot it was started on, and every turn reads that one.

## Conventions

- **A font size in the stylesheets is `calc(<n>px * var(--text-scale, 1))` or
  relative (`em`).** A bare pixel size would ignore Settings → Text size (P-38).
- **A reply's markup never enters the page.** Raw HTML renders as text; an SVG
  is drawn only as an `<img>` from the `data:` URL `svgPictureUrl()` builds,
  where it runs no script and fetches nothing (P-42). The one HTML injected is
  KaTeX's typesetting of a formula, through `renderTex()` with `trust: false`
  (P-48).
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
