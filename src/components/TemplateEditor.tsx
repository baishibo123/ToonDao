import { useMemo, useState } from "react";
import { useStore } from "@/store/useStore";
import { DEFAULT_TEMPLATES, TEMPLATE_META, renderTemplate } from "@/lib/templates";
import type { TemplateId } from "@/types";

const IDS: TemplateId[] = [
  "concept_lens",
  "structural_crop",
  "isolated_selection",
  "quote_reply",
];

/**
 * §4: templates are user-editable, stored in IndexedDB, seeded with the
 * defaults. Never hardcoded at a call site.
 *
 * The editor warns when an edit drops a variable the gesture depends on, since
 * a template missing `{{concept}}` silently sends a prompt with no question in
 * it. It warns rather than blocks: it is the user's template.
 */
export function TemplateEditor() {
  const templates = useStore((s) => s.templates);
  const updateTemplate = useStore((s) => s.updateTemplate);
  const resetTemplate = useStore((s) => s.resetTemplate);
  const [open, setOpen] = useState<TemplateId>("concept_lens");

  const body = templates[open];
  const meta = TEMPLATE_META[open];
  const missing = useMemo(
    () => meta.vars.filter((name) => !body.includes(`{{${name}}}`)),
    [body, meta.vars],
  );
  const isDefault = body === DEFAULT_TEMPLATES[open];

  return (
    <div className="tmpl">
      <div className="tmpl__tabs" role="tablist">
        {IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === open}
            className={`tmpl__tab${id === open ? " tmpl__tab--on" : ""}`}
            onClick={() => setOpen(id)}
          >
            {TEMPLATE_META[id].label}
            {templates[id] === DEFAULT_TEMPLATES[id] ? null : (
              <span className="tmpl__dot" title="Edited" />
            )}
          </button>
        ))}
      </div>

      <p className="field__hint tmpl__note">{meta.note}</p>

      <div className="tmpl__vars">
        {meta.vars.map((name) => (
          <button
            key={name}
            type="button"
            className={`tmpl__var${body.includes(`{{${name}}}`) ? "" : " tmpl__var--missing"}`}
            title={`Insert {{${name}}}`}
            onClick={() => void updateTemplate(open, `${body}\n\n{{${name}}}`)}
          >
            {`{{${name}}}`}
          </button>
        ))}
      </div>

      {missing.length > 0 ? (
        <p className="tmpl__warn" role="status">
          {missing.map((n) => `{{${n}}}`).join(" and ")}{" "}
          {missing.length === 1 ? "is" : "are"} no longer in this template, so that
          content will not reach the model. Click the chip above to put it back.
        </p>
      ) : null}

      <textarea
        className="input input--area input--mono tmpl__body"
        rows={12}
        value={body}
        spellCheck={false}
        aria-label={`${meta.label} template`}
        onChange={(e) => void updateTemplate(open, e.target.value)}
      />

      <div className="tmpl__foot">
        <button
          type="button"
          className="btn btn--sm"
          disabled={isDefault}
          onClick={() => void resetTemplate(open)}
        >
          Reset to default
        </button>
        <span className="field__hint">
          Existing nodes keep the payload they were sent with. Edits apply to new
          nodes only.
        </span>
      </div>

      <details className="tmpl__preview">
        <summary>Preview with placeholder values</summary>
        <pre className="payload-msg__text">
          {renderTemplate(
            body,
            Object.fromEntries(meta.vars.map((name) => [name, SAMPLES[name] ?? `‹${name}›`])),
          )}
        </pre>
      </details>
    </div>
  );
}

const SAMPLES: Record<string, string> = {
  context_turns: "User: why does the gradient vanish?\n\nAssistant: because each layer multiplies by a factor below one.",
  concept: "`vanishing gradient`",
  truncated_context:
    "User: explain the proof\n\nAssistant: We start from the lemma. The second step is where",
  selection: "the map is not the territory",
  quote: "> the map is not the territory",
  message: "but whose map?",
};
