import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { draftKey, useUI, type PendingGesture } from "@/store/useUI";
import { draftNode, planIsSendable, planSubmission } from "@/lib/draft";
import { contextStart } from "@/lib/assembleContext";
import { nodeStoreFromMap } from "@/types";
import { ContextChip, Inspector } from "@/components/ContextChip";
import { Picker } from "@/components/Picker";
import { BRANCH_META } from "@/lib/policyMeta";
import { useSurface } from "@/components/Surface";
import { findParked } from "@/lib/later";
import { EFFORTS, type Effort, type RateLimit } from "@/lib/bridgeProtocol";
import { ATTACHMENT_LIMITS, prepareAttachment } from "@/lib/attachments";
import { AttachmentChips } from "@/components/Attachments";
import type { Attachment } from "@/types";

/**
 * The one gesture that docks into a composer rather than opening an aside: a
 * quote reply continues the conversation it was made in, so it waits here,
 * above the box, until it is sent or dropped.
 */
const QUOTE_COPY = {
  label: "Replying to",
  hint: "Quoted above your message, in this conversation.",
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
  const [effortOverride, setEffortOverride] = useState<Effort | null>(null);
  const [pacingOverride, setPacingOverride] = useState<boolean | null>(null);
  /** Files for this question (P-43), already read into what will be sent. */
  const [files, setFiles] = useState<Attachment[]>([]);
  /** Why a file was not added; shown until the next add or send. */
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const conversationId = useStore((s) => s.conversationId);
  const appActiveNodeId = useStore((s) => s.activeNodeId);
  const nodes = useStore((s) => s.nodes);
  const streamingNodeId = useStore((s) => s.streamingNodeId);
  const submit = useStore((s) => s.submit);
  const stop = useStore((s) => s.stop);
  const assemble = useStore((s) => s.assemble);
  const templates = useStore((s) => s.templates);
  const systemPrompt = useStore((s) => s.settings.systemPrompt);
  const pacing = useStore((s) => s.settings.pacing);
  const modelForBranch = useStore((s) => s.modelForBranch);
  const effortForBranch = useStore((s) => s.effortForBranch);
  const pacingForBranch = useStore((s) => s.pacingForBranch);
  const conversations = useStore((s) => s.conversations);
  const providers = useStore((s) => s.settings.providers);
  const activeProviderId = useStore((s) => s.settings.activeProviderId);
  const later = useStore((s) => s.conversations.find((c) => c.id === s.conversationId)?.later);
  const rateLimit = useStore((s) => s.rateLimit);
  const unpark = useStore((s) => s.unpark);

  const frame = useUI((s) => (asideId ? s.asides.find((f) => f.id === asideId) : undefined));
  const globalPending = useUI((s) => s.pending);
  const setGlobalPending = useUI((s) => s.setPending);
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
    const draft = {
      ...draftNode(plan, conversationId),
      ...(files.length ? { attachments: files } : {}),
    };
    return assemble(pacingOverride === null ? draft : { ...draft, pacing: pacingOverride });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, conversationId, nodes, templates, systemPrompt, pacing, pacingOverride, conversations, assemble, files]);

  // A later turn in an aside carries the aside, not the thread, and the chip
  // names it by the move that opened the aside.
  const start = useMemo(
    () =>
      conversationId
        ? contextStart(draftNode(plan, conversationId), nodeStoreFromMap(nodes))?.contextPolicy
        : undefined,
    [plan, conversationId, nodes],
  );

  // An aside with neither a gesture nor a first message has nothing to attach
  // a message to — sending would start a stray root — so it cannot send.
  const attached = asideId ? Boolean(frame?.pending || frame?.rootNodeId) : true;
  // A file is a question by itself ("what is this?").
  const sendable =
    (planIsSendable(plan, pending) || files.length > 0) && !streaming && Boolean(conversationId) && attached;

  const addFiles = async (picked: readonly File[]) => {
    if (picked.length === 0) return;
    const room = ATTACHMENT_LIMITS.perMessage - files.length;
    const results = await Promise.all(picked.slice(0, Math.max(0, room)).map(prepareAttachment));
    const added = results.filter((r): r is Attachment => !("refused" in r));
    const refusals = results.flatMap((r) => ("refused" in r ? [r.refused] : []));
    if (picked.length > room) refusals.push(`A message can carry at most ${ATTACHMENT_LIMITS.perMessage} files.`);
    setFiles((current) => [...current, ...added].slice(0, ATTACHMENT_LIMITS.perMessage));
    setFileNotice(refusals.length ? refusals.join(" ") : null);
    textareaRef.current?.focus();
  };

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
  const inheritedEffort = effortForBranch(plan.parentId);
  const inheritedPacing = pacingForBranch(plan.parentId);
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
    // Asking anything about a parked passage takes it off the Later list. The
    // list is what is still owed; this is the paying of it.
    const settled =
      pending && "anchor" in pending
        ? findParked(later ?? [], pending.sourceNodeId, pending.anchor)
        : undefined;
    if (settled) void unpark(settled.id);
    void submit({
      text: plan.content,
      parentId: plan.parentId,
      policy: plan.policy,
      origin: plan.origin,
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(effortOverride && provider?.kind === "claude-code" ? { effort: effortOverride } : {}),
      ...(pacingOverride !== null ? { pacing: pacingOverride } : {}),
      ...(files.length ? { attachments: files } : {}),
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
    setEffortOverride(null);
    setPacingOverride(null);
    setFiles([]);
    setFileNotice(null);
  };

  /**
   * An aside is *defined* by the gesture that opened it: until its first send,
   * that gesture is the whole of what it is, and its header already says so. So
   * only a quote gets a band above the box — in either surface — and only a
   * quote can be dropped from here. Dropping an aside's own gesture would leave
   * an aside about nothing, whose next message would become a stray root.
   */
  const quote = pending?.kind === "quote" ? pending : null;

  return (
    <div
      className={`composer${dragging ? " composer--dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="composer__inner">
        {quote ? (
          <div className="composer__gesture composer__gesture--quote">
            <div className="gesture__main">
              <div
                className="gesture__label"
                style={{ color: `var(${BRANCH_META["quote-reply"].cssVar})` }}
              >
                <span aria-hidden>{BRANCH_META["quote-reply"].glyph}</span>
                {QUOTE_COPY.label}
              </div>
              <div className="gesture__quote">{quote.anchor.text}</div>
              <div className="gesture__hint">{QUOTE_COPY.hint}</div>
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
          <AttachmentChips files={files} onRemove={(id) => setFiles((current) => current.filter((f) => f.id !== id))} />
          <div className="composer__row">
            <button
              type="button"
              className="composer__attach"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images, PDFs or text files — or paste or drop them here"
              aria-label="Attach files"
            >
              <svg viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M10.5 4.5 5.6 9.4a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.4-4.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <textarea
              ref={textareaRef}
              className="composer__input"
              rows={1}
              value={text}
              placeholder={placeholderFor(pending?.kind, activeLeafId !== null)}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                // A screenshot or a copied image arrives as a file with no text;
                // a paste that also has text (a document copies a picture of
                // itself too) stays a text paste.
                const pasted = [...e.clipboardData.files];
                if (pasted.length === 0 || e.clipboardData.getData("text/plain")) return;
                e.preventDefault();
                void addFiles(pasted);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
                if (e.key === "Escape" && quote) {
                  e.preventDefault();
                  // Handled here, so the global Escape chain does not also fire
                  // and close the aside (or stop a stream) on the same keypress.
                  // Any other gesture lets Escape through: backing out of an
                  // aside is how its gesture is dropped.
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
        </div>

        {fileNotice ? (
          <p className="composer__notice" role="status">
            {fileNotice}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFileNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </p>
        ) : null}

        <div className="composer__foot">
          {/*
            The payload is shown only where it differs from the page. In the
            thread, an ordinary message carries exactly the conversation above
            it, so there is nothing to show until a quote is added. An aside
            always carries something that is not on its page — a window of the
            thread, a cut answer, or nothing at all — so it always says what.
          */}
          {conversationId && (asideId || quote) ? (
            <ContextChip nodeId={key} policy={plan.policy} messages={draftMessages} start={start} />
          ) : null}

          {pending?.kind === "concept" ? (
            <span className="stepper">
              <span>window</span>
              <span className="stepper__btns">
                <button
                  type="button"
                  aria-label="Fewer turns"
                  disabled={pending.turns <= 1}
                  onClick={() => asideId && setAsideTurns(asideId, pending.turns - 1)}
                >
                  −
                </button>
                <span className="stepper__n">{pending.turns}</span>
                <button
                  type="button"
                  aria-label="More turns"
                  disabled={pending.turns >= 5}
                  onClick={() => asideId && setAsideTurns(asideId, pending.turns + 1)}
                >
                  +
                </button>
              </span>
              <span>turn{pending.turns === 1 ? "" : "s"}</span>
            </span>
          ) : null}

          {provider?.kind === "claude-code" && rateLimit ? <UsageWindow rateLimit={rateLimit} /> : null}

          <div className="composer__pickers">
            {modelOptions.length > 0 ? (
              <Picker
                label="model"
                shown={modelOverride ?? inheritedModel ?? "default"}
                set={modelOverride !== null}
                title="Model for this branch onwards"
                value={modelOverride ?? ""}
                onChange={(v) => setModelOverride(v || null)}
              >
                <option value="">
                  {inheritedModel ? `${inheritedModel} · inherited` : "provider default"}
                </option>
                {modelOptions
                  .filter((name) => name !== inheritedModel)
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </Picker>
            ) : null}

            {/* P-37: switched here, it holds for this branch onwards, asides included. */}
            <Picker
              label="pace"
              shown={(pacingOverride ?? inheritedPacing) ? "on" : "off"}
              set={pacingOverride !== null}
              title="Pace answers for this branch onwards: one idea at a time, ending at a checkpoint"
              value={pacingOverride === null ? "" : pacingOverride ? "on" : "off"}
              onChange={(v) => setPacingOverride(v === "" ? null : v === "on")}
            >
              <option value="">{inheritedPacing ? "on" : "off"} · inherited</option>
              <option value={inheritedPacing ? "off" : "on"}>{inheritedPacing ? "off" : "on"}</option>
            </Picker>

            {/* P-36: Claude Code only; chosen here, it holds for this branch onwards, like the model. */}
            {provider?.kind === "claude-code" ? (
              <Picker
                label="effort"
                shown={effortOverride ?? inheritedEffort ?? "default"}
                set={effortOverride !== null}
                title="Thinking effort for this branch onwards (Claude Code's default when unset)"
                value={effortOverride ?? ""}
                onChange={(v) => setEffortOverride((v || null) as Effort | null)}
              >
                <option value="">
                  {inheritedEffort ? `${inheritedEffort} · inherited` : "Claude Code default"}
                </option>
                {EFFORTS.filter((level) => level !== inheritedEffort).map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Picker>
            ) : null}
          </div>
        </div>

        {showDraftInspector ? (
          <Inspector policy={plan.policy} messages={draftMessages} start={start} />
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

/**
 * How much of the subscription's usage window is spent. Shown because the window
 * is shared with everything else the account does — a long reading session here
 * can lock the same account out of Claude Code until it resets.
 */
function UsageWindow({ rateLimit }: { rateLimit: RateLimit }) {
  const percent =
    rateLimit.utilization === null ? null : Math.round(rateLimit.utilization * 100);
  const resets = rateLimit.resetsAt
    ? new Date(rateLimit.resetsAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const tone =
    rateLimit.status === "rejected" ? "danger" : rateLimit.status === "allowed_warning" ? "warn" : "ok";
  const window = rateLimit.window === "five_hour" ? "5h" : rateLimit.window || "usage";
  return (
    <span
      className={`usagewin usagewin--${tone}`}
      title={`Claude Code usage window${resets ? `, resets at ${resets}` : ""}. Shared with your other Claude Code use.`}
    >
      {window} {percent === null ? rateLimit.status : `${percent}%`}
    </span>
  );
}
