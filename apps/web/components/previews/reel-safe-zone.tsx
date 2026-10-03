"use client";

import { REEL_SAFE_ZONE } from "../../lib/reel-safe-area";

/**
 * Shades the parts of a 9:16 reel screen that Instagram's own UI covers, per
 * Meta's published safe zone (top 14%, bottom 35%, 6% each side — see
 * REEL_SAFE_ZONE for the source). The clear rectangle in the middle is where
 * text and faces stay visible; a dashed hairline marks its edge.
 *
 * Decorative: pointer-events none, aria-hidden, and it NEVER moves the media
 * underneath — it is an overlay on the frame, so turning it off changes
 * nothing about the preview's layout.
 */
export function ReelSafeZone() {
  const { topPct, bottomPct, sidePct } = REEL_SAFE_ZONE;
  const shade = "absolute bg-black/45";
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="reel-safe-zone">
      <div className={shade} style={{ left: 0, right: 0, top: 0, height: `${topPct}%` }} />
      <div className={shade} style={{ left: 0, right: 0, bottom: 0, height: `${bottomPct}%` }} />
      <div className={shade} style={{ left: 0, width: `${sidePct}%`, top: `${topPct}%`, bottom: `${bottomPct}%` }} />
      <div className={shade} style={{ right: 0, width: `${sidePct}%`, top: `${topPct}%`, bottom: `${bottomPct}%` }} />
      <div
        className="absolute rounded-sm border border-dashed border-white/70"
        style={{ left: `${sidePct}%`, right: `${sidePct}%`, top: `${topPct}%`, bottom: `${bottomPct}%` }}
      />
      <span className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wide text-white/90" style={{ top: `calc(${topPct}% + 6px)` }}>
        Safe area
      </span>
    </div>
  );
}
