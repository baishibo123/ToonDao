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
