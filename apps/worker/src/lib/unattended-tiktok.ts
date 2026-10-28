/**
 * Producers that create posts with nobody at the keyboard (RSS auto-post today;
 * autopilot and agents already skip TikTok via autopilot-platforms.ts) must
 * never create a TikTok target (2026-10-28). A TikTok post needs one video and
 * the creator's own choices — who can see it, interactions, disclosure — which
 * TikTok's guidelines say the user must pick, and which only Compose collects.
 * No screen can add them to an existing post, so such a target could never be
 * published; it would only fail.
 */
export function withoutTikTokChannels(
  ids: string[],
  channels: Array<{ id: string; platform: string }>
): { ids: string[]; droppedTikTok: number } {
  const tiktok = new Set(channels.filter((c) => c.platform === "TIKTOK").map((c) => c.id));
  const kept = ids.filter((id) => !tiktok.has(id));
  return { ids: kept, droppedTikTok: ids.length - kept.length };
}
