import { useMemo } from "react";
import type { ChatMessage, ContextPolicy, ConversationNode } from "@/types";
import { policyLabel } from "@/lib/assembleContext";
import { POLICY_CLASS, policyExplanation } from "@/lib/policyMeta";
import { estimateMessageTokens, formatTokens } from "@/lib/tokens";
import { useStore } from "@/store/useStore";
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
}

export function ContextChip({ nodeId, policy, messages, detail }: ContextChipProps) {
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
      <span>{policyLabel(policy)}</span>
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
}

export function Inspector({ policy, messages, historical }: InspectorProps) {
  const shown = useMemo(
    () => (historical ? parsePayload(historical) : messages),
    [historical, messages],
  );

  return (
    <div className="inspector">
      <div className="inspector__head">
        <span className="inspector__title">Exact payload</span>
        <span className="chip__sep">·</span>
        <span>{policyLabel(policy)}</span>
        {historical ? (
          <>
            <span className="chip__sep">·</span>
            <span title="Recorded when the request was made, not re-derived from the current templates">
              as sent
            </span>
          </>
        ) : null}
      </div>
      <p className="inspector__note">{policyExplanation(policy)}</p>
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

/** Inverse of formatPayload(). Kept next to its use so the two stay in step. */
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

/** The composer's live chip: assembles a hypothetical node so the user can see
 *  the payload *before* sending it. */
export function useHypotheticalPayload(node: ConversationNode | null): ChatMessage[] {
  const assemble = useStore((s) => s.assemble);
  const nodes = useStore((s) => s.nodes);
  const templates = useStore((s) => s.templates);
  const systemPrompt = useStore((s) => s.settings.systemPrompt);

  return useMemo(() => {
    if (!node) return [];
    return assemble(node);
    // nodes/templates/systemPrompt are the inputs assemble() reads; listing them
    // keeps the chip live as the user edits a template or types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, nodes, templates, systemPrompt, assemble]);
}
