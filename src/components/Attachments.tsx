import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Attachment } from "@/types";
import { attachmentUrl, formatBytes } from "@/lib/attachments";

/**
 * Files attached to a question (P-43), as chips: a thumbnail for an image, a
 * tag for a PDF or a text file. In the composer each can be removed; on a sent
 * message an image opens larger.
 */
export function AttachmentChips({
  files,
  onRemove,
}: {
  files: readonly Attachment[];
  /** Given in the composer; absent on a sent message. */
  onRemove?: (id: string) => void;
}) {
  const [open, setOpen] = useState<Attachment | null>(null);
  if (files.length === 0) return null;
  return (
    <div className={`files${onRemove ? " files--draft" : ""}`}>
      {files.map((file) => (
        <span key={file.id} className={`file file--${file.kind}`} title={describe(file)}>
          {file.kind === "image" ? (
            <button
              type="button"
              className="file__thumb"
              onClick={() => setOpen(file)}
              aria-label={`Show ${file.name}`}
            >
              <img src={attachmentUrl(file)} alt="" />
            </button>
          ) : (
            <span className="file__tag" aria-hidden>
              {file.kind === "pdf" ? "PDF" : "TXT"}
            </span>
          )}
          {file.kind === "image" ? null : (
            <span className="file__text">
              <span className="file__name">{file.name}</span>
              <span className="file__size">{detail(file)}</span>
            </span>
          )}
          {onRemove ? (
            <button
              type="button"
              className="file__remove"
              onClick={() => onRemove(file.id)}
              aria-label={`Remove ${file.name}`}
              title="Remove"
            >
              ✕
            </button>
          ) : null}
        </span>
      ))}
      {open ? <Lightbox file={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function detail(file: Attachment): string {
  if (file.kind === "pdf" && file.pages) return `${file.pages} p · ${formatBytes(file.bytes)}`;
  return formatBytes(file.bytes);
}

function describe(file: Attachment): string {
  const size = file.width && file.height ? `${file.width}×${file.height}, ` : "";
  return `${file.name} (${size}${detail(file)})`;
}

function Lightbox({ file, onClose }: { file: Attachment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape here closes the picture, not the aside or the stream behind it.
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal lightbox" role="dialog" aria-modal="true" aria-label={file.name} onClick={onClose}>
      <img className="lightbox__img" src={attachmentUrl(file)} alt={file.name} />
      <span className="lightbox__caption">{describe(file)}</span>
    </div>,
    document.body,
  );
}
