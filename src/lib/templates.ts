import type { TemplateId, TemplateSet } from "@/types";

/**
 * Seed templates. These are copied into IndexedDB on first run and are
 * user-editable from settings after that. Never read a hardcoded template at a
 * call site — always take the TemplateSet from the store.
 *
 * The wording is the user's own. Preserve the register when editing defaults.
 */
export const DEFAULT_TEMPLATES: TemplateSet = {
  concept_lens: `This is the context of our conversation:

{{context_turns}}

And this is the concept I'm curious about:

{{concept}}

Please take into account everything I have said throughout this interaction, and precisely address my confusion about this specific concept, for me.`,

  structural_crop: `Here is our conversation up to the exact point where I got lost:

{{truncated_context}}

I stopped reading right here. I am not confused about a specific term — I am confused about the structure or the reasoning of what you were building toward at this point. Pick up from exactly this spot and clarify it. Do not continue past it and do not summarize what you were going to say next.`,

  isolated_selection: `{{selection}}

---

Treat the text above as the entire context. Answer only about it.`,

  // Not a gesture: a standing instruction, appended to the system message of
  // every request while Settings → Pace answers is on. An answer longer than
  // the reader can hold is the reading problem at its source, so the cheapest
  // fix is to ask for less, and a checkpoint to decide what comes next.
  pacing: `Pace your answers like a conversation, not a lecture. Give me one idea at a time — the next thing I need, not everything you know — and keep it to what fits on one screen. If there is more to say, stop at a natural checkpoint and end with one real question: either to check that I followed, or to ask which way to go next.`,

  // P-32: the first message of a conversation that learns from a project. The
  // method is the learn-project skill's, kept general: no project is assumed to
  // have decision records, and the language is the reader's — their standing
  // instructions first (P-33), since this message itself is in English.
  // P-34: a conversation's title, written by the model in one short request
  // after the first reply, or when the person asks for it again. Kept small on
  // purpose: the asks and an answer's opening, clipped, and nothing else.
  title: `Write a title for this conversation: at most eight words, in the language the person writes in, naming what it is about rather than repeating the question. Reply with the title alone, without quotes or a full stop.

What they asked:
{{asks}}

How the latest answer begins:
{{answer}}`,

  learning_map: `I built {{project}} with Claude Code, and I want to learn from it. Your working directory is a snapshot of the project. Read harvest.md first: it gathers what the project holds about how it was built — my prompts and the errors I hit in its Claude Code sessions, Claude Code's own notes, its git history, its notes and its files, with a table of which of those it has. sessions/ holds each session in full, and files/ the project as it was.

Then draw me a study map:
- Five to ten modules. A module is a cluster of concepts this project actually exercised, ordered by how much the project leaned on it and how often it broke.
- Anchor each module in the strongest evidence there is: an incident (a session where something broke, a fix commit), then a decision (a decision record or a note), then a place in the code (file and line). Never invent an incident. If there is little history, ask me what was hardest instead.
- For each module: what happened, in two to four lines with a pointer to where; the concept in plain words, with key terms under their English names; what it builds on; and three questions — one to recall, one about the mechanism (why or how), one to transfer it (what if…).
- End with a Queue: concepts that came up in passing and are worth learning later.

Show me the list of modules, recommend where to start and why, and ask me where I want to begin. From then on, teach one question at a time, story first, grounded in this project's code. If my standing instructions say which language to use, write in it; otherwise write in the language I write to you in.`,

  // §4: quote_reply has no wrapper. The quote is rendered as a `>` blockquote
  // prepended to the user's message. The body is kept in the template set only
  // so the editor can show it; {{quote}} / {{message}} are the two slots.
  quote_reply: `{{quote}}

{{message}}`,
};

export const TEMPLATE_META: Record<
  TemplateId,
  { label: string; vars: string[]; note: string }
> = {
  concept_lens: {
    label: "Concept lens",
    vars: ["context_turns", "concept"],
    note: "§5.1 — windowed policy. {{context_turns}} is the last N user/assistant pairs rendered as plain prose.",
  },
  structural_crop: {
    label: "Structural crop",
    vars: ["truncated_context"],
    note: "§5.2 — truncated policy. {{truncated_context}} ends mid-message at the cut offset.",
  },
  isolated_selection: {
    label: "Isolated selection",
    vars: ["selection"],
    note: "§5.3 — isolated policy. Zero ancestry. {{selection}} is the only context the model receives.",
  },
  quote_reply: {
    label: "Quote reply",
    vars: ["quote", "message"],
    note: "§5.4 — quoted policy. {{quote}} is already prefixed with `> ` on every line.",
  },
  pacing: {
    label: "Pacing",
    vars: [],
    note: "Appended to the system message of every request while Settings → Pace answers is on. No variables.",
  },
  title: {
    label: "Title",
    vars: ["asks", "answer"],
    note: "P-34 — one short request after a conversation's first reply, and on ↻ beside its title. {{asks}} is the person's messages on the thread, clipped; {{answer}} the opening of the latest reply. Sent without the system prompt or pacing.",
  },
  learning_map: {
    label: "Learning map",
    vars: ["project"],
    note: "P-32 — the first message of a conversation started from Settings → Projects. {{project}} is the project's name; the model reads the snapshot it is pinned to.",
  },
};

/** Substitute {{vars}}. Unknown variables are left untouched so a typo in a
 *  user-edited template is visible rather than silently blanking content. */
export function renderTemplate(
  body: string,
  vars: Record<string, string>,
): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/** Prefix every line with "> " for §5.4. */
export function asBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
}
