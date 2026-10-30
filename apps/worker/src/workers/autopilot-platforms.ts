/**
 * Which channels an UNATTENDED producer (autopilot content-generate, agent-run)
 * must not create a target for. Both produce one generated IMAGE per post, with
 * nobody at the keyboard.
 *
 *  - YOUTUBE posts video only, so an image target always fails at publish time.
 *  - TIKTOK (2026-10-28) posts video only too, AND TikTok's Content Sharing
 *    Guidelines require the creator to choose each post's visibility and
 *    interactions themselves — there is no default the product may pick, so a
 *    TikTok target without the creator's own choices is refused at publish.
 *
 * Returns the reason for the log, or null when the channel is fine.
 */
export function autopilotSkipReason(platform: string): string | null {
  switch (platform) {
    case "YOUTUBE":
      return "autopilot produces images, not video";
    case "TIKTOK":
      return "autopilot produces images, and TikTok posts video only, with the creator's own visibility and interaction choices";
    default:
      return null;
  }
}
