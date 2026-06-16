/**
 * Composable card engine. A CardSpec is an ordered list of optional blocks over a
 * 1080×1350 canvas + global StyleControls. Each block is a pure builder; renderCard
 * composes them to an HTML string rasterized to PNG by news-image-generator.ts.
 */

export const CANVAS = { w: 1080 as const, h: 1350 as const };

// ── StyleControls (Component 2) ─────────────────────────────────────────────
/**
 * Supported font families for social cards.
 *
 * The first three ("inter", "serif_display", "condensed") are the ORIGINAL
 * values — all callers (NewsGrid, media-editor, autopilot, vision classifier)
 * that use these names continue to work byte-identically. The remaining values
 * are user-pick-only additions (Round 15). The vision classifier in
 * extract-card-layout.ts still returns only the original three; any of the new
 * values can be set via the UI font-family picker (fontOverride).
 */
export type FontFamily =
  // ── Original three (behavior unchanged) ──
  | "inter"           // clean modern sans-serif (default)
  | "serif_display"   // elegant editorial serif (Playfair Display)
  | "condensed"       // tall narrow bold sans (Oswald)
  // ── Round 15 additions (user-pick only) ──
  | "montserrat"      // geometric sans — bold, modern
  | "poppins"         // rounded geometric sans — friendly, contemporary
  | "bebas"           // Bebas Neue — heavy display condensed
  | "anton"           // Anton — ultra-heavy display sans
  | "archivo_black"   // Archivo Black — bold grotesque
  | "dm_serif"        // DM Serif Display — modern editorial serif
  | "lora"            // Lora — refined text serif with italic flair
  | "roboto_slab"     // Roboto Slab — slab serif, technical editorial
  | "bitter"          // Bitter — screen-optimised slab serif
  | "space_grotesk"   // Space Grotesk — tech/startup geometric sans
  | "libre_franklin"; // Libre Franklin — news/editorial grotesque

export interface StyleControls {
  theme: "light" | "dark";
  brandColor: string;
  highlightColor: string;
  bgOpacity: number; // 0–100 default caption-pill opacity
  fontFamily: FontFamily;
  textAlign: "left" | "center" | "right";
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
  /**
   * Bottom scrim over a photo. "dark" (default) — the theme's dark scrim for
   * legibility. "brand" — the photo BLEEDS into the brand color at the bottom
   * (the moviefied photo→gradient blend; pairs with a bottom plain headline).
   * "none" — no scrim.
   */
  scrimMode?: "dark" | "brand" | "none";
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
  align?: "left" | "center" | "right";
  shape?: "pill" | "bar";
  emoji?: string;
  /**
   * "box" (default) — the boxed pill (hook-bars / desi-news look).
   * "plain" — boxless huge bold text directly on the background (moviefied /
   * premium-editorial headline). Highlight markup + brand highlight color still
   * apply; a drop shadow keeps it legible over a photo.
   */
  variant?: "box" | "plain";
}
export type CaptionStackBlockProps = {
  pills: CaptionPill[];
  /**
   * Optional brand label / wordmark rendered ABOVE the pills.
   *
   * `underline` (default false, Round 17): emit a short brand-accent underline bar
   * beneath the label ONLY when explicitly true. A style reference WITHOUT an
   * underline (the common case) renders no underline; only references that actually
   * show one opt in. The old behavior ALWAYS drew the bar — that was the bug.
   *
   * `color` (Round 17): the label text color. Defaults to the theme's textColor when
   * unset; callers pass the SAME resolved color the headline uses so the eyebrow and
   * headline never diverge (fixes "label turns black on regenerate" on a light theme).
   */
  label?: { text: string; italic?: boolean; underline?: boolean; color?: string };
};

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
const FONT_ALLOWLIST: readonly FontFamily[] = [
  // Original three — must stay first (vision classifier + existing callers use these)
  "inter", "serif_display", "condensed",
  // Round 15 additions
  "montserrat", "poppins", "bebas", "anton", "archivo_black",
  "dm_serif", "lora", "roboto_slab", "bitter", "space_grotesk", "libre_franklin",
];

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

