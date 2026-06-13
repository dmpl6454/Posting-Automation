/**
 * Re-sanitize a stored CardSpec JSON blob before it is rendered (Component 9 /
 * §4). NEVER trust a stored CreativeTemplate.cardSpec row — every color/url/enum
 * is re-validated through the SAME guards the renderer uses (`safeColor`,
 * `safeImageUrl`). A tampered DB row (manual edit, future bug) therefore cannot
 * inject CSS/HTML at render time. Returns null for a structurally-invalid blob
 * so the caller falls back to a fresh preset rather than rendering garbage.
 */
import { safeColor, safeImageUrl } from "@postautomation/ai";

const DEFAULT_ACCENT = "#e11d48";
const KNOWN_BLOCKS = new Set([
  "background", "logo", "circularInset", "labelChip", "tweetHeader",
  "captionStack", "statCards", "bodyText", "footer", "carouselChrome", "ctaCard",
]);
const FONTS = new Set(["inter", "serif_display", "condensed"]);
const ALIGNS = new Set(["left", "center"]);
const LOGO_POS = new Set(["tl", "tr", "bl", "br"]);

const clampOpacity = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100;

/** CardSpecs are shallow; cap recursion so a pathologically-nested poisoned row
 *  degrades to a dropped sub-tree instead of throwing a RangeError up the stack. */
const MAX_DEPTH = 8;

/** Recursively re-sanitize known color/url/opacity props on a block's props object. */
function sanitizeBlockProps(props: any, depth = 0): any {
  if (depth > MAX_DEPTH) return Array.isArray(props) ? [] : {};
  if (!props || typeof props !== "object") return props;
  const out: any = Array.isArray(props) ? [...props] : { ...props };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (Array.isArray(v)) {
      // Bare-string url arrays (e.g. imageUrls) are sanitized element-wise here
      // for layer-consistency (the renderer also re-checks each before interpolation).
      if (/urls?$/i.test(key)) {
        out[key] = v
          .filter((x: unknown): x is string => typeof x === "string")
          .map((x: string) => safeImageUrl(x))
          .filter((u): u is string => u !== null);
      } else {
        out[key] = v.map((item) => sanitizeBlockProps(item, depth + 1));
      }
    } else if (v && typeof v === "object") {
      out[key] = sanitizeBlockProps(v, depth + 1);
    } else if (typeof v === "string") {
      // Color-ish keys → safeColor; url-ish keys → safeImageUrl (drop if rejected).
      if (/color$/i.test(key) || key === "bg") {
        out[key] = safeColor(v);
      } else if (/url$/i.test(key) || /^(src|imageUrl|resolvedUrl)$/.test(key)) {
        const safe = safeImageUrl(v);
        if (safe === null) delete out[key];
        else out[key] = safe;
      }
    } else if (key === "bgOpacity" || key === "opacity") {
      out[key] = clampOpacity(v);
    }
  }
  return out;
}

export function sanitizeCardSpecJson(raw: unknown): {
  canvas: { w: 1080; h: 1350 };
  blocks: Array<{ kind: string; props: any }>;
  controls: {
    theme: "light" | "dark";
    brandColor: string;
    highlightColor: string;
    bgOpacity: number;
    fontFamily: string;
    textAlign: "left" | "center";
    logoPosition: "tl" | "tr" | "bl" | "br";
    fontScale?: number;
  };
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as any;
  if (!Array.isArray(r.blocks)) return null;

  const c = r.controls ?? {};
  const controls = {
    theme: c.theme === "dark" ? ("dark" as const) : ("light" as const),
    brandColor: safeColor(c.brandColor) || DEFAULT_ACCENT,
    highlightColor: safeColor(c.highlightColor) || DEFAULT_ACCENT,
    bgOpacity: clampOpacity(c.bgOpacity),
    fontFamily: FONTS.has(c.fontFamily) ? c.fontFamily : "inter",
    textAlign: ALIGNS.has(c.textAlign) ? c.textAlign : ("left" as const),
    logoPosition: LOGO_POS.has(c.logoPosition) ? c.logoPosition : ("tr" as const),
    ...(typeof c.fontScale === "number" ? { fontScale: Math.max(0.8, Math.min(1.5, c.fontScale)) } : {}),
  };

  const blocks = r.blocks
    .filter((b: any) => b && typeof b === "object" && KNOWN_BLOCKS.has(b.kind))
    .map((b: any) => ({ kind: b.kind, props: sanitizeBlockProps(b.props ?? {}) }));

  return { canvas: { w: 1080, h: 1350 }, blocks, controls };
}
