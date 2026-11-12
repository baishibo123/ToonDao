/**
 * Copying out of a reply. A block copies its source — the code without its
 * fence, a formula as its TeX, a table as its Markdown — because that is what
 * gets pasted somewhere that runs or renders it. A whole reply copies both:
 * the Markdown as plain text, for an editor or another chat, and the rendered
 * reply as HTML, for a document, so each paste takes the form it can use.
 */

/** Puts `text` (and `html`, where the browser allows both) on the clipboard. */
export async function copyToClipboard(text: string, html?: string): Promise<boolean> {
  try {
    if (html && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some embedded browsers refuse the Clipboard API outright; the older copy
    // command still runs inside the click that asked for it, with both forms.
    return copyByCommand(text, html);
  }
}

function copyByCommand(text: string, html?: string): boolean {
  const fill = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    if (html) e.clipboardData?.setData("text/html", html);
    e.preventDefault();
  };
  document.addEventListener("copy", fill);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", fill);
  }
}

/**
 * A rendered reply as HTML another program can paste: the page's own controls
 * (copy buttons, a code block's language tag, a drawing's source disclosure)
 * and the attributes the reading moves use are taken out, and a formula keeps
 * only its MathML, which word processors turn into an equation. KaTeX's
 * visual markup depends on stylesheets the other program does not have.
 */
export function pastableHtml(rendered: Element): string {
  const copy = rendered.cloneNode(true) as Element;
  for (const el of copy.querySelectorAll(".copybtn, .md-code-lang, .md-svg__source, .katex-html")) el.remove();
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    for (const name of el.getAttributeNames()) {
      if (name.startsWith("data-") || name === "class" || name === "style" || name === "aria-hidden") {
        el.removeAttribute(name);
      }
    }
  }
  // The spans the renderer adds to find text again carry nothing now.
  for (const span of [...copy.querySelectorAll("span")].reverse()) {
    if (span.attributes.length === 0) span.replaceWith(...span.childNodes);
  }
  return copy.innerHTML;
}
