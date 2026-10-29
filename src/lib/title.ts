/**
 * A conversation's title, as a model's reply to the `title` template becomes
 * one (P-34): the first line, without the quotes, label or full stop a model
 * tends to add anyway, and short enough for the sidebar.
 */
export const TITLE_MAX = 60;

export function cleanTitle(reply: string): string {
  const line =
    reply
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const bare = line
    .replace(/^(title|标题)\s*[:：]\s*/i, "")
    .replace(/^[#*\s]+|[*\s]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  return bare.length > TITLE_MAX ? `${bare.slice(0, TITLE_MAX - 1)}…` : bare;
}
