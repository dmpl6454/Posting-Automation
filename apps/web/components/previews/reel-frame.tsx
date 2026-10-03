"use client";

import type { SuperTextConfig } from "@postautomation/super-text";
import { PreviewMedia } from "./preview-media";
import { ReelSafeZone } from "./reel-safe-zone";
import { SuperTextOverlay } from "./super-text-overlay";
import { REEL_FRAME_ASPECT, REEL_SAFE_ZONE, superTextScopeLabel } from "../../lib/reel-safe-area";

/**
 * The 9:16 reel screen shared by the Instagram AND Facebook preview cards
 * (2026-10-03). A single video on either platform is a reel, and both reel
 * viewers use the same screen: the video is CONTAINED (letterboxed, never
 * cropped — exactly how a non-9:16 upload plays), the platform's own UI zones
 * are shaded from Meta's published safe zone (ReelSafeZone), and the
 * super-text strip is drawn inside the VIDEO's rect through the ONE strip
 * renderer (SuperTextOverlay), where the burn puts it.
 *
 * ONE component, not a copy per card — the owner reported the Facebook card
 * still showing its 16:9 box the same hour the Instagram frame shipped, which
 * is what a per-card copy invites.
 */
export function ReelFrame({
  url,
  poster,
  superText,
  videoAspect,
  platformName,
}: {
  url: string;
  poster?: string;
  superText?: SuperTextConfig | null;
  videoAspect?: number | null;
  /** Named in the legend: "Shaded = where Instagram's own UI sits". */
  platformName: string;
}) {
  return (
    <div className="bg-black">
      <div
        className="relative mx-auto w-full max-w-[300px] overflow-hidden bg-black"
        style={{ aspectRatio: `${REEL_FRAME_ASPECT}` }}
        data-testid="reel-frame"
      >
        <PreviewMedia poster={poster} url={url} kind="video" className="h-full w-full object-contain" />
        <ReelSafeZone />
        {superText ? (
          <SuperTextOverlay config={superText} containerAspect={REEL_FRAME_ASPECT} videoAspect={videoAspect} />
        ) : null}
        <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">
          Reel
        </span>
        {superText ? (
          <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
            {superTextScopeLabel(superText)}
          </span>
        ) : null}
      </div>
      <p className="px-3 py-1.5 text-center text-[10px] leading-snug text-zinc-400">
        Shaded = where {platformName}&apos;s own UI sits (Meta&apos;s reel safe zone: top {REEL_SAFE_ZONE.topPct}%,
        bottom {REEL_SAFE_ZONE.bottomPct}%, sides {REEL_SAFE_ZONE.sidePct}%).
      </p>
    </div>
  );
}
