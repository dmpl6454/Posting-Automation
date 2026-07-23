/**
 * Caps how many channel cards render per platform on first paint.
 *
 * Root cause of the "blank screen for minutes after reconnect, especially Meta"
 * bug: the channels page auto-expands the first platform and renders EVERY
 * channel synchronously. A Facebook account can carry hundreds of Pages
 * (one org had 387 FB channels), so hydrating/painting that list blocks the
 * main thread long enough that the post-OAuth navigation appears as a
 * minutes-long blank page in Safari. Rendering a small window first paints
 * instantly; the user opts into the rest with "Show all".
 */
export const CHANNEL_RENDER_WINDOW = 30;

/**
 * Returns the slice of a platform's channels to render, given whether the user
 * has clicked "Show all". `showAll` renders everything; otherwise the first
 * CHANNEL_RENDER_WINDOW. Selected channels are always kept visible so a
 * select-all + collapse can't hide a checked row from the bulk action.
 */
export function windowChannels<T extends { id: string }>(
  channels: T[],
  showAll: boolean,
  selectedIds?: Set<string>
): { visible: T[]; hiddenCount: number } {
  if (showAll || channels.length <= CHANNEL_RENDER_WINDOW) {
    return { visible: channels, hiddenCount: 0 };
  }
  const head = channels.slice(0, CHANNEL_RENDER_WINDOW);
  if (selectedIds && selectedIds.size > 0) {
    const shownIds = new Set(head.map((c) => c.id));
    const selectedTail = channels
      .slice(CHANNEL_RENDER_WINDOW)
      .filter((c) => selectedIds.has(c.id) && !shownIds.has(c.id));
    const visible = head.concat(selectedTail);
    return { visible, hiddenCount: channels.length - visible.length };
  }
  return { visible: head, hiddenCount: channels.length - head.length };
}
