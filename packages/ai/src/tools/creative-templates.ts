/**
 * Social creative renderer. Pure `opts → HTML` builders, one per style, behind
 * a single dispatcher. Rendered to PNG by news-image-generator via Puppeteer.
 * Inputs are shared across styles; only layout differs.
 */

export type CreativeStyle =
  | "premium_editorial"
  | "hook_bars"
  | "tweet_card"
  | "bold_typographic";

export interface StaticCreativeOptions {
  style: CreativeStyle;
  headline: string;
  /** Optional punchy hook line (hook_bars). Supports **word** highlight markup. */
  hookLine?: string;
  subhead?: string;
  /** Background/primary photo as a data URL or http(s) URL. */
  bgImageUrl?: string;
  /** Optional second image (hook_bars inset cutout; tweet_card image pair). */
  secondaryImageUrl?: string;
  /** Logo URL; null/undefined → logo block omitted (no-reference path). */
  logoUrl?: string | null;
  logoPosition: "top-left" | "top-right";
  /** Brand accent color (hex). Defaults applied per style if absent. */
  brandColor?: string;
  channelName: string;
  handle?: string;
  verified?: boolean;
  tag?: string;
  date?: string;
}

const CANVAS = { width: 1080, height: 1350 };
const DEFAULT_ACCENT = "#e11d48";

export function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert **word** / ==word== markup to brand-accent <span>s, escaping the rest. */
export function renderHighlightMarkup(text: string, accent: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, `<span style="color:${accent}">$1</span>`)
    .replace(/==([^=]+)==/g, `<span style="color:${accent}">$1</span>`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function fmtDate(date?: string): string {
  return (
    date ??
    new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }).toUpperCase()
  );
}

/** Word-count-aware headline font size (px) within the 1080px canvas. */
function headlineFontSize(headline: string): number {
  const words = headline.trim().split(/\s+/).length;
  return words <= 5 ? 82 : words <= 8 ? 66 : words <= 12 ? 54 : words <= 16 ? 46 : 40;
}

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');`;

function logoHtml(opts: StaticCreativeOptions, size: number): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  if (opts.logoUrl) {
    return `<img src="${escapeHtml(opts.logoUrl)}" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;object-fit:contain;background:rgba(255,255,255,0.06);" />`;
  }
  const initial = (opts.channelName[0] ?? "N").toUpperCase();
  return `<div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;background:${accent};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:${Math.round(size * 0.42)}px;">${initial}</div>`;
}

// ── Style builders ────────────────────────────────────────────────────────
function buildPremiumEditorial(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  const fs = headlineFontSize(opts.headline);
  const bg = opts.bgImageUrl
    ? `background-image:url(${opts.bgImageUrl});background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#1a1a2e,#16213e);`;
  const corner = opts.logoPosition === "top-left" ? "left:48px;" : "right:48px;";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;background:#000;-webkit-font-smoothing:antialiased;}
.bg{position:absolute;inset:0;${bg}}
.scrim{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.92) 0%,rgba(0,0,0,0.55) 40%,rgba(0,0,0,0.15) 70%,rgba(0,0,0,0.35) 100%);}
.logo{position:absolute;top:44px;${corner}}
.block{position:absolute;left:56px;right:56px;bottom:96px;}
.label{font-style:italic;font-size:26px;font-weight:600;color:rgba(255,255,255,0.92);letter-spacing:0.01em;}
.rule{width:64px;height:4px;background:${accent};border-radius:2px;margin:14px 0 22px;}
.headline{color:#fff;font-size:${fs}px;font-weight:800;line-height:1.08;letter-spacing:-0.02em;word-break:break-word;}
.handle{position:absolute;bottom:44px;left:56px;color:rgba(255,255,255,0.6);font-size:20px;font-weight:500;}
</style></head><body>
<div class="bg"></div><div class="scrim"></div>
<div class="logo">${logoHtml(opts, 64)}</div>
<div class="block">
  <div class="label">${escapeHtml(opts.channelName)}</div>
  <div class="rule"></div>
  <div class="headline">${escapeHtml(opts.headline)}</div>
</div>
${opts.handle ? `<div class="handle">${escapeHtml(opts.handle)}</div>` : ""}
</body></html>`;
}

function buildHookBars(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor || DEFAULT_ACCENT;
  const bg = opts.bgImageUrl
    ? `background-image:url(${opts.bgImageUrl});background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#222,#111);`;
  const corner = opts.logoPosition === "top-left" ? "left:40px;" : "right:40px;";
  const hookHtml = opts.hookLine ? renderHighlightMarkup(opts.hookLine, accent) : "";
  const inset = opts.secondaryImageUrl
    ? `<img class="inset-cutout" src="${opts.secondaryImageUrl}" style="position:absolute;bottom:330px;right:60px;width:300px;height:300px;border-radius:50%;object-fit:cover;border:6px solid #fff;box-shadow:0 8px 30px rgba(0,0,0,0.5);" />`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;background:#000;}
.bg{position:absolute;inset:0;${bg}}
.logo{position:absolute;top:36px;${corner}}
.bars{position:absolute;left:36px;right:36px;bottom:48px;display:flex;flex-direction:column;gap:14px;}
.bar{background:#fff;border-radius:10px;padding:18px 24px;box-shadow:0 6px 24px rgba(0,0,0,0.35);}
.hook{font-size:40px;font-weight:800;line-height:1.15;color:#111;}
.headline{font-size:44px;font-weight:800;line-height:1.12;color:#111;}
.headline .accent{color:${accent};}
</style></head><body>
<div class="bg"></div>
<div class="logo">${logoHtml(opts, 56)}</div>
${inset}
<div class="bars">
  ${hookHtml ? `<div class="bar"><div class="hook">${hookHtml}</div></div>` : ""}
  <div class="bar"><div class="headline">${escapeHtml(opts.headline)}</div></div>
</div>
</body></html>`;
}

function notImplemented(style: string): never {
  throw new Error(`creative style "${style}" not implemented yet`);
}

export function buildStaticCreative(opts: StaticCreativeOptions): string {
  switch (opts.style) {
    case "premium_editorial":
      return buildPremiumEditorial(opts);
    case "hook_bars":
      return buildHookBars(opts);
    case "tweet_card":
      return notImplemented("tweet_card");
    case "bold_typographic":
      return notImplemented("bold_typographic");
    default:
      return buildPremiumEditorial(opts);
  }
}
