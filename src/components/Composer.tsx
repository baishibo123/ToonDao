import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { useUI } from "@/store/useUI";
import { draftNode, planIsSendable, planSubmission } from "@/lib/draft";
import { ContextChip, Inspector } from "@/components/ContextChip";
import { BRANCH_META } from "@/lib/policyMeta";

const GESTURE_COPY: Record<
  string,
  { label: string; hint: string; className: string }
> = {
  quote: {
    label: "Replying to",
    hint: "Continues this path. The quote is prepended to your message as a blockquote.",
    className: "composer__gesture--quote",
  },
  isolated: {
    label: "Only this text",
    hint: "Nothing else is sent — no earlier turns, no ancestry. Branches off where the text came from.",
    className: "composer__gesture--isolated",
  },
  concept: {
    label: "Concept",
    hint: "Sent with a narrow window of recent turns. Branches off the message you clicked in.",
    className: "composer__gesture--concept",
  },
  crop: {
    label: "Cropped here",
    hint: "Everything after the cut is withheld from the prompt. The full answer stays readable above.",
    className: "composer__gesture--crop",
  },
};

export function Composer() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  const conversationId = useStore((s) => s.conversationId);
  const activeNodeId = useStore((s) => s.activeNodeId);
  const nodes = useStore((s) => s.nodes);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const submit = useStore((s) => s.submit);
  const stop = useStore((s) => s.stop);
  const assemble = useStore((s) => s.assemble);
  const templates = useStore((s) => s.templates);
  const systemPrompt = useStore((s) => s.settings.systemPrompt);

  const pending = useUI((s) => s.pending);
  const setPending = useUI((s) => s.setPending);
  const setConceptTurns = useUI((s) => s.setConceptTurns);
  const focusNonce = useUI((s) => s.composerFocusNonce);
  const composerSeed = useUI((s) => s.composerSeed);
  const showDraftInspector = useUI((s) => s.openInspectors.has("__draft__"));

  const streaming = streamingNodeId !== null;

  const plan = useMemo(
    () => planSubmission({ text, pending, activeLeafId: activeNodeId }),
    [text, pending, activeNodeId],
  );

  // The live payload for what is about to be sent. This is the promise §1 makes
  // — the user can see exactly what the model will see, before committing.
  const draftMessages = useMemo(() => {
    if (!conversationId) return [];
    return assemble(draftNode(plan, conversationId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, conversationId, nodes, templates, systemPrompt, assemble]);

  const sendable = planIsSendable(plan, pending) && !streaming && Boolean(conversationId);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [focusNonce, pending]);

  useEffect(() => {
    if (!composerSeed) return;
    setText(composerSeed.text);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      // Park the caret at the end so the user types straight into the gap.
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [composerSeed]);

  // Auto-grow. Measured from 0px rather than "auto": in dev the stylesheet
  // arrives after first paint, and measuring "auto" against unstyled layout
  // produced a textarea several hundred pixels tall. Clamping in JS as well as
  // in CSS keeps the two in agreement, and a resize listener re-measures when
  // the viewport-relative cap changes.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [text]);

  const send = () => {
    if (!sendable) return;
    void submit({
      text: plan.content,
      parentId: plan.parentId,
      policy: plan.policy,
      origin: plan.origin,
    });
    setText("");
    setPending(null);
  };

  const gesture = pending ? GESTURE_COPY[pending.kind] : null;
  const sourceNode = pending ? nodes[pending.sourceNodeId] : undefined;

  return (
    <div className="composer">
      <div className="composer__inner">
        {pending && gesture ? (
          <div className={`composer__gesture ${gesture.className}`}>
            <div className="gesture__main">
              <div
                className="gesture__label"
                style={{ color: `var(${BRANCH_META[gestureToBranch(pending.kind)].cssVar})` }}
              >
                <span aria-hidden>{BRANCH_META[gestureToBranch(pending.kind)].glyph}</span>
                {gesture.label}
              </div>
              {pending.kind === "crop" ? (
                <div className="gesture__quote">
                  {sourceNode
                    ? `${countBlocks(sourceNode.content, pending.charOffset)} kept · ${
                        sourceNode.content.length - pending.charOffset
                      } characters withheld`
                    : ""}
                </div>
              ) : (
                <div className="gesture__quote">{pending.anchor.text}</div>
              )}
              <div className="gesture__hint">{gesture.hint}</div>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setPending(null)}
              aria-label="Remove"
              title="Remove (Esc)"
            >
              ✕
            </button>
          </div>
        ) : null}

        <div className="composer__box">
          <textarea
            ref={textareaRef}
            className="composer__input"
            rows={1}
            value={text}
            placeholder={placeholderFor(pending?.kind, activeNodeId !== null)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
              if (e.key === "Escape" && pending) {
                e.preventDefault();
                setPending(null);
              }
            }}
          />
          {streaming ? (
            <button
              type="button"
              className="composer__send composer__send--stop"
              onClick={stop}
              title="Stop generating"
              aria-label="Stop generating"
            >
              ■
            </button>
          ) : (
            <button
              type="button"
              className="composer__send"
              disabled={!sendable}
              onClick={send}
              title="Send (Enter)"
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>

        <div className="composer__foot">
          {conversationId ? (
            <ContextChip
              nodeId="__draft__"
              policy={plan.policy}
              messages={draftMessages}
              detail={plan.forks ? undefined : undefined}
            />
          ) : null}

          {pending?.kind === "concept" ? (
            <span className="stepper">
              <span>window</span>
              <span className="stepper__btns">
                <button
                  type="button"
                  aria-label="Fewer turns"
                  disabled={pending.turns <= 1}
                  onClick={() => setConceptTurns(pending.turns - 1)}
                >
                  −
                </button>
                <span className="stepper__n">{pending.turns}</span>
                <button
                  type="button"
                  aria-label="More turns"
                  disabled={pending.turns >= 5}
                  onClick={() => setConceptTurns(pending.turns + 1)}
                >
                  +
                </button>
              </span>
              <span>turn{pending.turns === 1 ? "" : "s"}</span>
            </span>
          ) : null}

          {plan.forks ? (
            <span className="msg__branchcount">branches off the source message</span>
          ) : null}

          <span className="composer__hint">
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
          </span>
        </div>

        {showDraftInspector ? (
          <Inspector policy={plan.policy} messages={draftMessages} />
        ) : null}
      </div>
    </div>
  );
}

function gestureToBranch(kind: string) {
  switch (kind) {
    case "quote":
      return "quote-reply" as const;
    case "isolated":
      return "isolated-selection" as const;
    case "concept":
      return "concept-lens" as const;
    default:
      return "structural-crop" as const;
  }
}

function placeholderFor(kind: string | undefined, hasHistory: boolean): string {
  switch (kind) {
    case "quote":
      return "Reply to the quoted passage…";
    case "isolated":
      return "Ask about the selection only — or send blank to just have it explained";
    case "concept":
      return "What about this concept? Leave blank to just ask for an explanation";
    case "crop":
      return "Optional note — or send blank to ask it to pick up from the cut";
    default:
      return hasHistory ? "Reply…" : "Start a conversation…";
  }
}

/** Rough block count for the crop chip. Cheap on purpose. */
function countBlocks(content: string, upTo: number): string {
  const kept = content.slice(0, upTo).split(/\n{2,}/).filter(Boolean).length;
  const total = content.split(/\n{2,}/).filter(Boolean).length;
  return `${kept}/${total} blocks`;
}
