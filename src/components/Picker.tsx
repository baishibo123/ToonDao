import type { ReactNode } from "react";

/**
 * One of the per-branch choices under the message box — model, pace, effort.
 *
 * A pill that shows the label and the value in effect, with the native select
 * laid over it, invisible, so the whole pill opens it and keyboard and screen
 * readers get a real select. `set` marks a value chosen on this message rather
 * than inherited from the branch: that is the one thing worth colour, because it
 * is what this send will change.
 */
export function Picker({
  label,
  shown,
  set,
  title,
  value,
  onChange,
  children,
}: {
  label: string;
  /** What the closed pill reads: the value in effect, without "(inherited)". */
  shown: string;
  set: boolean;
  title: string;
  value: string;
  onChange: (value: string) => void;
  /** The `<option>`s. */
  children: ReactNode;
}) {
  return (
    <label className={`picker${set ? " picker--set" : ""}`} title={title}>
      <span className="picker__label">{label}</span>
      <span className="picker__value">{shown}</span>
      <svg className="picker__caret" viewBox="0 0 10 6" aria-hidden>
        <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        className="picker__select"
        aria-label={`${label}: ${shown}${set ? ", set on this message" : ", inherited"}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
