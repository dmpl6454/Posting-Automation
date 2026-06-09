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

/** Allow only valid CSS hex colors; otherwise fall back to the default accent. */
export function safeColor(color: string | undefined): string {
  return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : DEFAULT_ACCENT;
}

/** Allow only https: or data:image base64 URLs with no CSS/HTML-breakout chars. */
export function safeImageUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  const ok = /^(https:\/\/|data:image\/(png|jpeg|jpg|webp|gif);base64,)[^"')\s<>\\]+$/i.test(url);
  return ok ? url : null;
}

export function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert **word** / ==word== markup to brand-accent <span>s, escaping the rest. */
export function renderHighlightMarkup(text: string, accent: string): string {
  const safe = safeColor(accent);
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, `<span style="color:${safe}">$1</span>`)
    .replace(/==([^=]+)==/g, `<span style="color:${safe}">$1</span>`);
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
  const accent = safeColor(opts.brandColor);
  const safeLogo = safeImageUrl(opts.logoUrl);
  if (safeLogo) {
    return `<img src="${safeLogo}" style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;object-fit:contain;background:rgba(255,255,255,0.06);" />`;
  }
  const initial = (opts.channelName[0] ?? "N").toUpperCase();
  return `<div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;background:${accent};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:${Math.round(size * 0.42)}px;">${initial}</div>`;
}

// ── Style builders ────────────────────────────────────────────────────────
function buildPremiumEditorial(opts: StaticCreativeOptions): string {
  const accent = safeColor(opts.brandColor);
  const fs = headlineFontSize(opts.headline);
  const safeBg = safeImageUrl(opts.bgImageUrl);
  const bg = safeBg
    ? `background-image:url("${safeBg}");background-size:cover;background-position:center;`
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
  const accent = safeColor(opts.brandColor);
  const safeBg = safeImageUrl(opts.bgImageUrl);
  const bg = safeBg
    ? `background-image:url("${safeBg}");background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#222,#111);`;
  const corner = opts.logoPosition === "top-left" ? "left:40px;" : "right:40px;";
  const hookHtml = opts.hookLine ? renderHighlightMarkup(opts.hookLine, accent) : "";
  const safeInset = safeImageUrl(opts.secondaryImageUrl);
  const inset = safeInset
    ? `<img class="inset-cutout" src="${safeInset}" style="position:absolute;bottom:330px;right:60px;width:300px;height:300px;border-radius:50%;object-fit:cover;border:6px solid #fff;box-shadow:0 8px 30px rgba(0,0,0,0.5);" />`
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

function buildTweetCard(opts: StaticCreativeOptions): string {
  const accent = opts.brandColor && /^#[0-9a-fA-F]{3,8}$/.test(opts.brandColor) ? opts.brandColor : "#1d9bf0";
  const tick = opts.verified
    ? `<svg class="verified-tick" width="26" height="26" viewBox="0 0 24 24" fill="${accent}"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .494.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.16-.032.322-.032.486 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.164-.012-.326-.032-.486 1.16-.688 1.943-1.99 1.943-3.486zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"/></svg>`
    : "";
  const safeBg = safeImageUrl(opts.bgImageUrl);
  const safeSecondary = safeImageUrl(opts.secondaryImageUrl);
  const imgPair =
    safeBg && safeSecondary
      ? `<div class="pair"><img src="${safeBg}"/><img src="${safeSecondary}"/></div>`
      : safeBg
        ? `<div class="single"><img src="${safeBg}"/></div>`
        : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.width}px;height:${CANVAS.height}px;overflow:hidden;font-family:'Inter',system-ui,sans-serif;background:#fff;padding:64px 56px;display:flex;flex-direction:column;}
.head{display:flex;align-items:center;gap:18px;margin-bottom:28px;}
.name-row{display:flex;align-items:center;gap:8px;}
.name{font-size:34px;font-weight:800;color:#0f1419;}
.handle{font-size:26px;color:#536471;margin-top:2px;}
.text{font-size:40px;line-height:1.3;color:#0f1419;font-weight:400;margin-bottom:32px;}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;border-radius:18px;overflow:hidden;}
.pair img{width:100%;height:100%;object-fit:cover;}
.single{flex:1;border-radius:18px;overflow:hidden;}
.single img{width:100%;height:100%;object-fit:cover;}
</style></head><body>
<div class="head">
  ${logoHtml(opts, 72)}
  <div>
    <div class="name-row"><span class="name">${escapeHtml(opts.channelName)}</span>${tick}</div>
    ${opts.handle ? `<div class="handle">${escapeHtml(opts.handle)}</div>` : ""}
  </div>
</div>
<div class="text">${escapeHtml(opts.headline)}</div>
${imgPair}
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
      return buildTweetCard(opts);
    case "bold_typographic":
      return notImplemented("bold_typographic");
    default:
      return buildPremiumEditorial(opts);
  }
}
