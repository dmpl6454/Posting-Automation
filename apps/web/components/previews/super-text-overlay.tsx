"use client";

import { useEffect, useRef, useState } from "react";
import type { SuperTextConfig } from "@postautomation/super-text";
import { SuperTextStrip } from "../content-agent/super-text-strip";
import { containedRect } from "../../lib/reel-safe-area";

/**
 * The super-text strip drawn over a VIDEO inside a preview card (2026-10-03).
 *
 * Reuses SuperTextStrip — the ONE renderer shared by the editor stage and the
 * worker's burn frame — so the sidebar can never show a strip the burn would
 * not produce (the REP-4 lesson). All this component adds is geometry: it
 * finds the rect the video occupies inside the container (object-fit:
 * contain, from `videoAspect`), measures that rect's width so the font
 * scales exactly like the burn (fontSizePct of the VIDEO width), and anchors
 * the strip inside it.
 *
 * pointer-events: none throughout — the preview is not an editor.
 */
export function SuperTextOverlay({
  config,
  containerAspect,
  videoAspect,
}: {
  config: SuperTextConfig;
  /** w/h of the box this overlay fills (the reel frame is 9/16, a player 16/9). */
  containerAspect: number;
  /** w/h of the video itself; null/undefined ⇒ assumed to fill the container. */
  videoAspect?: number | null;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const rect = containedRect(containerAspect, videoAspect);

  // Width of the VIDEO rect, not the card: the strip's font is a percentage of
  // the video width on the burn, so it must be here too. Observed (not read
  // once) because the sidebar resizes with the window and the panel.
  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    setFrameWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setFrameWidth(w);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [rect.widthPct]);

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden="true" data-testid="super-text-overlay">
      <div
        ref={frameRef}
        className="absolute overflow-hidden"
        style={{
          left: `${rect.leftPct}%`,
          top: `${rect.topPct}%`,
          width: `${rect.widthPct}%`,
          height: `${rect.heightPct}%`,
        }}
      >
        {frameWidth > 0 && <SuperTextStrip config={config} stageWidth={frameWidth} />}
      </div>
    </div>
  );
}
