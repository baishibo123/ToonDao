/**
 * Which conversation this browser tab has open, kept in `sessionStorage`: it
 * survives the tab's own reloads (a sleep, a discarded tab, the dev server
 * reconnecting) and is the tab's alone, so two tabs reloaded at once each
 * reopen their own conversation rather than both the one used last.
 *
 * Storage can be refused (a private window, blocked site data); then a reload
 * falls back to the conversation whose view was written last.
 */
const KEY = "toondao.openConversation";

export function tabConversation(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberTabConversation(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // Not kept; a reload falls back to `lastOpened()`'s newest view.
  }
}
