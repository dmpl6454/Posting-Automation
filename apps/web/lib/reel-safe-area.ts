/**
 * Pure geometry + copy for the Compose sidebar's REEL preview (2026-10-03).
 *
 * Owner ask: "in preview show reel safe area and show super text in sidebar
 * preview". Two things the Instagram card could not show before: where
 * Instagram's own UI (caption, username, audio pill, the action column) sits
 * over a reel, and the super-text strip the worker will burn/compose.
 *
 * No React here — the maths and the labels are unit-tested on their own.
 */
import type { SuperTextConfig } from "@postautomation/super-text";

/**
 * Meta's published safe zone for Facebook AND Instagram Reels: keep key
 * elements out of the top 14%, the bottom 35% and 6% on each side of the
 * frame, or the profile icon, caption and call-to-action may cover them.
 * Source: https://www.facebook.com/business/help/980593475366490/
 *
 * ⚠️ These are Meta's figures for the FULL 9:16 screen, not for the video's
 * own frame — the reel viewer's UI is laid out over the screen, so a 4:5 video
 * letterboxed inside the reel viewer still has the same zones around it.
 */
export const REEL_SAFE_ZONE = { topPct: 14, bottomPct: 35, sidePct: 6 } as const;

/** The reel viewer is a 9:16 screen. */
export const REEL_FRAME_ASPECT = 9 / 16;

export interface ContainedRect {
  leftPct: number;
  topPct: number;
  widthPct: number;
  heightPct: number;
}

/**
 * Where a video of aspect `videoAspect` (w/h) lands inside a container of
 * aspect `containerAspect` when it is CONTAINED (letterboxed, never cropped) —
 * i.e. CSS `object-fit: contain`, expressed as percentages of the container.
 *
 * The super-text strip is positioned in percentages OF THE VIDEO FRAME
 * (xPct/yPct, font = fontSizePct of the video WIDTH), so the preview must
 * place it inside THIS rect, not the container, or a 4:5 video's strip would
 * drift down the letterbox. Unknown aspect ⇒ assume the video fills the
 * container (a reel is normally shot 9:16).
 */
export function containedRect(containerAspect: number, videoAspect: number | null | undefined): ContainedRect {
  const v = videoAspect && Number.isFinite(videoAspect) && videoAspect > 0 ? videoAspect : containerAspect;
  if (v >= containerAspect) {
    // Video is relatively wider: full width, bars top and bottom.
    const heightPct = (containerAspect / v) * 100;
    return { leftPct: 0, topPct: (100 - heightPct) / 2, widthPct: 100, heightPct };
  }
  // Video is relatively taller: full height, bars left and right.
  const widthPct = (v / containerAspect) * 100;
  return { leftPct: (100 - widthPct) / 2, topPct: 0, widthPct, heightPct: 100 };
}

/**
 * True when Instagram would publish this attachment set as a REEL: exactly one
 * media and it is a video. Two or more attachments publish as a carousel (the
 * 4:5 feed card), an image as a feed post. Mirrors the provider's own rule
 * (`publishesAsStory`-style: format AND exactly one media), on the Post side.
 */
export function isSingleReel(mediaUrls: string[] | undefined, firstKind: "image" | "video" | undefined): boolean {
  return !!mediaUrls && mediaUrls.length === 1 && firstKind === "video";
}

/**
 * Where the strip will actually appear, in the user's words. The preview draws
 * the strip over the video in every case; this label keeps it honest — a
 * cover-scoped strip is on the thumbnail only, not in playback.
 */
export function superTextScopeLabel(config: Pick<SuperTextConfig, "scope" | "introSeconds"> | null | undefined): string {
  if (!config) return "";
  const scope = config.scope ?? "video";
  if (scope === "cover") return "Super text · cover only";
  if (scope === "intro") return `Super text · first ${config.introSeconds ?? 3}s`;
  return "Super text · whole video";
}
