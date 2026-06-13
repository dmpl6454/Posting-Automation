/**
 * Composable card engine. A CardSpec is an ordered list of optional blocks over a
 * 1080×1350 canvas + global StyleControls. Each block is a pure builder; renderCard
 * composes them to an HTML string rasterized to PNG by news-image-generator.ts.
 */

export const CANVAS = { w: 1080 as const, h: 1350 as const };

// ── StyleControls (Component 2) ─────────────────────────────────────────────
export type FontFamily = "inter" | "serif_display" | "condensed";

export interface StyleControls {
  theme: "light" | "dark";
  brandColor: string;
  highlightColor: string;
  bgOpacity: number; // 0–100 default caption-pill opacity
  fontFamily: FontFamily;
  textAlign: "left" | "center";
  logoPosition: "tl" | "tr" | "bl" | "br";
  fontScale?: number; // clamp [0.8, 1.5]
}

export const DEFAULT_ACCENT = "#e11d48";

export const DEFAULT_CONTROLS: StyleControls = {
  theme: "light",
  brandColor: DEFAULT_ACCENT,
  highlightColor: DEFAULT_ACCENT,
  bgOpacity: 100,
  fontFamily: "inter",
  textAlign: "left",
  logoPosition: "tr",
  fontScale: 1,
};

// ── ImageSlot (Component 4 — resolver lives in plan 1, types here) ──────────
export interface ImageSlot {
  userImageId?: string;
  articleImageUrl?: string;
  resolvedUrl: string;
  source: "user" | "ai" | "article" | "branded";
}

// ── Per-block prop types (A.2–A.13) ─────────────────────────────────────────
export type BackgroundMode =
  | "photo" | "subjectComposite" | "ai" | "gradient"
  | "splitPhotos" | "photoGrid" | "topTextBottomPhoto" | "screenshot";

export type BackgroundBlockProps = {
  mode: BackgroundMode;
  imageUrl?: string;
  imageUrls?: string[]; // splitPhotos / photoGrid tiles
  accentColor?: string;
  overlayText?: string; // topTextBottomPhoto
};

export interface LogoBlock {
  kind: "image" | "wordmark" | "monogram";
  src?: string;
  text?: string;
  anchor: "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";
  size: number;    // % of canvas width, clamped [1,100]
  opacity: number; // 0–100
  box?: { bg: string; opacity: number; radius: number; pad: number };
  watermark?: boolean;
}
export type LogoBlockProps = { logos: LogoBlock[] };

export type CircularInsetBlockProps = {
  items: Array<{
    imageUrl: string;
    position: { top: number; left: number };
    size: number;
    ringColor?: string;
    ringWidth?: number;
  }>;
};

export type LabelChipBlockProps = {
  pills: Array<{
    text: string;
    bg?: string;
    bgOpacity?: number;
    textColor?: string;
    position?: { top: number; left: number };
    shape?: "pill" | "bar";
    radius?: number;
    padding?: number;
  }>;
};

export type TweetHeaderBlockProps = {
  displayName: string;
  handle: string;
  logoUrl?: string;
  verified?: boolean;
  verifiedColor?: string;
};

export interface CaptionPill {
  text: string;
  bg?: string;
  bgOpacity?: number;
  textColor?: string;
  align?: "left" | "center";
  shape?: "pill" | "bar";
  emoji?: string;
}
export type CaptionStackBlockProps = { pills: CaptionPill[] };

export type StatCardsBlockProps = {
  cards: Array<{ label: string; value: string; bg?: string; icon?: string }>;
};

export type BodyTextBlockProps = {
  title?: string;
  description: string;
  meta?: Array<{ label: string; value: string }>;
  textColor?: string;
};

export type FooterBlockProps = { text: string; textColor?: string };

export type CarouselChromeBlockProps = {
  totalSlides: number;
  currentSlide: number;
  progressBar?: { color?: string; height?: number };
  pageDots?: boolean;
  navArrowHint?: boolean;
};

