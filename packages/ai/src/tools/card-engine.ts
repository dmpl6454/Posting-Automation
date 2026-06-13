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
