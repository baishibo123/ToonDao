import { useMemo } from "react";
import { useStore } from "@/store/useStore";
import { explainParked } from "@/store/focusNode";
import { LATER_META } from "@/lib/policyMeta";
import { pathToRoot, turnNumbers } from "@/lib/tree";
import { plainText } from "@/lib/plainText";

/**
 * What is still owed: the open conversation's parked passages, oldest first.
 *
 * Kept in view rather than behind a menu, because a queue nobody looks at is a
 * graveyard. Each row does one of two things — explain it now, or let it go —
 * and asking about a passage any other way clears it too, so the list only ever
 * holds what has genuinely not been dealt with.
 */
export function LaterList() {
  const later = useStore((s) => s.conversations.find((c) => c.id === s.conversationId)?.later);
  const nodes = useStore((s) => s.nodes);
  const unpark = useStore((s) => s.unpark);

  const rows = useMemo(
    () =>
      (later ?? []).map((item) => ({
        item,
        turn: nodes[item.sourceNodeId]
          ? (turnNumbers(pathToRoot(nodes, item.sourceNodeId)).get(item.sourceNodeId) ?? null)
          : null,
      })),
    [later, nodes],
  );

  if (rows.length === 0) return null;

  return (
    <section
      className="later"
      aria-label="Later"
      style={{ ["--kind" as string]: `var(${LATER_META.cssVar})` }}
    >
      <h2 className="later__head" title={LATER_META.blurb}>
        <span className="later__glyph" aria-hidden>
          {LATER_META.glyph}
        </span>
        {LATER_META.label}
        <span className="later__count">{rows.length}</span>
      </h2>
      <ul className="later__list">
        {rows.map(({ item, turn }) => (
          <li key={item.id} className="later__item">
            <button
              type="button"
              className="later__open"
              onClick={() => explainParked(item)}
              title={`Explain it now: “${item.anchor.text}”`}
            >
              <span className="later__text">{flatten(plainText(item.anchor.text))}</span>
              {turn ? <span className="later__where">turn {turn}</span> : null}
            </button>
            <button
              type="button"
              className="later__drop"
              onClick={() => void unpark(item.id)}
              title="Let it go"
              aria-label={`Remove “${item.anchor.text}” from Later`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
