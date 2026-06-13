/**
 * Single source of truth for the "this platform needs an image/video" rule.
 *
 * Instagram and Facebook reject text-only posts (Instagram has no draft/text
 * post type at all; the FB Pages publish path used here posts to /photos or
 * /videos). The publish worker can auto-generate an AI image when AI is on, so
 * the schedule-time block only fires when AI generation is OFF *and* no media is
 * attached — i.e. a post that can NEVER succeed. Pure + dependency-free so it is
 * callable from both tRPC routers and unit tests.
 */
export const MEDIA_REQUIRED_PLATFORMS = new Set<string>(["INSTAGRAM", "FACEBOOK"]);

const PLATFORM_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};

/**
 * Returns a human-readable block reason if the post can never be published, else
 * null. A post is doomed when it targets a media-required platform, has no media
 * attached, and AI image generation is off (so the worker can't fill the gap).
 */
export function mediaRequiredBlock(opts: {
  platforms: string[];
  hasMedia: boolean;
  aiEnabled: boolean;
}): string | null {
  if (opts.hasMedia || opts.aiEnabled) return null;

  const blocked = [
    ...new Set(
      (opts.platforms || [])
        .map((p) => (p || "").toUpperCase())
        .filter((p) => MEDIA_REQUIRED_PLATFORMS.has(p))
    ),
  ];
  if (blocked.length === 0) return null;

  const names = blocked.map((p) => PLATFORM_LABEL[p] ?? p).join(" and ");
  return `${names} require${blocked.length === 1 ? "s" : ""} an image or video to publish. Attach media or turn on AI image generation, then try again.`;
}