export type CtaCardBlockProps = {
  headline: string;
  subheading?: string;
  buttonText?: string;
  bg?: string;
  phoneAssetUrl?: string;
};

// ── Block discriminated union + CardSpec ────────────────────────────────────
export type BlockKind =
  | "background" | "logo" | "circularInset" | "labelChip" | "tweetHeader"
  | "captionStack" | "statCards" | "bodyText" | "footer" | "carouselChrome" | "ctaCard";

export type Block =
  | { kind: "background"; props: BackgroundBlockProps }
  | { kind: "logo"; props: LogoBlockProps }
  | { kind: "circularInset"; props: CircularInsetBlockProps }
  | { kind: "labelChip"; props: LabelChipBlockProps }
  | { kind: "tweetHeader"; props: TweetHeaderBlockProps }
  | { kind: "captionStack"; props: CaptionStackBlockProps }
  | { kind: "statCards"; props: StatCardsBlockProps }
  | { kind: "bodyText"; props: BodyTextBlockProps }
  | { kind: "footer"; props: FooterBlockProps }
  | { kind: "carouselChrome"; props: CarouselChromeBlockProps }
  | { kind: "ctaCard"; props: CtaCardBlockProps };

export type CardSpec = {
  canvas: { w: 1080; h: 1350 };
  blocks: Block[];
  controls: StyleControls;
};

// ── Sanitizers (Component 2 / §4) ───────────────────────────────────────────
const FONT_ALLOWLIST: readonly FontFamily[] = ["inter", "serif_display", "condensed"];

