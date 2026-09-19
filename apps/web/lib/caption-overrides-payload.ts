/**
 * Build the `captionOverrides` map (channelId → caption) that post.create expects
 * from Compose's per-channel caption editor.
 *
 * Only captions for channels that are STILL selected are sent — the editor's map
 * is never pruned when a channel is deselected, so a stale entry would otherwise
 * ride along and be rejected (or, worse, silently ignored) server-side. Blank
 * captions and captions identical to the shared one are dropped: both mean "use
 * the shared caption", and the server applies the same rule
 * (sanitizeCaptionOverrides), so what the UI shows as "custom" is exactly what is
 * stored.
 *
 * Returns an empty object when nothing is custom — the caller then omits the key
 * entirely, so an ordinary post's payload is byte-identical to before.
 */
export function buildCaptionOverridesPayload(
  overrides: Record<string, string>,
  selectedChannelIds: string[],
  sharedContent: string
): Record<string, string> {
  const shared = sharedContent.trim();
  const out: Record<string, string> = {};
  for (const id of selectedChannelIds) {
    const caption = overrides[id];
    if (typeof caption !== "string") continue;
    const trimmed = caption.trim();
    if (trimmed.length === 0 || trimmed === shared) continue;
    out[id] = caption;
  }
  return out;
}

/**
 * Re-validate a restored draft's override map. A draft persisted by an older
 * build or hand-edited localStorage must never inject a non-string value into
 * post.create and 400 the whole post — malformed entries are dropped, not fatal.
 */
export function sanitizeRestoredCaptionOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, caption] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id === "string" && id && typeof caption === "string" && caption.trim().length > 0) {
      out[id] = caption;
    }
  }
  return out;
}
