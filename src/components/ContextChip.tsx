import { useMemo } from "react";
import type { ChatMessage, ContextPolicy } from "@/types";
import type { ToolUse, Usage } from "@/lib/bridgeProtocol";
import { policyLabel } from "@/lib/assembleContext";
import { POLICY_CLASS, policyExplanation } from "@/lib/policyMeta";
import { estimateMessageTokens, formatTokens } from "@/lib/tokens";
import { useUI } from "@/store/useUI";

/**
 * §1: "Because context is no longer 'obviously everything above,' the user can
 * no longer infer it. So the UI carries a hard requirement that no competitor
 * has: a context inspector."
 *
 * The chip reports the *true* assembled message count, not a friendlier number.
 * For the three policies that inline their context as prose that count is 1,
 * and the chip says so, with the inlined turn count beside it — an honest 1 is
 * worth more than a comfortable 4.
 */

interface ContextChipProps {
  nodeId: string;
  policy: ContextPolicy;
  messages: ChatMessage[];
  /** Extra detail shown between the count and the policy name. */
  detail?: string;
  /** The policy of the aside this turn is under, when it is a later turn in one. */
  start?: ContextPolicy;
}

export function ContextChip({ nodeId, policy, messages, detail, start }: ContextChipProps) {
  const open = useUI((s) => s.openInspectors.has(nodeId));
  const toggleInspector = useUI((s) => s.toggleInspector);

  const count = messages.length;
  const tokens = useMemo(() => estimateMessageTokens(messages), [messages]);

  return (
    <button
      type="button"
      className={`chip ${POLICY_CLASS[policy.kind]}`}
      aria-expanded={open}
      onClick={() => toggleInspector(nodeId)}
      title="Show the exact payload that was sent"
    >
      <span className="chip__dot" />
      <span>
        {count} message{count === 1 ? "" : "s"}
      </span>
      <span className="chip__sep">·</span>
      <span>{formatTokens(tokens)}</span>
      {detail ? (
        <>
          <span className="chip__sep">·</span>
          <span>{detail}</span>
        </>
      ) : null}
      <span className="chip__sep">·</span>
      <span>{policyLabel(policy, start)}</span>
      <span className="chip__sep">{open ? "▾" : "▸"}</span>
    </button>
  );
}

interface InspectorProps {
  policy: ContextPolicy;
  messages: ChatMessage[];
  /** When present, the historical record takes precedence over a fresh
   *  assembly (§11 Q4: the preview is what was actually sent). */
  historical?: string;
  /** Set for a reply produced through the Claude Code bridge. */
  harness?: "claude-code";
  toolUse?: ToolUse[];
  usage?: Usage;
  /** The model that answered, for a reply. */
  model?: string;
  /** The thinking effort the reply was written with, when one was chosen. */
  effort?: string;
  /** The policy of the aside this turn is under, when it is a later turn in one. */
  start?: ContextPolicy;
}

export function Inspector({ policy, messages, historical, harness, toolUse, usage, model, effort, start }: InspectorProps) {
  const shown = useMemo(
    () => (historical ? parsePayload(historical) : messages),
    [historical, messages],
  );

  return (
    <div className="inspector">
      <div className="inspector__head">
        <span className="inspector__title">Exact payload</span>
        <span className="chip__sep">·</span>
        <span>{policyLabel(policy, start)}</span>
        {historical ? (
          <>
            <span className="chip__sep">·</span>
            <span title="Recorded when the request was made, not re-derived from the current templates">
              as sent
            </span>
          </>
        ) : null}
      </div>
      <p className="inspector__note">{policyExplanation(policy, start)}</p>
      {harness === "claude-code" ? (
        <p className="inspector__note inspector__note--bridge">
          {model ? `Answered by ${model}${effort ? ` at ${effort} effort` : ""}, sent` : "Sent"} through Claude Code, which adds context of
          its own that this record cannot show: a line naming itself, its working folder,
          platform and shell, the model, today's date, your account email, and your own Claude
          Code instructions (<code>~/.claude/CLAUDE.md</code>) if you have them.
          {toolUse?.length
            ? ` While answering it also used: ${toolUse.map((t) => `${t.name} (${t.query})`).join("; ")}.`
            : " It used no tools."}
          {usage
            ? ` ${usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens} tokens in (${usage.cacheReadInputTokens} from cache), ${usage.outputTokens} out.`
            : ""}
        </p>
      ) : null}
      <div className="inspector__body">
        {shown.length === 0 ? (
          <div className="inspector__empty">Nothing was sent for this node.</div>
        ) : (
          shown.map((message, i) => (
            <div className="payload-msg" key={i}>
              <div className="payload-msg__head">
                <span className={`payload-msg__role--${message.role}`}>{message.role}</span>
                <span className="chip__sep">·</span>
                <span>{formatTokens(estimateMessageTokens([message]))}</span>
              </div>
              <pre className="payload-msg__text">{message.content}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Inverse of formatPayload(), for rendering a stored `assembledPreview`.
 *
 * DISPLAY ONLY. This produces ChatMessage-shaped values for the inspector to
 * lay out; it is not a prompt and must never be handed to a provider.
 * assembleContext() is the only thing allowed to build a payload that gets sent
 * (§12). Kept next to its use so the two stay in step.
 */
export function parsePayload(text: string): ChatMessage[] {
  if (!text.trim()) return [];
  return text
    .split("\n\n---\n\n")
    .map((block) => {
      const match = /^### (system|user|assistant)\n?/.exec(block);
      if (!match) return { role: "user" as const, content: block };
      return {
        role: match[1] as ChatMessage["role"],
        content: block.slice(match[0].length),
      };
    });
}
