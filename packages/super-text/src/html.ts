import type { SuperTextConfig } from "./schema";
import {
  SUPER_TEXT_FONT_STACK,
  SUPER_TEXT_EMOJI_STACK,
  STRIP_PAD_Y_EM,
  STRIP_PAD_X_EM,
  STRIP_RADIUS_EM,
  STRIP_LINE_HEIGHT,
  STRIP_MAX_WIDTH_PCT,
  STRIP_FONT_WEIGHT,
} from "./constants";

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * Defense in depth: the zod schema already rejects non-hex colours, but the
 * builder never trusts its input — a config can also arrive from a restored
 * localStorage draft or a hand-written DB row.
 */
export function safeHexColor(value: string | undefined | null, fallback: string): string {
  return typeof value === "string" && HEX6.test(value) ? value : fallback;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * THE single source of truth for what the strip looks like.
 *
 * Consumed by BOTH the compose live preview (React, via dangerouslySetInnerHTML)
 * and the worker burn (Puppeteer setContent). This is the direct lesson of the
 * REP-4 revert: when an interactive preview and a baked output are drawn by two
 * different code paths they drift, and the user ships an image that does not match
 * what they saw (there it was a duplicated logo and literal `**markup**`).
 *
 * `box-decoration-break: clone` is what gives each wrapped line its own rounded
 * pill instead of one ragged block — the Instagram look in the reference clip.
 */
export function buildStripInnerHtml(config: SuperTextConfig): string {
  const textColor = safeHexColor(config.textColor, "#111111");
  const stripColor = safeHexColor(config.stripColor, "#FFFFFF");
  const words = config.segments
    .map((seg) => {
      const color = seg.color ? safeHexColor(seg.color, textColor) : textColor;
      return `<span style="color:${color}">${escapeHtml(seg.text)}</span>`;
    })
    .join(" ");
  return (
    `<span style="background:${stripColor};color:${textColor};` +
    `font-weight:${STRIP_FONT_WEIGHT};` +
    `font-family:${SUPER_TEXT_FONT_STACK}, ${SUPER_TEXT_EMOJI_STACK};` +
    `line-height:${STRIP_LINE_HEIGHT};` +
    `padding:${STRIP_PAD_Y_EM}em ${STRIP_PAD_X_EM}em;` +
    `border-radius:${STRIP_RADIUS_EM}em;` +
    `-webkit-box-decoration-break:clone;box-decoration-break:clone;` +
    `white-space:pre-wrap;">${words}</span>`
  );
}

/**
 * Full-frame transparent page for the worker burn: rendered at the video's native
 * resolution and screenshotted with `omitBackground`, so ffmpeg can composite it
 * at `overlay=0:0`. Keeping the position maths in this CSS (rather than in ffmpeg
 * `x=`/`y=` expressions) means preview and burn share ONE positioning model.
 */
export function buildSuperTextFrameHtml(
  config: SuperTextConfig,
  videoWidth: number,
  videoHeight: number
): string {
  const w = Math.max(16, Math.min(7680, Math.round(videoWidth)));
  const h = Math.max(16, Math.min(7680, Math.round(videoHeight)));
  const fontPx = Math.round((config.fontSizePct / 100) * w);
  const xPct = Math.min(95, Math.max(5, config.xPct));
  const yPct = Math.min(95, Math.max(5, config.yPct));
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:transparent;width:${w}px;height:${h}px;overflow:hidden}` +
    `.anchor{position:absolute;left:${xPct}%;top:${yPct}%;transform:translate(-50%,-50%);` +
    `max-width:${STRIP_MAX_WIDTH_PCT}%;text-align:center;font-size:${fontPx}px}` +
    `</style></head><body><div class="anchor">${buildStripInnerHtml(config)}</div></body></html>`
  );
}
