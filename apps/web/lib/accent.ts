/**
 * Accent colour theming.
 *
 * The design ships one palette with a user-selectable accent: everything else
 * (backgrounds, cards, text, borders, charts) stays put and only the accent
 * moves. The design file drives this by overwriting its `--gold*` CSS vars on
 * :root; this is the same idea against OUR token names.
 *
 * ⚠️ Our accent tokens are HSL TRIPLETS (`42.2 41.5% 38.2%`), consumed as
 * `hsl(var(--accent-gold))`, so a hex has to be converted — writing a hex
 * straight into the var yields `hsl(#6C93D1)`, which is invalid and silently
 * drops the colour everywhere it is used.
 */

export interface AccentOption {
  name: string;
  hex: string;
}

/** The design's seven accents. Yellow is the default (the shipped palette). */
export const ACCENT_OPTIONS: AccentOption[] = [
  { name: "Yellow", hex: "#8A7239" },
  { name: "Blue", hex: "#6C93D1" },
  { name: "Purple", hex: "#A183C9" },
  { name: "Green", hex: "#6FAE7D" },
  { name: "Red", hex: "#C9695F" },
  { name: "Pink", hex: "#C97FA0" },
  { name: "Orange", hex: "#C98B56" },
];

export const DEFAULT_ACCENT = ACCENT_OPTIONS[0]!.hex;

/**
 * Bumped to `-v2` to reset every browser back to the design's Yellow.
 *
 * A stored "Blue" was making the whole app render blue where the mockup is gold
 * — every `--accent-gold` token (CTAs, active chips, chart bars, avatars) picks
 * up this value, so no amount of CSS work could make the app look like the
 * mockup while it was set. Bumping the key drops the old value rather than
 * reading it, so the app opens on the design default; the Accent Color picker
 * in Settings still works exactly as before and writes to the new key.
 */
export const ACCENT_STORAGE_KEY = "cs_accent_color_v2";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Strict — anything unrecognised falls back to the default rather than being
 *  interpolated into CSS. Mirrors `safeColor` in the creative templates. */
export function normalizeAccent(hex: string | null | undefined): string {
  if (!hex || !HEX_RE.test(hex)) return DEFAULT_ACCENT;
  const match = ACCENT_OPTIONS.find(
    (a) => a.hex.toLowerCase() === hex.toLowerCase()
  );
  return match ? match.hex : DEFAULT_ACCENT;
}

export function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16),
  ];
}

/** Returns the `h s% l%` triplet our tokens expect (no `hsl()` wrapper). */
export function hexToHslTriplet(hex: string): string {
  const [r255, g255, b255] = hexToRgb(hex);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(h * 360)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/**
 * Writes the accent onto :root as INLINE styles, which outrank the stylesheet
 * in both themes — so the choice holds in light and dark alike, exactly as the
 * design's copy promises ("changes buttons and highlights across the app").
 */
export function applyAccent(hex: string): void {
  if (typeof document === "undefined") return;
  const safe = normalizeAccent(hex);
  const [r, g, b] = hexToRgb(safe);
  const triplet = hexToHslTriplet(safe);
  const root = document.documentElement.style;
  root.setProperty("--accent-gold", triplet);
  /*
   * ⚠️ `--accent-border` is the DARK, low-lightness edge the design puts around
   * a tinted accent chip (the palette's #3A2F17 next to gold #8A7239) — it is
   * NOT the accent itself. Writing `triplet` here made the two identical, so
   * every `border-[hsl(var(--accent-border))]` in the app drew a full-strength
   * accent hairline instead of the muted one, on ~11 pages at once. Measured on
   * the Approvals filter: rgb(138,114,57) where the design wants rgb(58,47,23).
   *
   * Derived by holding the picked hue/saturation and dropping lightness to the
   * stylesheet's own 15.9%, so any accent keeps the design's edge treatment.
   */
  const [h, s] = triplet.split(" ");
  root.setProperty("--accent-border", `${h} ${s} 15.9%`);
  root.setProperty("--ring", triplet);
  root.setProperty("--gold-glow", `0 0 6px rgba(${r}, ${g}, ${b}, 0.3)`);
}

export function readStoredAccent(): string {
  if (typeof window === "undefined") return DEFAULT_ACCENT;
  try {
    return normalizeAccent(window.localStorage.getItem(ACCENT_STORAGE_KEY));
  } catch {
    // private mode / blocked storage — the default is always safe
    return DEFAULT_ACCENT;
  }
}

export function storeAccent(hex: string): void {
  try {
    window.localStorage.setItem(ACCENT_STORAGE_KEY, normalizeAccent(hex));
  } catch {
    // non-fatal: the accent still applies for this page's lifetime
  }
}
