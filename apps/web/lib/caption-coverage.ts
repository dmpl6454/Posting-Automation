/**
 * Why a non-story post cannot be published for lack of a caption, or null.
 *
 * Owner-reported 2026-09-21: "when put manual caption on each page and i dont
 * give caption in content it doesnt give me option to publish". Compose treated
 * the shared caption box as unconditionally required, with no awareness that the
 * "Different caption per channel" editor might already cover every channel.
 *
 * The rule: an EMPTY shared caption is fine as long as every selected channel
 * carries its own. The publish worker resolves
 * `contentOverride ?? contentVariants?.[platform] ?? post.content`, so with full
 * coverage the empty shared caption is never reached.
 *
 * ⚠️ Partial coverage is NOT enough. One uncovered channel falls through to the
 * empty shared caption and publishes blank text — and on Reddit/Medium/dev.to the
 * caption also supplies the post TITLE, where empty is a hard API rejection.
 *
 * ⚠️ Mirrors everyChannelHasOwnCaption() in packages/api/src/lib/caption-overrides.ts.
 * If these two disagree the button enables and post.create then refuses, which is
 * the exact failure this fix exists to remove.
 *
 * Returns a reason string (shown in the toast and the button tooltip) rather than
 * a boolean, so the gate and the message can never drift apart — the same shape
 * as storyBlockReason().
 */
export function captionBlockReason(args: {
  content: string;
  customCaptions: boolean;
  selectedChannels: string[];
  captionOverrides: Record<string, string>;
}): string | null {
  if (args.content.trim().length > 0) return null;

  // No per-channel editor in play ⇒ the shared caption is the only caption.
  if (!args.customCaptions || args.selectedChannels.length === 0) {
    return "Add a caption.";
  }

  const uncovered = args.selectedChannels.filter(
    (id) => (args.captionOverrides[id] ?? "").trim().length === 0
  );
  if (uncovered.length === 0) return null;

  return uncovered.length === args.selectedChannels.length
    ? "Add a caption — either a shared one, or a caption for every selected channel."
    : `${uncovered.length} of ${args.selectedChannels.length} channels still have no caption. Fill those in, or write a shared caption.`;
}