/** Allow only valid CSS hex colors; else fall back to the default accent. */
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Clamp a 0–100 opacity; non-numeric → `dflt`. */
export function clampOpacity(v: number | undefined, dflt = 100): number {
  if (typeof v !== "number" || Number.isNaN(v)) return dflt;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function safeFontFamily(f: string | undefined): FontFamily {
  return FONT_ALLOWLIST.includes(f as FontFamily) ? (f as FontFamily) : "inter";
}

export function safeAlign(a: string | undefined): "left" | "center" {
  return a === "center" ? "center" : "left";
}

export function safeShape(s: string | undefined): "pill" | "bar" {
  return s === "bar" ? "bar" : "pill";
}

/**
 * Allow only 1–3 codepoints in the emoji/symbol unicode range; anything else
 * (markup, ASCII text, breakout chars) → "". Prevents a per-pill `emoji` field
 * from injecting HTML/CSS into the rendered span.
 */
export function safeEmoji(e: string | undefined): string {
  if (!e) return "";
  const cps = Array.from(e.trim());
  if (cps.length === 0 || cps.length > 3) return "";
  const EMOJI = /[‼-㊙\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️‍]/u;
  return cps.every((c) => EMOJI.test(c)) ? cps.join("") : "";
}

/** Map a FontFamily enum to a real CSS font-family stack. */
export function fontStack(f: FontFamily): string {
  switch (f) {
    case "serif_display": return "'Playfair Display',Georgia,serif";
    case "condensed": return "'Oswald','Arial Narrow',sans-serif";
    case "inter":
    default: return "'Inter',system-ui,sans-serif";
  }
}

// ── Highlight markup (Component 2) ──────────────────────────────────────────
export type HighlightMode = "text" | "box";

/**
 * Render per-span highlight markup to escaped HTML <span>s.
 *
 *   [[text]]            → accent color, text mode
 *   [[text|#hex]]       → explicit color, text mode
 *   [[text|#hex|box]]   → explicit color, solid-box mode (IG-selection look)
 *   **text**            → accent color, text mode (legacy)
 *
 * Escape-then-markup: the WHOLE string is HTML-escaped first, then the (now
 * escape-safe) markers are replaced. Every color flows through safeColor, so a
 * crafted span color can never break out of the style attribute. A span with no
 * explicit color uses the passed accent. Unbalanced markup is left as escaped
 * literal text.
 */
export function renderHighlightMarkup(text: string, accentColor: string): string {
  const accent = safeColor(accentColor);
  let out = escapeHtml(text ?? "");

  // [[ text | #hex | box ]]  — color + mode optional. `[^\[\]|]` so spans never
  // swallow another marker; the body is already escaped (no raw < > " ').
  out = out.replace(
    /\[\[([^\[\]|]+?)(?:\|(#[0-9a-fA-F]{3,8}|[^\[\]|]*))?(?:\|(box|text))?\]\]/g,
    (_m, body: string, rawColor: string | undefined, mode: string | undefined) => {
      const color = rawColor ? safeColor(rawColor) : accent;
      if (mode === "box") {
        return `<span style="background:${color};color:#fff;padding:2px 10px;border-radius:6px;">${body}</span>`;
      }
      return `<span style="color:${color}">${body}</span>`;
    },
  );

  // Legacy **text** / ==text== → default-accent text span.
  out = out
    .replace(/\*\*([^*]+)\*\*/g, `<span style="color:${accent}">$1</span>`)
    .replace(/==([^=]+)==/g, `<span style="color:${accent}">$1</span>`);

  return out;
}

// ── Theme tokens (shared by builders) ───────────────────────────────────────
export interface ThemeTokens { bgFallback: string; scrim: string; textColor: string; subTextColor: string; }

export function themeTokens(controls: StyleControls): ThemeTokens {
  const safe = safeColor(controls.brandColor);
  if (controls.theme === "dark") {
    return {
      bgFallback: "linear-gradient(135deg,#1a1a2e,#16213e)",
      scrim: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.25) 50%, rgba(0,0,0,0) 100%)",
      textColor: "#ffffff",
      subTextColor: "rgba(255,255,255,0.75)",
    };
  }
  // light default
  return {
    bgFallback: `linear-gradient(135deg, ${safe}, #11131a)`, // branded, never flat
    scrim: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.15) 50%, rgba(0,0,0,0) 100%)",
    textColor: "#0f1419",
    subTextColor: "#5b6470",
  };
}

function brandedGradient(controls: StyleControls): string {
  return `background:linear-gradient(135deg, ${safeColor(controls.brandColor)}, #11131a);`;
}

// ── background block ────────────────────────────────────────────────────────
export function renderBackground(props: BackgroundBlockProps, controls: StyleControls): string {
  const url = safeImageUrl(props.imageUrl);
  const urls = (props.imageUrls ?? []).map(safeImageUrl).filter((u): u is string => !!u);
  const accent = safeColor(props.accentColor ?? controls.brandColor);

  const cover = (u: string) =>
    `<div class="bg" style="position:absolute;inset:0;background-image:url('${u}');background-size:cover;background-position:center;"></div>`;
  const grad = `<div class="bg" style="position:absolute;inset:0;${brandedGradient(controls)}"></div>`;
  const scrim = `<div class="scrim" style="position:absolute;inset:0;background:${themeTokens(controls).scrim};"></div>`;

  switch (props.mode) {
    case "photo":
    case "ai":
      return url ? cover(url) + scrim : grad;
    case "subjectComposite":
      // cutout matting is a stretch goal; degrade to plain photo / gradient
      return url ? cover(url) + scrim : grad;
    case "gradient":
      return `<div class="bg" style="position:absolute;inset:0;background:linear-gradient(135deg, ${accent}, #11131a);"></div>`;
    case "splitPhotos": {
      if (urls.length < 2) return urls[0] ? cover(urls[0]) + scrim : grad;
      return `<div class="bg" style="position:absolute;inset:0;display:grid;grid-template-columns:1fr 1fr;">`
        + urls.slice(0, 2).map((u) => `<div style="background:url('${u}') center/cover;"></div>`).join("")
        + `</div>` + scrim;
    }
    case "photoGrid": {
      if (urls.length === 0) return grad;
      const cols = urls.length <= 1 ? "1fr" : "1fr 1fr";
      return `<div class="bg" style="position:absolute;inset:0;display:grid;grid-template-columns:${cols};grid-auto-rows:1fr;">`
        + urls.slice(0, 4).map((u) => `<div style="background:url('${u}') center/cover;"></div>`).join("")
        + `</div>` + scrim;
    }
    case "topTextBottomPhoto": {
      const band = `<div style="position:absolute;top:0;left:0;right:0;height:42%;background:${accent};display:flex;align-items:center;justify-content:center;padding:0 56px;color:#fff;font-weight:900;font-size:64px;line-height:1.05;text-align:center;">${escapeHtml(props.overlayText ?? "")}</div>`;
      const photo = url
        ? `<div style="position:absolute;bottom:0;left:0;right:0;height:58%;background:url('${url}') center/cover;"></div>`
        : `<div style="position:absolute;bottom:0;left:0;right:0;height:58%;${brandedGradient(controls)}"></div>`;
      return `<div class="bg" style="position:absolute;inset:0;">${photo}${band}</div>`;
    }
    case "screenshot":
      return url
        ? `<div class="bg" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;${brandedGradient(controls)}"><div class="screenshot-frame" style="width:72%;border:14px solid #0f1419;border-radius:36px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,0.45);"><img src="${url}" style="width:100%;display:block;"/></div></div>`
        : grad;
    default:
      return grad;
  }
}

// ── logo block ──────────────────────────────────────────────────────────────
const ANCHOR_CSS: Record<LogoBlock["anchor"], string> = {
  tl: "top:44px;left:44px;",   tc: "top:44px;left:50%;transform:translateX(-50%);",  tr: "top:44px;right:44px;",
  ml: "top:50%;left:44px;transform:translateY(-50%);", mc: "top:50%;left:50%;transform:translate(-50%,-50%);", mr: "top:50%;right:44px;transform:translateY(-50%);",
  bl: "bottom:44px;left:44px;", bc: "bottom:44px;left:50%;transform:translateX(-50%);", br: "bottom:44px;right:44px;",
};

function clampSize(pct: number): number { return Math.max(1, Math.min(100, pct)); }

function renderOneLogo(l: LogoBlock, controls: StyleControls): string {
  const widthPx = Math.round((clampSize(l.size) / 100) * CANVAS.w);
  const opacity = clampOpacity(l.opacity, 100) / 100;
  const anchor = ANCHOR_CSS[l.anchor] ?? ANCHOR_CSS.tr;
  const z = l.watermark ? "z-index:0;" : "z-index:5;";
  const boxStyle = l.box
    ? `background:${safeColor(l.box.bg)};opacity:${clampOpacity(l.box.opacity, 100) / 100};border-radius:${Math.max(0, l.box.radius)}px;padding:${Math.max(0, l.box.pad)}px;`
    : "";
  let inner = "";
  if (l.kind === "image") {
    const src = safeImageUrl(l.src);
    if (!src) return ""; // drop a logo we can't safely render
    inner = `<img src="${src}" style="width:${widthPx}px;height:auto;object-fit:contain;display:block;"/>`;
  } else if (l.kind === "wordmark") {
    inner = `<span style="font-weight:900;font-size:${Math.round(widthPx * 0.32)}px;color:${safeColor(controls.brandColor)};letter-spacing:0.02em;">${escapeHtml(l.text ?? "")}</span>`;
  } else { // monogram
    inner = `<span style="font-weight:900;font-size:${Math.round(widthPx * 0.6)}px;color:${safeColor(controls.brandColor)};border:3px solid ${safeColor(controls.brandColor)};border-radius:12px;padding:6px 12px;">${escapeHtml(l.text ?? "")}</span>`;
  }
  return `<div style="position:absolute;${anchor}${z}opacity:${opacity};${boxStyle}display:flex;align-items:center;">${inner}</div>`;
}

export function renderLogo(props: LogoBlockProps, controls: StyleControls): string {
  if (!props.logos?.length) return "";
  return props.logos.map((l) => renderOneLogo(l, controls)).join("");
}

// ── tweetHeader block ───────────────────────────────────────────────────────
export function renderTweetHeader(props: TweetHeaderBlockProps, controls: StyleControls): string {
  const tokens = themeTokens(controls);
  const tickColor = safeColor(props.verifiedColor ?? "#1d9bf0");
  const avatar = safeImageUrl(props.logoUrl);
  const avatarHtml = avatar
    ? `<img src="${avatar}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;"/>`
    : `<div style="width:72px;height:72px;border-radius:50%;background:${safeColor(controls.brandColor)};"></div>`;
  const tick = props.verified
    ? `<svg class="verified-tick" width="26" height="26" viewBox="0 0 24 24" fill="${tickColor}"><path d="M22.5 12.5c0-1.58-.88-2.95-2.15-3.6.15-.44.24-.91.24-1.4 0-2.21-1.71-4-3.82-4-.47 0-.92.08-1.34.25C14.82 2.42 13.51 1.5 12 1.5s-2.82.92-3.44 2.25c-.41-.17-.86-.25-1.34-.25-2.11 0-3.82 1.79-3.82 4 0 .49.08.96.24 1.4-1.27.65-2.15 2.02-2.15 3.6 0 1.5.78 2.8 1.94 3.49-.02.16-.03.32-.03.49 0 2.21 1.71 4 3.82 4 .47 0 .92-.09 1.34-.25.62 1.33 1.93 2.25 3.44 2.25s2.82-.92 3.44-2.25c.41.16.86.25 1.34.25 2.11 0 3.82-1.79 3.82-4 0-.16-.01-.33-.03-.49 1.16-.69 1.94-1.99 1.94-3.49z"/></svg>`
    : "";
  return `<div class="tweet-head" style="display:flex;align-items:center;gap:18px;margin-bottom:28px;">
  ${avatarHtml}
  <div>
    <div style="display:flex;align-items:center;gap:8px;"><span style="font-size:34px;font-weight:800;color:${tokens.textColor};">${escapeHtml(props.displayName)}</span>${tick}</div>
    <div style="font-size:26px;color:${tokens.subTextColor};">@${escapeHtml(props.handle)}</div>
  </div>
</div>`;
}

// ── labelChip block ─────────────────────────────────────────────────────────
function pillRadius(shape: "pill" | "bar"): number { return shape === "bar" ? 8 : 999; }

export function renderLabelChip(props: LabelChipBlockProps, controls: StyleControls): string {
  if (!props.pills?.length) return "";
  return props.pills
    .map((p) => {
      const shape = safeShape(p.shape);
      const bg = safeColor(p.bg ?? (controls.theme === "dark" ? "#111111" : "#ffffff"));
      const opacity = clampOpacity(p.bgOpacity, controls.bgOpacity) / 100;
      const textColor = safeColor(p.textColor ?? (controls.theme === "dark" ? "#ffffff" : "#0f1419"));
      const radius = p.radius != null ? Math.max(0, p.radius) : pillRadius(shape);
      const pad = p.padding != null ? Math.max(0, p.padding) : 14;
      const pos = p.position
        ? `position:absolute;top:${Math.max(0, p.position.top)}px;left:${Math.max(0, p.position.left)}px;`
        : "";
      const inner = renderHighlightMarkup(p.text, controls.highlightColor);
      return `<div style="${pos}display:inline-flex;align-items:center;background:${bg};opacity:${opacity};color:${textColor};border-radius:${radius}px;padding:${pad}px ${pad + 8}px;font-weight:800;font-size:32px;z-index:6;">${inner}</div>`;
    })
    .join("");
}

// ── circularInset block ─────────────────────────────────────────────────────
export function renderCircularInset(props: CircularInsetBlockProps, controls: StyleControls): string {
  const items = (props.items ?? [])
    .map((it) => ({ ...it, url: safeImageUrl(it.imageUrl) }))
    .filter((it) => !!it.url);
  if (!items.length) return "";
  return items
    .map((it) => {
      const ring = safeColor(it.ringColor ?? controls.brandColor);
      const w = Math.max(0, it.ringWidth ?? 6);
      const size = Math.max(40, it.size);
      const top = Math.max(0, it.position.top);
      const left = Math.max(0, it.position.left);
      return `<div style="position:absolute;top:${top}px;left:${left}px;width:${size}px;height:${size}px;border-radius:50%;overflow:hidden;border:${w}px solid ${ring};box-shadow:0 8px 30px rgba(0,0,0,0.5);z-index:4;"><img src="${it.url}" style="width:100%;height:100%;object-fit:cover;"/></div>`;
    })
    .join("");
}

// ── captionStack block ──────────────────────────────────────────────────────
export function renderCaptionStack(props: CaptionStackBlockProps, controls: StyleControls): string {
  if (!props.pills?.length) return "";
  const pills = props.pills
    .map((p) => {
      const shape = safeShape(p.shape);
      const bg = safeColor(p.bg ?? (controls.theme === "dark" ? "#111111" : "#ffffff"));
      const opacity = clampOpacity(p.bgOpacity, controls.bgOpacity) / 100;
      const textColor = safeColor(p.textColor ?? (controls.theme === "dark" ? "#ffffff" : "#0f1419"));
      const align = safeAlign(p.align ?? controls.textAlign);
      const radius = shape === "bar" ? 10 : 18;
      const emoji = safeEmoji(p.emoji);
      const inner = renderHighlightMarkup(p.text, controls.highlightColor) + (emoji ? ` ${emoji}` : "");
      return `<div class="caption-pill" style="background:${bg};opacity:${opacity};color:${textColor};border-radius:${radius}px;padding:18px 24px;text-align:${align};font-weight:800;font-size:42px;line-height:1.15;box-shadow:0 6px 24px rgba(0,0,0,0.3);word-break:break-word;">${inner}</div>`;
    })
    .join("");
  return `<div class="caption-stack" style="position:absolute;left:36px;right:36px;bottom:48px;display:flex;flex-direction:column;gap:14px;z-index:3;">${pills}</div>`;
}

// ── statCards block ─────────────────────────────────────────────────────────
export function renderStatCards(props: StatCardsBlockProps, controls: StyleControls): string {
  if (!props.cards?.length) return "";
  const cards = props.cards
    .map((c) => {
      const bg = safeColor(c.bg ?? controls.brandColor);
      const icon = safeEmoji(c.icon);
      return `<div style="background:${bg};color:#fff;border-radius:18px;padding:24px 28px;min-width:240px;">
  ${icon ? `<div style="font-size:34px;">${icon}</div>` : ""}
  <div style="font-size:24px;font-weight:700;opacity:0.85;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(c.label)}</div>
  <div style="font-size:56px;font-weight:900;line-height:1.05;margin-top:4px;">${escapeHtml(c.value)}</div>
</div>`;
    })
    .join("");
  return `<div class="stat-cards" style="position:absolute;left:48px;right:48px;bottom:300px;display:flex;gap:18px;flex-wrap:wrap;z-index:3;">${cards}</div>`;
}

// ── bodyText block ──────────────────────────────────────────────────────────
export function renderBodyText(props: BodyTextBlockProps, controls: StyleControls): string {
  const tokens = themeTokens(controls);
  const textColor = safeColor(props.textColor ?? tokens.textColor);
  const align = safeAlign(controls.textAlign);
  const title = props.title
    ? `<div style="font-size:48px;font-weight:900;line-height:1.08;margin-bottom:18px;color:${textColor};">${escapeHtml(props.title)}</div>`
    : "";
  const meta = (props.meta ?? [])
    .map((m) => `<div style="font-size:28px;color:${tokens.subTextColor};margin-bottom:6px;"><b style="color:${textColor};">${escapeHtml(m.label)}:</b> ${escapeHtml(m.value)}</div>`)
    .join("");
  const desc = `<div style="font-size:34px;line-height:1.32;color:${textColor};margin-top:14px;">${escapeHtml(props.description)}</div>`;
  return `<div class="body-text" style="position:absolute;left:56px;right:56px;top:120px;text-align:${align};z-index:3;">${title}${meta}${desc}</div>`;
}
