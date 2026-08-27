import type { BranchKind, ContextPolicy, PolicyKind } from "@/types";

/**
 * Shared display vocabulary for the six origin kinds and five policy kinds.
 * The transcript chips, the composer, and the tree edges all read from here, so
 * a colour never means one thing in the tree and another in the transcript.
 */

export const BRANCH_META: Record<
  BranchKind,
  { label: string; short: string; cssVar: string; glyph: string; blurb: string }
> = {
  continuation: {
    label: "Continuation",
    short: "cont",
    cssVar: "--hue-continuation",
    glyph: "→",
    blurb: "The ordinary next turn.",
  },
  regenerate: {
    label: "Retry",
    short: "retry",
    cssVar: "--hue-regenerate",
    glyph: "↻",
    blurb: "A sibling attempt at the same prompt.",
  },
  "concept-lens": {
    label: "Concept lens",
    short: "lens",
    cssVar: "--hue-lens",
    glyph: "◎",
    blurb: "Asked about one term, with a narrow window of context.",
  },
  "structural-crop": {
    label: "Crop",
    short: "crop",
    cssVar: "--hue-crop",
    glyph: "✂",
    blurb: "The tail of the answer was cut off and never sent.",
  },
  "isolated-selection": {
    label: "Isolated",
    short: "iso",
    cssVar: "--hue-isolated",
    glyph: "◌",
    blurb: "Lineage without inheritance — the selection was the whole context.",
  },
  "quote-reply": {
    label: "Quote reply",
    short: "quote",
    cssVar: "--hue-quote",
    glyph: "❝",
    blurb: "Replied to a passage, continuing the same path.",
  },
};

export const POLICY_CLASS: Record<PolicyKind, string> = {
  "full-ancestry": "",
  windowed: "chip--windowed",
  truncated: "chip--truncated",
  isolated: "chip--isolated",
  quoted: "chip--quoted",
};

/**
 * The one sentence the inspector shows above the payload. Its job is to tell
 * the user what is *missing*, because that is the part they cannot infer.
 */
export function policyExplanation(policy: ContextPolicy): string {
  switch (policy.kind) {
    case "full-ancestry":
      return "Every message from the root of this branch down to here, in order. The ordinary behaviour.";
    case "windowed":
      return `Only the last ${policy.turns} exchange${
        policy.turns === 1 ? "" : "s"
      } before this point, inlined into the concept-lens template as prose. Everything earlier was left out.`;
    case "truncated":
      return "The conversation up to a cut point inside the previous answer. Everything after the cut was discarded and never reached the model — though it is still readable above.";
    case "isolated":
      return "Nothing but the selected text. No ancestry, no earlier turns. This node sits in the tree where it was born, but it inherited none of it.";
    case "quoted":
      return "The full path, plus the quoted passage prepended to your message as a blockquote.";
  }
}

export function branchColor(kind: BranchKind): string {
  return `var(${BRANCH_META[kind].cssVar})`;
}
