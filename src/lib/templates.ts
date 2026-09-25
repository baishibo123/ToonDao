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
