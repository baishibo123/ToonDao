import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * A small "copy" that says ✓ for a moment once it has worked. Inside a reply it
 * is a control, not text: it cannot be selected into a quote, and the reading
 * moves ignore a press on it (`.copybtn` in `useSelectionWatcher`).
 */
export function CopyButton({
  text,
  html,
  label = "copy",
  title = "Copy",
  className = "",
}: {
  /** Read when pressed, so a reply still streaming copies what it has now. */
  text: string | (() => string);
  html?: () => string | undefined;
  label?: string;
  title?: string;
  className?: string;
}) {
  const [done, setDone] = useState<"ok" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className={`copybtn ${className}`.trim()}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={async (e) => {
        e.stopPropagation();
        const ok = await copyToClipboard(typeof text === "function" ? text() : text, html?.());
        setDone(ok ? "ok" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(null), 1500);
      }}
    >
      {done === "ok" ? "✓ copied" : done === "failed" ? "not copied" : label}
    </button>
  );
}
