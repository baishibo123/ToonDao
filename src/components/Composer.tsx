import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { draftKey, useUI, type PendingGesture } from "@/store/useUI";
import { draftNode, planIsSendable, planSubmission } from "@/lib/draft";
import { ContextChip, Inspector } from "@/components/ContextChip";
import { BRANCH_META, branchKindForGesture } from "@/lib/policyMeta";
import { useSurface } from "@/components/Surface";

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

/**
 * One composer, two surfaces.
 *
 * Rendered bare it is the thread's composer, attached to the app's active leaf.
 * Rendered inside an aside (which provides a `Surface`) it is that aside's
 * composer: it reads that aside's pending gesture, submits detached so the
 * thread beside it does not move, and binds the branch to the aside on the
 * first send. Both routes go through `planSubmission()` — the surface
 * changes where a message lands, never what gets sent.
 */
export function Composer() {
  const { asideId } = useSurface();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  /** null means "whatever this branch inherits" (§8 P3). */
  const [modelOverride, setModelOverride] = useState<string | null>(null);

  const conversationId = useStore((s) => s.conversationId);
  const appActiveNodeId = useStore((s) => s.activeNodeId);
  const nodes = useStore((s) => s.nodes);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const submit = useStore((s) => s.submit);
  const stop = useStore((s) => s.stop);
  const assemble = useStore((s) => s.assemble);
  const templates = useStore((s) => s.templates);
  const systemPrompt = useStore((s) => s.settings.systemPrompt);
  const modelForBranch = useStore((s) => s.modelForBranch);
  const providers = useStore((s) => s.settings.providers);
  const activeProviderId = useStore((s) => s.settings.activeProviderId);

  const frame = useUI((s) => (asideId ? s.asides.find((f) => f.id === asideId) : undefined));
  const globalPending = useUI((s) => s.pending);
  const setGlobalPending = useUI((s) => s.setPending);
  const setConceptTurns = useUI((s) => s.setConceptTurns);
  const setAsidePending = useUI((s) => s.setAsidePending);
  const setAsideTurns = useUI((s) => s.setAsideTurns);
  const attachAside = useUI((s) => s.attachAside);
  const focusNonce = useUI((s) => s.composerFocusNonce);
  const key = draftKey(asideId);
  const showDraftInspector = useUI((s) => s.openInspectors.has(key));

  const pending: PendingGesture | null = asideId ? (frame?.pending ?? null) : globalPending;
  const activeLeafId = asideId ? (frame?.activeNodeId ?? null) : appActiveNodeId;

  const setPending = (next: PendingGesture | null) => {
    if (asideId) setAsidePending(asideId, next);
    else setGlobalPending(next);
  };

  const streaming = streamingNodeId !== null;

  const plan = useMemo(
    () => planSubmission({ text, pending, activeLeafId }),
    [text, pending, activeLeafId],
  );

  // The live payload for what is about to be sent. This is the promise §1 makes
  // — the user can see exactly what the model will see, before committing.
  const draftMessages = useMemo(() => {
    if (!conversationId) return [];
    return assemble(draftNode(plan, conversationId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, conversationId, nodes, templates, systemPrompt, assemble]);

  const sendable = planIsSendable(plan, pending) && !streaming && Boolean(conversationId);

  // The thread's composer answers the global focus request; an aside's answers
  // its own gesture changing, which is what docking a quote into it looks like.
  useEffect(() => {
    if (asideId) return;
    textareaRef.current?.focus();
  }, [asideId, focusNonce, globalPending]);

  useEffect(() => {
    if (!asideId) return;
    textareaRef.current?.focus();
  }, [asideId, frame?.pending]);

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

  const inheritedModel = modelForBranch(plan.parentId);
  const provider = providers.find((p) => p.id === activeProviderId);
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of [
      ...(provider?.knownModels ?? []),
      ...(provider ? [provider.model] : []),
      ...(inheritedModel ? [inheritedModel] : []),
    ]) {
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out;
  }, [provider, inheritedModel]);

  const send = () => {
    if (!sendable) return;
    void submit({
      text: plan.content,
      parentId: plan.parentId,
      policy: plan.policy,
      origin: plan.origin,
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(asideId
        ? {
            detached: true,
            // Bind on the first send — after that the aside already owns the
            // branch and only its leaf moves. Bound at commit rather than on
            // completion so the reply streams into the aside live.
            onCommitted: ({ userNodeId, assistantNodeId }) =>
              attachAside(asideId, frame?.rootNodeId ?? userNodeId, assistantNodeId),
          }
        : {}),
    });
    setText("");
    setPending(null);
    setModelOverride(null);
  };

  const gesture = pending ? GESTURE_COPY[pending.kind] : null;
  const sourceNode = pending ? nodes[pending.sourceNodeId] : undefined;
  // Inside an aside the header already says which gesture this is, in more
  // detail and next to the passage itself. Repeating it above the textarea
  // would say it twice.
  const showGestureBand = Boolean(pending && gesture && !asideId);

  return (
    <div className="composer">
      <div className="composer__inner">
        {showGestureBand && pending && gesture ? (
          <div className={`composer__gesture ${gesture.className}`}>
            <div className="gesture__main">
              <div
                className="gesture__label"
                style={{ color: `var(${BRANCH_META[branchKindForGesture(pending.kind)].cssVar})` }}
              >
                <span aria-hidden>{BRANCH_META[branchKindForGesture(pending.kind)].glyph}</span>
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
              ) : "anchor" in pending ? (
                <div className="gesture__quote">{pending.anchor.text}</div>
              ) : null}
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
            placeholder={placeholderFor(pending?.kind, activeLeafId !== null)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
              if (e.key === "Escape" && pending) {
                e.preventDefault();
                // Handled here, so the global Escape chain does not also fire
                // and close the aside (or stop a stream) on the same keypress.
                e.stopPropagation();
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
            <ContextChip nodeId={key} policy={plan.policy} messages={draftMessages} />
          ) : null}

          {pending?.kind === "concept" ? (
            <span className="stepper">
              <span>window</span>
              <span className="stepper__btns">
                <button
                  type="button"
                  aria-label="Fewer turns"
                  disabled={pending.turns <= 1}
                  onClick={() =>
                    asideId
                      ? setAsideTurns(asideId, pending.turns - 1)
                      : setConceptTurns(pending.turns - 1)
                  }
                >
                  −
                </button>
                <span className="stepper__n">{pending.turns}</span>
                <button
                  type="button"
                  aria-label="More turns"
                  disabled={pending.turns >= 5}
                  onClick={() =>
                    asideId
                      ? setAsideTurns(asideId, pending.turns + 1)
                      : setConceptTurns(pending.turns + 1)
                  }
                >
                  +
                </button>
              </span>
              <span>turn{pending.turns === 1 ? "" : "s"}</span>
            </span>
          ) : null}

          {plan.forks && !asideId ? (
            <span className="msg__branchcount">branches off the source message</span>
          ) : null}

          {modelOptions.length > 0 ? (
            <label className="modelpick" title="Model for this branch onwards">
              <span className="modelpick__label">model</span>
              <select
                className="modelpick__select"
                value={modelOverride ?? ""}
                onChange={(e) => setModelOverride(e.target.value || null)}
              >
                <option value="">
                  {inheritedModel ? `${inheritedModel} (inherited)` : "provider default"}
                </option>
                {modelOptions
                  .filter((name) => name !== inheritedModel)
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}

          {asideId ? null : (
            <span className="composer__hint">
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
            </span>
          )}
        </div>

        {showDraftInspector ? (
          <Inspector policy={plan.policy} messages={draftMessages} />
        ) : null}
      </div>
    </div>
  );
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
