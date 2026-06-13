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
