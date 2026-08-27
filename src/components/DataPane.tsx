import { useRef, useState } from "react";
import { useStore } from "@/store/useStore";
import { bundleFilename } from "@/lib/transfer";

/**
 * §8 P3: "JSON export/import (full tree fidelity — this is the user's data and
 * it must be extractable)."
 *
 * Extractable in the sense that matters: every parentId, anchor offset and
 * contextPolicy survives, so a re-import reconstructs both graphs and every
 * node's payload comes out identical. API keys are never written to the file.
 */
export function DataPane() {
  const fileRef = useRef<HTMLInputElement>(null);
  const exportAll = useStore((s) => s.exportAll);
  const exportConversation = useStore((s) => s.exportConversation);
  const importBundle = useStore((s) => s.importBundle);
  const conversationId = useStore((s) => s.conversationId);
  const conversationCount = useStore((s) => s.conversations.length);

  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const download = async (getText: () => Promise<string>) => {
    try {
      const text = await getText();
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = bundleFilename();
      link.click();
      URL.revokeObjectURL(url);
      setStatus({ kind: "ok", text: `Exported ${(text.length / 1024).toFixed(1)} kB.` });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const onFile = async (file: File) => {
    try {
      const result = await importBundle(await file.text());
      setStatus({
        kind: "ok",
        text: `Imported ${result.conversations} conversation${
          result.conversations === 1 ? "" : "s"
        } and ${result.nodes} nodes.${
          result.remapped
            ? " Ids collided with existing data, so the whole import was given fresh ones — the tree shape is unchanged."
            : ""
        }`,
      });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <>
      <p className="pane__note">
        An export carries the full tree: every parent pointer, every anchor
        offset, every context policy. Re-importing reconstructs the same two
        graphs, so each node's payload comes back identical. Provider keys are
        never written to the file.
      </p>

      <div className="pane__row">
        <button
          type="button"
          className="btn"
          disabled={!conversationId}
          onClick={() => void download(() => exportConversation(conversationId!))}
        >
          Export this conversation
        </button>
        <button
          type="button"
          className="btn"
          disabled={conversationCount === 0}
          onClick={() => void download(exportAll)}
        >
          Export everything
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          Import…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void onFile(file);
          }}
        />
      </div>

      {status ? (
        <p
          className={status.kind === "error" ? "tmpl__warn" : "field__hint"}
          role="status"
        >
          {status.text}
        </p>
      ) : null}
    </>
  );
}
