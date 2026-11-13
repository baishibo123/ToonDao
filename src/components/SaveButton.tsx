import { useEffect, useRef, useState } from "react";
import { saveFile } from "@/lib/fileOut";

/**
 * A small "save" that hands a file to the browser's download (P-53). Like the
 * copy beside it, it is a control inside a reply, not text: `.savebtn` is
 * ignored by the reading moves and left out of a formatted copy.
 */
export function SaveButton({
  name,
  data,
  type,
  label = "save",
  title,
  className = "",
}: {
  name: string | (() => string);
  /** Read when pressed, so a reply still streaming saves what it has now. */
  data: () => string | Blob;
  type?: string;
  label?: string;
  title: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className={`savebtn ${className}`.trim()}
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        saveFile(typeof name === "function" ? name() : name, data(), type);
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "✓ saved" : label}
    </button>
  );
}