export function safeAlign(a: string | undefined): "left" | "center" | "right" {
  return a === "center" ? "center" : a === "right" ? "right" : "left";
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

/**
 * All available font families with human-readable labels for UI dropdowns.
 * The original three appear first (preserving existing default/ordering); the
 * Round 15 additions follow. The UI font picker should render this list directly.
 */
export const FONT_OPTIONS: ReadonlyArray<{ value: FontFamily; label: string }> = [
  { value: "inter",          label: "Inter (modern sans)" },
  { value: "serif_display",  label: "Playfair (elegant serif)" },
  { value: "condensed",      label: "Oswald (condensed news)" },
  { value: "montserrat",     label: "Montserrat (bold geometric)" },
  { value: "poppins",        label: "Poppins (rounded modern)" },
  { value: "bebas",          label: "Bebas Neue (display impact)" },
  { value: "anton",          label: "Anton (ultra-heavy display)" },
  { value: "archivo_black",  label: "Archivo Black (bold grotesque)" },
  { value: "dm_serif",       label: "DM Serif (modern editorial)" },
  { value: "lora",           label: "Lora (refined serif)" },
  { value: "roboto_slab",    label: "Roboto Slab (technical slab)" },
  { value: "bitter",         label: "Bitter (screen slab)" },
  { value: "space_grotesk",  label: "Space Grotesk (tech sans)" },
  { value: "libre_franklin", label: "Libre Franklin (news grotesque)" },
] as const;

/** Map a FontFamily enum to a real CSS font-family stack. */
export function fontStack(f: FontFamily): string {
  switch (f) {
    // ── Original three (behavior unchanged) ─────────────────────────────────
    case "serif_display":  return "'Playfair Display',Georgia,serif";
    case "condensed":      return "'Oswald','Arial Narrow',sans-serif";
    // ── Round 15 additions ───────────────────────────────────────────────────
    case "montserrat":     return "'Montserrat','Trebuchet MS',sans-serif";
    case "poppins":        return "'Poppins','Helvetica Neue',sans-serif";
    case "bebas":          return "'Bebas Neue','Impact',sans-serif";
    case "anton":          return "'Anton','Impact',sans-serif";
    case "archivo_black":  return "'Archivo Black','Arial Black',sans-serif";
    case "dm_serif":       return "'DM Serif Display',Georgia,serif";
    case "lora":           return "'Lora',Georgia,serif";
    case "roboto_slab":    return "'Roboto Slab','Rockwell',serif";
    case "bitter":         return "'Bitter','Georgia',serif";
    case "space_grotesk":  return "'Space Grotesk','Helvetica Neue',sans-serif";
    case "libre_franklin": return "'Libre Franklin','Franklin Gothic Medium',sans-serif";
    case "inter":
    default:               return "'Inter',system-ui,sans-serif";
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
  // Bottom scrim: "brand" bleeds the photo into the brand color (moviefied blend),
  // "none" omits it, default "dark" keeps the theme's legibility scrim.
  const brandScrim = `<div class="scrim" style="position:absolute;inset:0;background:linear-gradient(to top, ${accent} 0%, ${accent}d9 16%, ${accent}33 44%, transparent 66%);"></div>`;
  const darkScrim = `<div class="scrim" style="position:absolute;inset:0;background:${themeTokens(controls).scrim};"></div>`;
  const scrim =
    props.scrimMode === "brand" ? brandScrim : props.scrimMode === "none" ? "" : darkScrim;

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
  return `<div class="tweet-head" style="position:absolute;top:48px;left:56px;right:56px;z-index:3;display:flex;align-items:center;gap:18px;">
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
/** Boxless-headline font size (px): fewer words → bigger, like a real news card. */
function plainCaptionFontSize(text: string): number {
  const words = text.trim().split(/\s+/).length;
  // Round 17: add a smaller >20-word step so very long headlines shrink further
  // (paired with the .caption-stack max-height bound below) instead of clipping.
  return words <= 6 ? 80
    : words <= 10 ? 68
    : words <= 14 ? 60
    : words <= 20 ? 52
    : words <= 28 ? 46
    : 40;
}

export function renderCaptionStack(props: CaptionStackBlockProps, controls: StyleControls): string {
  if (!props.pills?.length) return "";
  const pills = props.pills
    .map((p) => {
      const align = safeAlign(p.align ?? controls.textAlign);
      const emoji = safeEmoji(p.emoji);
      // Round 19 FIX 3: a pill whose text is empty/whitespace-only must NOT render an
      // empty box. The "box" variant paints a solid background even with no text →
      // a blank white/dark rectangle (the "empty headline box" bug some refs hit on
      // first generation when the headline reaches the pill empty). Skip the pill
      // entirely when there is no actual text to show — render nothing, not an empty
      // box. (The "plain" variant has no background so a stray empty plain pill is
      // harmless, but skip it too for cleanliness.) Tested in card-engine-render.
      if (!p.text || p.text.trim().length === 0) return "";
      const inner = renderHighlightMarkup(p.text, controls.highlightColor) + (emoji ? ` ${emoji}` : "");
      // Defence-in-depth: if markup somehow strips to empty (it shouldn't for
      // non-empty text), still skip rather than paint an empty box.
      if (inner.trim().length === 0) return "";
      // "plain" — boxless huge bold headline on the background (moviefied look).
      // No box, large font, drop shadow for legibility; highlight markup still applies.
      if (p.variant === "plain") {
        const fs = plainCaptionFontSize(p.text);
        const tc = safeColor(p.textColor ?? (controls.theme === "dark" ? "#ffffff" : "#0f1419"));
        const shadow = controls.theme === "dark" ? "text-shadow:0 2px 20px rgba(0,0,0,0.6);" : "";
        return `<div class="caption-plain" style="color:${tc};text-align:${align};font-weight:900;font-size:${fs}px;line-height:1.06;letter-spacing:-0.02em;word-break:break-word;${shadow}">${inner}</div>`;
      }
      // "box" (default) — unchanged boxed-pill behavior.
      const shape = safeShape(p.shape);
      const bg = safeColor(p.bg ?? (controls.theme === "dark" ? "#111111" : "#ffffff"));
      const opacity = clampOpacity(p.bgOpacity, controls.bgOpacity) / 100;
      const textColor = safeColor(p.textColor ?? (controls.theme === "dark" ? "#ffffff" : "#0f1419"));
      const radius = shape === "bar" ? 10 : 18;
      return `<div class="caption-pill" style="background:${bg};opacity:${opacity};color:${textColor};border-radius:${radius}px;padding:18px 24px;text-align:${align};font-weight:800;font-size:42px;line-height:1.15;box-shadow:0 6px 24px rgba(0,0,0,0.3);word-break:break-word;">${inner}</div>`;
    })
    .join("");
  // Optional brand label / wordmark above the headline.
  let label = "";
  if (props.label?.text) {
    const tokens = themeTokens(controls);
    const accent = safeColor(controls.brandColor);
    const labelShadow = controls.theme === "dark" ? "text-shadow:0 2px 14px rgba(0,0,0,0.55);" : "";
    const fontStyle = props.label.italic === false ? "normal" : "italic";
    // Round 17 FIX 3: label color defaults to the theme textColor but a caller can
    // pass its own (the SAME resolved color the headline uses) so they never diverge.
    const labelColor = safeColor(props.label.color ?? tokens.textColor);
    // Round 17 FIX 2: the brand-accent underline is per-reference, default OFF. Only
    // emit the bar when the caller (a reference that actually has one) opts in.
    const underline =
      props.label.underline === true
        ? `<div style="width:72px;height:5px;background:${accent};border-radius:3px;margin-top:10px;"></div>`
        : "";
    label =
      `<div class="caption-label" style="color:${labelColor};font-style:${fontStyle};font-weight:700;font-size:30px;letter-spacing:0.01em;${labelShadow}">` +
      `${escapeHtml(props.label.text)}` +
      underline +
      `</div>`;
  }
  // Round 17 FIX 6: bound the stack height so a long headline can't run off the top
  // of the canvas (overflow:hidden clips the worst-case overflow; max-height keeps the
  // block within the lower ~62% of the card).
  return `<div class="caption-stack" style="position:absolute;left:36px;right:36px;bottom:48px;max-height:62%;overflow:hidden;display:flex;flex-direction:column;gap:14px;z-index:3;">${label}${pills}</div>`;
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

// ── footer block ────────────────────────────────────────────────────────────
export function renderFooter(props: FooterBlockProps, controls: StyleControls): string {
  const tokens = themeTokens(controls);
  const color = safeColor(props.textColor ?? tokens.subTextColor);
  return `<div class="card-footer" style="position:absolute;left:56px;right:56px;bottom:44px;color:${color};font-size:24px;font-weight:600;text-align:${safeAlign(controls.textAlign)};z-index:3;">${escapeHtml(props.text)}</div>`;
}

// ── carouselChrome block ────────────────────────────────────────────────────
export function renderCarouselChrome(props: CarouselChromeBlockProps, controls: StyleControls): string {
  const total = Math.max(1, props.totalSlides);
  const cur = Math.max(0, Math.min(total - 1, props.currentSlide));
  const pct = Math.round(((cur + 1) / total) * 100);
  const parts: string[] = [];
  if (props.progressBar) {
    const color = safeColor(props.progressBar.color ?? controls.brandColor);
    const h = Math.max(2, props.progressBar.height ?? 6);
    parts.push(`<div style="position:absolute;top:0;left:0;right:0;height:${h}px;background:rgba(0,0,0,0.12);z-index:7;"><div style="height:100%;width:${pct}%;background:${color};"></div></div>`);
  }
  if (props.pageDots) {
    const dots = Array.from({ length: total }, (_v, i) =>
      `<span class="page-dot" style="width:10px;height:10px;border-radius:50%;background:${i === cur ? safeColor(controls.brandColor) : "rgba(255,255,255,0.5)"};"></span>`).join("");
    parts.push(`<div style="position:absolute;top:24px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:7;">${dots}</div>`);
  }
  if (props.navArrowHint && cur < total - 1) {
    parts.push(`<div class="nav-arrow" style="position:absolute;right:32px;top:50%;transform:translateY(-50%);color:#fff;font-size:48px;opacity:0.8;z-index:7;">›</div>`);
  }
  return parts.join("");
}

// ── ctaCard block ───────────────────────────────────────────────────────────
export function renderCtaCard(props: CtaCardBlockProps, controls: StyleControls): string {
  const bg = safeColor(props.bg ?? controls.brandColor);
  const phone = safeImageUrl(props.phoneAssetUrl);
  const button = props.buttonText
    ? `<div style="margin-top:32px;display:inline-flex;align-items:center;background:#fff;color:${bg};font-weight:900;font-size:34px;border-radius:999px;padding:18px 44px;">${escapeHtml(props.buttonText)}</div>`
    : "";
  const phoneHtml = phone
    ? `<img src="${phone}" style="margin-top:36px;max-width:60%;border-radius:28px;"/>`
    : "";
  const sub = props.subheading
    ? `<div style="margin-top:18px;color:rgba(255,255,255,0.85);font-size:30px;font-weight:600;">${escapeHtml(props.subheading)}</div>`
    : "";
  return `<div class="cta-card" style="position:absolute;inset:0;background:linear-gradient(135deg, ${bg}, #11131a);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 72px;z-index:2;">
  <div style="color:#fff;font-size:88px;font-weight:900;line-height:1.04;letter-spacing:-0.03em;word-break:break-word;">${escapeHtml(props.headline)}</div>
  ${sub}${button}${phoneHtml}
</div>`;
}

// ── renderCard composer ─────────────────────────────────────────────────────
// Original three families + Round 15 additions.
// Display/impact fonts request 700;800;900 so headlines are always bold; text
// serifs add 400;700 for body + heading weight variety.
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Playfair+Display:wght@700;900&family=Oswald:wght@500;700&family=Montserrat:wght@700;800;900&family=Poppins:wght@700;800;900&family=Bebas+Neue&family=Anton&family=Archivo+Black&family=DM+Serif+Display&family=Lora:wght@400;700&family=Roboto+Slab:wght@700;800;900&family=Bitter:wght@400;700&family=Space+Grotesk:wght@700;800&family=Libre+Franklin:wght@700;800;900&display=swap');`;

function renderBlock(block: Block, controls: StyleControls): string {
  switch (block.kind) {
    case "background": return renderBackground(block.props, controls);
    case "logo": return renderLogo(block.props, controls);
    case "circularInset": return renderCircularInset(block.props, controls);
    case "labelChip": return renderLabelChip(block.props, controls);
    case "tweetHeader": return renderTweetHeader(block.props, controls);
    case "captionStack": return renderCaptionStack(block.props, controls);
    case "statCards": return renderStatCards(block.props, controls);
    case "bodyText": return renderBodyText(block.props, controls);
    case "footer": return renderFooter(block.props, controls);
    case "carouselChrome": return renderCarouselChrome(block.props, controls);
    case "ctaCard": return renderCtaCard(block.props, controls);
    default: return "";
  }
}

/**
 * Render a CardSpec to a complete HTML document. Pure — no I/O. Each block is a
 * pure builder; a block with missing inputs returns "" and is simply skipped.
 * Rasterized to PNG by news-image-generator.generateStyledCreativeImage.
 */
export function renderCard(spec: CardSpec): string {
  const controls = spec.controls ?? DEFAULT_CONTROLS;
  const tokens = themeTokens(controls);
  const scale = Math.max(0.8, Math.min(1.5, controls.fontScale ?? 1));
  const body = spec.blocks.map((b) => renderBlock(b, controls)).join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${FONT_IMPORT}
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${CANVAS.w}px;height:${CANVAS.h}px;overflow:hidden;position:relative;font-family:${fontStack(controls.fontFamily)};font-size:${Math.round(16 * scale)}px;background:${tokens.bgFallback};-webkit-font-smoothing:antialiased;}
</style></head><body>
${body}
</body></html>`;
}

// ── Presets (data-driven; Component 1) ──────────────────────────────────────
export type PresetId =
  | "news_caption" | "news_inset" | "infographic_stats" | "marketing_minimal"
  | "tweet_card" | "photo_grid" | "title_cover" | "listicle_body";

const PRESET_BLOCKS: Record<PresetId, (c: StyleControls) => Block[]> = {
  news_caption: () => [
    { kind: "background", props: { mode: "photo" } },
    { kind: "logo", props: { logos: [] } },
    { kind: "captionStack", props: { pills: [{ text: "" }] } },
  ],
  news_inset: () => [
    { kind: "background", props: { mode: "photo" } },
    { kind: "logo", props: { logos: [] } },
    { kind: "circularInset", props: { items: [] } },
    { kind: "captionStack", props: { pills: [{ text: "" }] } },
    { kind: "labelChip", props: { pills: [] } },
  ],
  infographic_stats: () => [
    { kind: "background", props: { mode: "photo" } },
    { kind: "logo", props: { logos: [] } },
    { kind: "statCards", props: { cards: [] } },
    { kind: "captionStack", props: { pills: [{ text: "" }] } },
  ],
  marketing_minimal: () => [
    { kind: "background", props: { mode: "topTextBottomPhoto", overlayText: "" } },
    { kind: "logo", props: { logos: [] } },
    { kind: "carouselChrome", props: { totalSlides: 1, currentSlide: 0, progressBar: {} } },
  ],
  tweet_card: () => [
    { kind: "background", props: { mode: "gradient" } },
    { kind: "tweetHeader", props: { displayName: "", handle: "" } },
    { kind: "bodyText", props: { description: "" } },
  ],
  photo_grid: () => [
    { kind: "background", props: { mode: "photoGrid", imageUrls: [] } },
    { kind: "captionStack", props: { pills: [{ text: "" }] } },
  ],
  title_cover: () => [
    { kind: "background", props: { mode: "gradient" } },
    { kind: "logo", props: { logos: [] } },
    { kind: "bodyText", props: { description: "" } },
  ],
  listicle_body: () => [
    { kind: "background", props: { mode: "photo" } },
    { kind: "bodyText", props: { description: "" } },
    { kind: "footer", props: { text: "" } },
    { kind: "logo", props: { logos: [] } },
  ],
};

/** Named CardSpec factory — the detector's target and a user-pickable preset. */
export function preset(id: PresetId, data?: Partial<StyleControls>): CardSpec {
  const controls: StyleControls = {
    ...DEFAULT_CONTROLS,
    ...(data ?? {}),
    brandColor: safeColor(data?.brandColor ?? DEFAULT_CONTROLS.brandColor),
    highlightColor: safeColor(data?.highlightColor ?? DEFAULT_CONTROLS.highlightColor),
    fontFamily: safeFontFamily(data?.fontFamily),
    textAlign: safeAlign(data?.textAlign),
    bgOpacity: clampOpacity(data?.bgOpacity, DEFAULT_CONTROLS.bgOpacity),
  };
  const builder = PRESET_BLOCKS[id] ?? PRESET_BLOCKS.news_caption;
  return { canvas: CANVAS, blocks: builder(controls), controls };
}

// ── Headline integrity (Component 6) ────────────────────────────────────────
const HEADLINE_MAX_WORDS = 16;
const HEADLINE_MAX_CHARS = 90;

/**
 * Cap a headline to ≤16 words / ≤90 chars WITHOUT ending mid-word or mid-sentence.
 * Prefers a full-clause cut within budget; else appends "…". Ported from
 * repurpose.router.ts:285 so the engine is self-contained.
 */
export function capHeadline(text: string): string {
  const cleaned = (text ?? "").trim().replace(/\s+/g, " ");
  const words = cleaned.split(" ");
  if (words.length <= HEADLINE_MAX_WORDS && cleaned.length <= HEADLINE_MAX_CHARS) return cleaned;
  let out = words.slice(0, HEADLINE_MAX_WORDS).join(" ");
  while (out.length > HEADLINE_MAX_CHARS && out.includes(" ")) {
    out = out.slice(0, out.lastIndexOf(" "));
  }
  const lastStop = Math.max(out.lastIndexOf(". "), out.lastIndexOf("? "), out.lastIndexOf("! "));
  if (lastStop > out.length * 0.6) return out.slice(0, lastStop + 1).trim();
  return out.replace(/[\s,;:–—-]+$/, "").trim() + "…";
}

/** Cut body to maxChars on a whole-word boundary; append "…" when truncated. */
export function capBody(text: string, maxChars: number): string {
  const cleaned = (text ?? "").trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) return cleaned;
  let out = cleaned.slice(0, maxChars);
  if (out.includes(" ")) out = out.slice(0, out.lastIndexOf(" "));
  return out.replace(/[\s,;:–—-]+$/, "").trim() + "…";
}

function tokenSet(s: string): Set<string> {
  return new Set(
    (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean),
  );
}

/** Token-Jaccard similarity in [0,1]; case/punctuation insensitive. */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenSet(a), sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

const HOOK_DUP_THRESHOLD = 0.7;

/**
 * Return the hook only if it is meaningfully different from the headline
 * (Jaccard < threshold); otherwise "" so the caller never renders the headline
 * twice (Component 6: hook≠headline, subhead≠headline). Empty/whitespace → "".
 */
export function dedupeHook(hook: string, headline: string): string {
  const h = (hook ?? "").trim();
  if (!h) return "";
  return jaccardSimilarity(h, headline) >= HOOK_DUP_THRESHOLD ? "" : h;
}

// ── Compatibility shim (Component 8 / §8) ───────────────────────────────────
/**
 * The subset of the legacy StaticCreativeOptions the shim needs. Kept local so
 * card-engine has no import cycle with creative-templates.ts. NewsGrid/Autopilot
 * callers map their existing options onto this and render through renderCard.
 */
export interface LegacyStyleInput {
  style: "premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic";
  headline: string;
  channelName: string;
  hookLine?: string;
  handle?: string;
  verified?: boolean;
  bgImageUrl?: string;
  logoUrl?: string | null;
}

function logosFromLegacy(input: LegacyStyleInput, controls: StyleControls): LogoBlock[] {
  const src = safeImageUrl(input.logoUrl ?? undefined);
  const anchor: LogoBlock["anchor"] = controls.logoPosition;
  if (src) return [{ kind: "image", src, anchor, size: 7, opacity: 100 }];
  // No logo image → a wordmark of the channel name (matches old initial-avatar intent).
  return [{ kind: "wordmark", text: input.channelName, anchor, size: 9, opacity: 100 }];
}

/**
 * Map an old creativeStyle id → CardSpec so existing callers keep rendering
 * through the new engine. premium_editorial→news_caption, hook_bars→news_caption
 * w/ 2 pills (deduped), tweet_card→tweet_card, bold_typographic→title_cover.
 */
export function legacyStyleToCardSpec(input: LegacyStyleInput, controls: StyleControls): CardSpec {
  const headline = capHeadline(input.headline);
  const bg = safeImageUrl(input.bgImageUrl) ?? undefined;
  const bgBlock: Block = {
    kind: "background",
    props: { mode: bg ? "photo" : "gradient", imageUrl: bg },
  };
  const logoBlock: Block = { kind: "logo", props: { logos: logosFromLegacy(input, controls) } };

  switch (input.style) {
    case "tweet_card":
      return {
        canvas: CANVAS, controls,
        blocks: [
          { kind: "background", props: { mode: "gradient" } },
          { kind: "tweetHeader", props: { displayName: input.channelName, handle: (input.handle ?? "").replace(/^@/, ""), verified: input.verified, logoUrl: input.logoUrl ?? undefined } },
          { kind: "bodyText", props: { description: headline } },
        ],
      };
    case "bold_typographic":
      return {
        canvas: CANVAS, controls,
        blocks: [
          bgBlock, logoBlock,
          { kind: "bodyText", props: { title: headline, description: "" } },
        ],
      };
    case "hook_bars": {
      const hook = dedupeHook(input.hookLine ?? "", headline);
      const pills: CaptionPill[] = hook
        ? [{ text: hook }, { text: headline }]
        : [{ text: headline }];
      return {
        canvas: CANVAS, controls,
        blocks: [bgBlock, logoBlock, { kind: "captionStack", props: { pills } }],
      };
    }
    case "premium_editorial":
    default:
      return {
        canvas: CANVAS, controls,
        blocks: [bgBlock, logoBlock, { kind: "captionStack", props: { pills: [{ text: headline }] } }],
      };
  }
}
