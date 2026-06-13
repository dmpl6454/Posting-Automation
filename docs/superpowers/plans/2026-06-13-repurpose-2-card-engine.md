# Composable Card Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the static/carousel creative renderer into a composable block-composition engine (`CardSpec` → `renderCard` → HTML) covering spec Components 1, 1.1, 2, and 6, while keeping NewsGrid/Autopilot callers working via a compatibility shim so existing posts are unaffected.

**Architecture:** A new pure module `packages/ai/src/tools/card-engine.ts` exposes the `CardSpec` type (an ordered list of 11 discriminated `Block` kinds over a fixed 1080×1350 canvas + `StyleControls`), one pure builder per block, a `renderCard` composer, 8 data-driven preset factories, a per-span highlight markup system, and headline-integrity helpers. Every interpolated value flows through extended sanitizers (`safeColor` on every color, opacity clamp, font/align/shape enums, emoji whitelist). The existing `creative-templates.ts` builders stay intact behind a `legacyStyleToCardSpec` shim that maps the four old style ids onto presets, so `news-image-generator.ts` and all current callers render through the engine without code changes elsewhere.

**Tech Stack:** TypeScript (strict, ES2022, bundler resolution), Vitest, pnpm workspaces, Turborepo. Renderer is pure HTML-string generation; PNG rasterization stays in `news-image-generator.ts` (Puppeteer) and is out of scope for this plan.

---

## Files

| File | Create/Modify | Responsibility |
|------|---------------|----------------|
| `packages/ai/src/tools/card-engine.ts` | Create | The composable engine: `CardSpec`/`Block` union/`StyleControls`/`CaptionPill`/`LogoBlock`/`ImageSlot` types, extended sanitizers, `renderHighlightMarkup`, all 11 block builders, `renderCard`, 8 presets, `capHeadline`/`capBody`, dedup similarity check, `legacyStyleToCardSpec` shim. |
| `packages/ai/src/__tests__/card-engine-types.test.ts` | Create | Compile-time + runtime smoke for the type contract (canvas shape, block discriminants). |
| `packages/ai/src/__tests__/card-engine-sanitizers.test.ts` | Create | Sanitizer triad + new helpers (`clampOpacity`, `safeFontFamily`, `safeAlign`, `safeShape`, `safeEmoji`) incl. injection. |
| `packages/ai/src/__tests__/card-engine-highlight.test.ts` | Create | `renderHighlightMarkup` per-span `[[text|#hex|box]]` + legacy `**text**` + XSS span breakout. |
| `packages/ai/src/__tests__/card-engine-blocks.test.ts` | Create | One `describe` block per block builder (background, logo, circularInset, labelChip, tweetHeader, captionStack, statCards, bodyText, footer, carouselChrome, ctaCard). |
| `packages/ai/src/__tests__/card-engine-render.test.ts` | Create | `renderCard` composition: ordering, omitted blocks, theme honoring, full doc shape. |
| `packages/ai/src/__tests__/card-engine-presets.test.ts` | Create | 8 preset factories + a hand-built composite CardSpec (proves composability). |
| `packages/ai/src/__tests__/card-engine-headline.test.ts` | Create | `capHeadline`/`capBody` integrity + `dedupeHook` similarity (hook≠headline, subhead≠headline). |
| `packages/ai/src/__tests__/card-engine-shim.test.ts` | Create | `legacyStyleToCardSpec` mapping for all 4 old style ids. |
| `packages/ai/src/index.ts` | Modify | Export the new engine surface (`renderCard`, `preset`, `legacyStyleToCardSpec`, types). |

---

### Task 1: Type contract + canvas constants

**Files:**
- Create: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-types.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CANVAS, DEFAULT_CONTROLS, type CardSpec, type Block } from "../tools/card-engine";

describe("card-engine type contract", () => {
  it("exposes a fixed 1080x1350 canvas constant", () => {
    expect(CANVAS).toEqual({ w: 1080, h: 1350 });
  });

  it("provides sane default StyleControls", () => {
    expect(DEFAULT_CONTROLS.theme).toBe("light");
    expect(DEFAULT_CONTROLS.textAlign).toBe("left");
    expect(DEFAULT_CONTROLS.fontFamily).toBe("inter");
    expect(DEFAULT_CONTROLS.logoPosition).toBe("tr");
    expect(DEFAULT_CONTROLS.bgOpacity).toBe(100);
  });

  it("accepts a minimal CardSpec with a discriminated block union", () => {
    const block: Block = { kind: "footer", props: { text: "Follow @x for more" } };
    const spec: CardSpec = { canvas: CANVAS, blocks: [block], controls: DEFAULT_CONTROLS };
    expect(spec.blocks[0]!.kind).toBe("footer");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-types` → expected: `Cannot find module '../tools/card-engine'` / suite fails.
- [ ] **Step 3: Minimal implementation.** Create `packages/ai/src/tools/card-engine.ts` with ONLY the types + constants (no builders yet):
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-types` → expected: `3 passed`.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-types.test.ts
git commit -m "feat(card-engine): CardSpec type contract + canvas/default controls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extended sanitizers (per-block fields)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-sanitizers.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-sanitizers.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  safeColor, safeImageUrl, escapeHtml,
  clampOpacity, safeFontFamily, safeAlign, safeShape, safeEmoji,
  DEFAULT_ACCENT,
} from "../tools/card-engine";

describe("safeColor", () => {
  it("accepts valid hex", () => {
    expect(safeColor("#e11d48")).toBe("#e11d48");
    expect(safeColor("#fff")).toBe("#fff");
  });
  it("rejects injection and falls back to default accent", () => {
    expect(safeColor('red;}</style><script>alert(1)</script>')).toBe(DEFAULT_ACCENT);
    expect(safeColor(undefined)).toBe(DEFAULT_ACCENT);
  });
});

describe("safeImageUrl", () => {
  it("accepts https + data:image", () => {
    expect(safeImageUrl("https://cdn.x/a.png?q=1")).toBe("https://cdn.x/a.png?q=1");
    expect(safeImageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
  it("rejects breakout chars and non-image schemes", () => {
    expect(safeImageUrl(`https://x/a.png);}</style><script>`)).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes &<>\" and single quote", () => {
    expect(escapeHtml(`<b>"x"</b> & 'y'`)).toBe(`&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#39;y&#39;`);
  });
});

describe("clampOpacity", () => {
  it("clamps to [0,100] and defaults non-numbers", () => {
    expect(clampOpacity(50)).toBe(50);
    expect(clampOpacity(-10)).toBe(0);
    expect(clampOpacity(250)).toBe(100);
    expect(clampOpacity(undefined, 80)).toBe(80);
    expect(clampOpacity(NaN, 100)).toBe(100);
  });
});

describe("enum guards", () => {
  it("safeFontFamily allowlists fonts", () => {
    expect(safeFontFamily("serif_display")).toBe("serif_display");
    expect(safeFontFamily("evil; }")).toBe("inter");
    expect(safeFontFamily(undefined)).toBe("inter");
  });
  it("safeAlign / safeShape enums", () => {
    expect(safeAlign("center")).toBe("center");
    expect(safeAlign("right")).toBe("left");
    expect(safeShape("bar")).toBe("bar");
    expect(safeShape("octagon")).toBe("pill");
  });
  it("safeEmoji passes a short emoji and drops markup", () => {
    expect(safeEmoji("🚨")).toBe("🚨");
    expect(safeEmoji(`"><script>`)).toBe("");
    expect(safeEmoji("ABCDEFGHIJ")).toBe(""); // too long / not emoji range
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-sanitizers` → expected: import errors (`clampOpacity`, `safeFontFamily`, etc. not exported).
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-sanitizers` → expected: all describe blocks pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-sanitizers.test.ts
git commit -m "feat(card-engine): extended sanitizers (opacity clamp, font/align/shape/emoji guards)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Per-span highlight markup system

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-highlight.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-highlight.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderHighlightMarkup, DEFAULT_ACCENT } from "../tools/card-engine";

describe("renderHighlightMarkup", () => {
  it("renders [[text]] in accent color, text mode", () => {
    const html = renderHighlightMarkup("Hello [[World]]", "#00ff00");
    expect(html).toContain("Hello ");
    expect(html).toContain(`color:#00ff00`);
    expect(html).toContain(">World</span>");
  });

  it("renders [[text|#hex]] with explicit color", () => {
    const html = renderHighlightMarkup("[[Red]] now", "#000000");
    expect(html).toContain(`color:#ff0000`.replace("#ff0000", "#ff0000")); // explicit
    expect(html).toContain(">Red</span>");
  });

  it("renders [[text|#hex|box]] as a solid highlight box", () => {
    const html = renderHighlightMarkup("[[Boxed|#ffcc00|box]] word", "#000000");
    expect(html).toContain("background:#ffcc00");
    expect(html).toContain(">Boxed</span>");
    expect(html).not.toContain("color:#ffcc00;background:transparent"); // it's box mode
  });

  it("supports multiple independently-colored spans in one line", () => {
    const html = renderHighlightMarkup("[[A|#111]] and [[B|#222|box]]", "#999999");
    expect(html).toContain("color:#111");
    expect(html).toContain("background:#222");
  });

  it("maps legacy **text** to default-accent text mode", () => {
    const html = renderHighlightMarkup("TMC ka **Pushpa** rises", "#e11d48");
    expect(html).toContain(`color:#e11d48`);
    expect(html).toContain(">Pushpa</span>");
  });

  it("escapes plain text and span text (no XSS, no attribute breakout)", () => {
    const html = renderHighlightMarkup(`<img onerror=x> [[a<b>c]] & "z"`, DEFAULT_ACCENT);
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;");
  });

  it("rejects a malicious span color (injection) and uses default accent", () => {
    const html = renderHighlightMarkup(`[[x|#fff" onload=alert(1)]]`, DEFAULT_ACCENT);
    expect(html).not.toContain("onload=alert(1)");
    expect(html).toContain(`color:${DEFAULT_ACCENT}`);
  });

  it("leaves unbalanced markup as escaped literal text", () => {
    const html = renderHighlightMarkup("Half [[open span here", DEFAULT_ACCENT);
    expect(html).toContain("[[open span here");
    expect(html).not.toContain("<span");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-highlight` → expected: `renderHighlightMarkup` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
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
 * crafted span color can never break out of the style attribute. Unbalanced
 * markup is left as escaped literal text.
 */
export function renderHighlightMarkup(text: string, accentColor: string): string {
  const accent = safeColor(accentColor);
  let out = escapeHtml(text ?? "");

  // [[ text | #hex | box ]]  — color + mode optional. `[^\[\]|]` so spans never
  // swallow another marker; the body is already escaped (no raw < > " ').
  out = out.replace(
    /\[\[([^\[\]|]+?)(?:\|(#[0-9a-fA-F]{3,8}|[^\[\]|]*))?(?:\|(box|text))?\]\]/g,
    (_m, body: string, rawColor: string | undefined, mode: string | undefined) => {
      const color = safeColor(rawColor);
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-highlight` → expected: all 8 pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-highlight.test.ts
git commit -m "feat(card-engine): per-span [[text|#hex|box]] highlight markup + legacy ** mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `background` block builder (all BackgroundMode variants)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (new file; this task adds the `renderBackground` describe block)

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-blocks.test.ts` with the background describe (later tasks append more describe blocks to this same file):
```ts
import { describe, it, expect } from "vitest";
import {
  renderBackground, DEFAULT_CONTROLS,
  type BackgroundBlockProps, type StyleControls,
} from "../tools/card-engine";

const C: StyleControls = { ...DEFAULT_CONTROLS };

describe("renderBackground", () => {
  it("photo mode uses the sanitized image as cover bg", () => {
    const html = renderBackground({ mode: "photo", imageUrl: "https://cdn.x/p.jpg" }, C);
    expect(html).toContain("https://cdn.x/p.jpg");
    expect(html).toContain("background-size:cover");
  });

  it("photo mode with a malicious url falls back to gradient (no breakout)", () => {
    const html = renderBackground(
      { mode: "photo", imageUrl: `https://x/p.jpg);}</style><script>alert(1)</script>` },
      C,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("linear-gradient(");
  });

  it("ai mode renders the provided AI image like a photo", () => {
    const html = renderBackground({ mode: "ai", imageUrl: "data:image/png;base64,AAAA" }, C);
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("gradient mode renders a branded gradient from the controls brand color", () => {
    const html = renderBackground({ mode: "gradient" }, { ...C, brandColor: "#123456" });
    expect(html).toContain("#123456");
    expect(html).toContain("linear-gradient(");
  });

  it("splitPhotos renders a 2-up grid when two images are present", () => {
    const html = renderBackground(
      { mode: "splitPhotos", imageUrls: ["https://x/a.jpg", "https://x/b.jpg"] }, C);
    expect(html).toContain("https://x/a.jpg");
    expect(html).toContain("https://x/b.jpg");
    expect(html).toContain("grid-template-columns:1fr 1fr");
  });

  it("photoGrid renders up to 4 tiles", () => {
    const html = renderBackground(
      { mode: "photoGrid", imageUrls: ["https://x/1.jpg","https://x/2.jpg","https://x/3.jpg","https://x/4.jpg"] }, C);
    expect((html.match(/https:\/\/x\//g) || []).length).toBe(4);
  });

  it("topTextBottomPhoto renders an escaped text band + photo", () => {
    const html = renderBackground(
      { mode: "topTextBottomPhoto", imageUrl: "https://x/p.jpg", overlayText: "<b>BIG</b>" }, C);
    expect(html).toContain("&lt;b&gt;BIG");
    expect(html).toContain("https://x/p.jpg");
  });

  it("screenshot mode renders a device frame around the image", () => {
    const html = renderBackground({ mode: "screenshot", imageUrl: "https://x/ui.jpg" }, C);
    expect(html).toContain("https://x/ui.jpg");
    expect(html).toContain("screenshot-frame");
  });

  it("subjectComposite with no image degrades to gradient (never broken slot)", () => {
    const html = renderBackground({ mode: "subjectComposite" }, C);
    expect(html).toContain("linear-gradient(");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderBackground` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: the `renderBackground` describe passes (9 tests).
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): background block builder (all 8 BackgroundMode variants)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `logo` block builder (multi-logo + watermark)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderLogo` describe)

- [ ] **Step 1: Write the failing test.** Append to `packages/ai/src/__tests__/card-engine-blocks.test.ts`:
```ts
import { renderLogo, type LogoBlockProps } from "../tools/card-engine";

describe("renderLogo", () => {
  it("renders an image logo with sanitized src", () => {
    const html = renderLogo({ logos: [{ kind: "image", src: "https://cdn.x/logo.png", anchor: "tr", size: 8, opacity: 100 }] }, C);
    expect(html).toContain("https://cdn.x/logo.png");
  });
  it("renders a wordmark with escaped text", () => {
    const html = renderLogo({ logos: [{ kind: "wordmark", text: "BOLLYWOOD <CHRONICLE>", anchor: "bl", size: 10, opacity: 100 }] }, C);
    expect(html).toContain("BOLLYWOOD &lt;CHRONICLE&gt;");
  });
  it("renders a monogram", () => {
    const html = renderLogo({ logos: [{ kind: "monogram", text: "DS", anchor: "tl", size: 6, opacity: 100 }] }, C);
    expect(html).toContain(">DS<");
  });
  it("renders multiple independently-anchored logos", () => {
    const html = renderLogo({ logos: [
      { kind: "wordmark", text: "MAM", anchor: "tl", size: 8, opacity: 100 },
      { kind: "image", src: "https://cdn.x/kfc.png", anchor: "br", size: 12, opacity: 100 },
    ] }, C);
    expect(html).toContain("MAM");
    expect(html).toContain("https://cdn.x/kfc.png");
  });
  it("renders a faint watermark at reduced opacity", () => {
    const html = renderLogo({ logos: [{ kind: "wordmark", text: "WM", anchor: "mc", size: 30, opacity: 12, watermark: true }] }, C);
    expect(html).toContain("opacity:0.12");
  });
  it("clamps an out-of-range size and rejects a malicious box bg", () => {
    const html = renderLogo({ logos: [{ kind: "wordmark", text: "X", anchor: "tr", size: 999, opacity: 100, box: { bg: "red;}</style>", opacity: 100, radius: 8, pad: 6 } }] }, C);
    expect(html).not.toContain("red;}</style>");
    expect(html).not.toMatch(/width:999%/);
  });
  it("emits nothing for an empty logo array", () => {
    expect(renderLogo({ logos: [] }, C)).toBe("");
  });
  it("drops a logo with a malicious src (no image emitted) but keeps valid siblings", () => {
    const html = renderLogo({ logos: [
      { kind: "image", src: `https://x/a.png"><script>alert(1)</script>`, anchor: "tr", size: 8, opacity: 100 },
      { kind: "wordmark", text: "OK", anchor: "tl", size: 8, opacity: 100 },
    ] }, C);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("OK");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderLogo` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderBackground` + `renderLogo` describes pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): logo block builder (image/wordmark/monogram, multi-logo, watermark, 9-pt anchor)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `circularInset` block builder (1–N insets)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderCircularInset` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderCircularInset, type CircularInsetBlockProps } from "../tools/card-engine";

describe("renderCircularInset", () => {
  it("renders a single circular inset with a colored ring", () => {
    const html = renderCircularInset({ items: [{ imageUrl: "https://x/face.jpg", position: { top: 200, left: 60 }, size: 300, ringColor: "#ff0000", ringWidth: 6 }] }, C);
    expect(html).toContain("https://x/face.jpg");
    expect(html).toContain("border-radius:50%");
    expect(html).toContain("border:6px solid #ff0000");
  });
  it("renders multiple insets (Hema ×2)", () => {
    const html = renderCircularInset({ items: [
      { imageUrl: "https://x/a.jpg", position: { top: 100, left: 60 }, size: 240 },
      { imageUrl: "https://x/b.jpg", position: { top: 100, left: 360 }, size: 240 },
    ] }, C);
    expect((html.match(/border-radius:50%/g) || []).length).toBe(2);
  });
  it("skips an item with a malicious url and keeps valid ones", () => {
    const html = renderCircularInset({ items: [
      { imageUrl: `https://x/a.jpg");}</style>`, position: { top: 0, left: 0 }, size: 100 },
      { imageUrl: "https://x/ok.jpg", position: { top: 0, left: 120 }, size: 100 },
    ] }, C);
    expect(html).not.toContain(`https://x/a.jpg");}</style>`);
    expect(html).toContain("https://x/ok.jpg");
  });
  it("emits nothing when no items", () => {
    expect(renderCircularInset({ items: [] }, C)).toBe("");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderCircularInset` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all describes so far pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): circularInset block builder (1-N ringed inset images)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `labelChip` block builder (1–N positioned pills)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderLabelChip` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderLabelChip, type LabelChipBlockProps } from "../tools/card-engine";

describe("renderLabelChip", () => {
  it("renders a positioned pill with bg + highlight markup", () => {
    const html = renderLabelChip({ pills: [{ text: "[[History Created|#ffd700|box]]", bg: "#000000", textColor: "#ffffff", position: { top: 80, left: 60 }, shape: "pill" }] }, C);
    expect(html).toContain("background:#000000");
    expect(html).toContain("background:#ffd700"); // the box-mode span
    expect(html).toContain("History Created");
  });
  it("renders multiple chips with mixed colors", () => {
    const html = renderLabelChip({ pills: [
      { text: "Rejected", bg: "#e11d48" },
      { text: "Approved", bg: "#16a34a" },
    ] }, C);
    expect(html).toContain("#e11d48");
    expect(html).toContain("#16a34a");
  });
  it("applies a per-pill bgOpacity overriding the global default", () => {
    const html = renderLabelChip({ pills: [{ text: "x", bg: "#112233", bgOpacity: 40 }] }, { ...C, bgOpacity: 100 });
    expect(html).toContain("opacity:0.4");
  });
  it("rejects a malicious pill bg (injection)", () => {
    const html = renderLabelChip({ pills: [{ text: "x", bg: `#fff" onload=alert(1)` }] }, C);
    expect(html).not.toContain("onload=alert(1)");
  });
  it("respects the bar shape", () => {
    const html = renderLabelChip({ pills: [{ text: "Bar", shape: "bar" }] }, C);
    expect(html).toContain("border-radius:8px");
  });
  it("emits nothing when no pills", () => {
    expect(renderLabelChip({ pills: [] }, C)).toBe("");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderLabelChip` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): labelChip block builder (1-N positioned pills, per-pill bg/opacity/shape)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `tweetHeader` block builder

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderTweetHeader` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderTweetHeader, type TweetHeaderBlockProps } from "../tools/card-engine";

describe("renderTweetHeader", () => {
  it("renders name + @handle + verified tick", () => {
    const html = renderTweetHeader({ displayName: "Moviefied", handle: "moviefied", verified: true, logoUrl: "https://x/av.png" }, C);
    expect(html).toContain("Moviefied");
    expect(html).toContain("@moviefied");
    expect(html).toContain("verified-tick");
    expect(html).toContain("https://x/av.png");
  });
  it("omits the tick when not verified", () => {
    const html = renderTweetHeader({ displayName: "Brand", handle: "brand" }, C);
    expect(html).not.toContain("verified-tick");
  });
  it("escapes the display name and handle", () => {
    const html = renderTweetHeader({ displayName: `<b>X</b>`, handle: `y"z` }, C);
    expect(html).toContain("&lt;b&gt;X");
    expect(html).toContain("@y&quot;z");
  });
  it("uses a sanitized verified color", () => {
    const html = renderTweetHeader({ displayName: "B", handle: "b", verified: true, verifiedColor: `#fff"onload=x` }, C);
    expect(html).not.toContain("onload=x");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderTweetHeader` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): tweetHeader block builder (name + @handle + verified tick)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `captionStack` block builder (1–N pills, per-pill overrides)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderCaptionStack` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderCaptionStack, type CaptionStackBlockProps } from "../tools/card-engine";

describe("renderCaptionStack", () => {
  it("renders a single white pill bottom-anchored", () => {
    const html = renderCaptionStack({ pills: [{ text: "Breaking news today" }] }, C);
    expect(html).toContain("Breaking news today");
    expect(html).toContain("caption-stack");
  });
  it("renders multiple pills (white + red)", () => {
    const html = renderCaptionStack({ pills: [
      { text: "First", bg: "#ffffff", textColor: "#000000" },
      { text: "Second", bg: "#e11d48", textColor: "#ffffff" },
    ] }, C);
    expect(html).toContain("#ffffff");
    expect(html).toContain("#e11d48");
  });
  it("applies the global bgOpacity to a pill (opacity slider)", () => {
    const html = renderCaptionStack({ pills: [{ text: "x" }] }, { ...C, bgOpacity: 60 });
    expect(html).toContain("opacity:0.6");
  });
  it("a per-pill bgOpacity overrides the global", () => {
    const html = renderCaptionStack({ pills: [{ text: "x", bgOpacity: 25 }] }, { ...C, bgOpacity: 100 });
    expect(html).toContain("opacity:0.25");
  });
  it("renders a whitelisted trailing emoji, drops a malicious one", () => {
    const ok = renderCaptionStack({ pills: [{ text: "Alert", emoji: "🚨" }] }, C);
    expect(ok).toContain("🚨");
    const bad = renderCaptionStack({ pills: [{ text: "x", emoji: `"><script>` }] }, C);
    expect(bad).not.toContain("<script>");
  });
  it("honors per-pill center alignment", () => {
    const html = renderCaptionStack({ pills: [{ text: "x", align: "center" }] }, C);
    expect(html).toContain("text-align:center");
  });
  it("renders multi-span highlight markup inside a pill", () => {
    const html = renderCaptionStack({ pills: [{ text: "[[A|#111]] vs [[B|#222|box]]" }] }, C);
    expect(html).toContain("color:#111");
    expect(html).toContain("background:#222");
  });
  it("rejects a malicious pill bg color", () => {
    const html = renderCaptionStack({ pills: [{ text: "x", bg: `#fff" onload=alert(1)` }] }, C);
    expect(html).not.toContain("onload=alert(1)");
  });
  it("emits nothing when no pills", () => {
    expect(renderCaptionStack({ pills: [] }, C)).toBe("");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderCaptionStack` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): captionStack block builder (1-N pills, per-pill bg/opacity/align/emoji)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: `statCards` block builder

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderStatCards` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderStatCards, type StatCardsBlockProps } from "../tools/card-engine";

describe("renderStatCards", () => {
  it("renders label + value callout boxes (SpaceX IPO)", () => {
    const html = renderStatCards({ cards: [{ label: "IPO SIZE", value: "$75 BILLION", bg: "#1d4ed8" }] }, C);
    expect(html).toContain("IPO SIZE");
    expect(html).toContain("$75 BILLION");
    expect(html).toContain("#1d4ed8");
  });
  it("renders multiple cards and escapes label/value", () => {
    const html = renderStatCards({ cards: [
      { label: "<A>", value: "1" },
      { label: "B", value: `"2"` },
    ] }, C);
    expect(html).toContain("&lt;A&gt;");
    expect(html).toContain("&quot;2&quot;");
  });
  it("rejects a malicious card bg", () => {
    const html = renderStatCards({ cards: [{ label: "x", value: "y", bg: `#fff" onload=x` }] }, C);
    expect(html).not.toContain("onload=x");
  });
  it("emits nothing with no cards", () => {
    expect(renderStatCards({ cards: [] }, C)).toBe("");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderStatCards` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): statCards block builder (1-N label/value callout boxes)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `bodyText` block builder

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderBodyText` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderBodyText, type BodyTextBlockProps } from "../tools/card-engine";

describe("renderBodyText", () => {
  it("renders title + meta rows + description", () => {
    const html = renderBodyText({
      title: "Kalki 2898",
      meta: [{ label: "Starring", value: "Prabhas" }, { label: "Genre", value: "Sci-fi" }],
      description: "A dystopian epic set in the future.",
    }, C);
    expect(html).toContain("Kalki 2898");
    expect(html).toContain("Starring");
    expect(html).toContain("Prabhas");
    expect(html).toContain("dystopian epic");
  });
  it("escapes all fields", () => {
    const html = renderBodyText({ title: "<x>", description: `"d"`, meta: [{ label: "<l>", value: "<v>" }] }, C);
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&quot;d&quot;");
    expect(html).toContain("&lt;l&gt;");
  });
  it("renders with description only (no title/meta)", () => {
    const html = renderBodyText({ description: "Just a paragraph." }, C);
    expect(html).toContain("Just a paragraph.");
  });
  it("uses a sanitized text color override", () => {
    const html = renderBodyText({ description: "x", textColor: `#fff" onload=x` }, C);
    expect(html).not.toContain("onload=x");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderBodyText` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): bodyText block builder (title + meta rows + description)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: `footer` block builder

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderFooter` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderFooter, type FooterBlockProps } from "../tools/card-engine";

describe("renderFooter", () => {
  it("renders a follow line", () => {
    const html = renderFooter({ text: "Follow @moviefied for more" }, C);
    expect(html).toContain("Follow @moviefied for more");
    expect(html).toContain("card-footer");
  });
  it("escapes the text", () => {
    const html = renderFooter({ text: `<b>X</b>` }, C);
    expect(html).toContain("&lt;b&gt;X");
  });
  it("uses a sanitized color override", () => {
    const html = renderFooter({ text: "x", textColor: `#fff" onload=x` }, C);
    expect(html).not.toContain("onload=x");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderFooter` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
// ── footer block ────────────────────────────────────────────────────────────
export function renderFooter(props: FooterBlockProps, controls: StyleControls): string {
  const tokens = themeTokens(controls);
  const color = safeColor(props.textColor ?? tokens.subTextColor);
  return `<div class="card-footer" style="position:absolute;left:56px;right:56px;bottom:44px;color:${color};font-size:24px;font-weight:600;text-align:${safeAlign(controls.textAlign)};z-index:3;">${escapeHtml(props.text)}</div>`;
}
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): footer block builder (Follow-for-more line)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: `carouselChrome` block builder

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderCarouselChrome` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderCarouselChrome, type CarouselChromeBlockProps } from "../tools/card-engine";

describe("renderCarouselChrome", () => {
  it("renders a progress bar reflecting current/total", () => {
    const html = renderCarouselChrome({ totalSlides: 5, currentSlide: 2, progressBar: { color: "#7c8cff", height: 6 } }, C);
    expect(html).toContain("#7c8cff");
    // slide 2 of 5 (0-indexed) → 60% width
    expect(html).toContain("width:60%");
  });
  it("renders page dots when requested", () => {
    const html = renderCarouselChrome({ totalSlides: 3, currentSlide: 0, pageDots: true }, C);
    expect((html.match(/page-dot/g) || []).length).toBe(3);
  });
  it("renders a nav-arrow hint when requested", () => {
    const html = renderCarouselChrome({ totalSlides: 3, currentSlide: 0, navArrowHint: true }, C);
    expect(html).toContain("nav-arrow");
  });
  it("rejects a malicious progress color", () => {
    const html = renderCarouselChrome({ totalSlides: 2, currentSlide: 0, progressBar: { color: `#fff" onload=x` } }, C);
    expect(html).not.toContain("onload=x");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderCarouselChrome` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): carouselChrome block builder (progress bar / dots / nav hint)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: `ctaCard` block builder

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-blocks.test.ts` (append `renderCtaCard` describe)

- [ ] **Step 1: Write the failing test.** Append:
```ts
import { renderCtaCard, type CtaCardBlockProps } from "../tools/card-engine";

describe("renderCtaCard", () => {
  it("renders headline + follow button on a branded bg", () => {
    const html = renderCtaCard({ headline: "Follow Us", buttonText: "Follow", bg: "#7c8cff" }, C);
    expect(html).toContain("Follow Us");
    expect(html).toContain("#7c8cff");
    expect(html).toContain(">Follow<");
  });
  it("renders an optional phone mockup image", () => {
    const html = renderCtaCard({ headline: "Follow Us", phoneAssetUrl: "https://x/phone.png" }, C);
    expect(html).toContain("https://x/phone.png");
  });
  it("escapes headline + subheading", () => {
    const html = renderCtaCard({ headline: `<b>F</b>`, subheading: `"s"` }, C);
    expect(html).toContain("&lt;b&gt;F");
    expect(html).toContain("&quot;s&quot;");
  });
  it("rejects a malicious bg and a malicious phone url", () => {
    const html = renderCtaCard({ headline: "x", bg: `#fff" onload=x`, phoneAssetUrl: `https://x/p.png");}</style>` }, C);
    expect(html).not.toContain("onload=x");
    expect(html).not.toContain(`https://x/p.png");}</style>`);
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: `renderCtaCard` not exported.
- [ ] **Step 3: Minimal implementation.** Append:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-blocks` → expected: all 11 block describes pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-blocks.test.ts
git commit -m "feat(card-engine): ctaCard block builder (end-slide follow card + phone mockup)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: `renderCard` composer

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-render.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-render.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { renderCard, CANVAS, DEFAULT_CONTROLS, type CardSpec } from "../tools/card-engine";

const spec = (blocks: CardSpec["blocks"], controls = DEFAULT_CONTROLS): CardSpec => ({
  canvas: CANVAS, blocks, controls,
});

describe("renderCard", () => {
  it("emits a full HTML doc at 1080x1350", () => {
    const html = renderCard(spec([{ kind: "footer", props: { text: "Follow @x" } }]));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("width:1080px");
    expect(html).toContain("height:1350px");
    expect(html).toContain("@import url('https://fonts.googleapis.com");
  });

  it("renders blocks in order (background before caption)", () => {
    const html = renderCard(spec([
      { kind: "background", props: { mode: "photo", imageUrl: "https://x/p.jpg" } },
      { kind: "captionStack", props: { pills: [{ text: "Hello" }] } },
    ]));
    expect(html.indexOf("https://x/p.jpg")).toBeLessThan(html.indexOf("Hello"));
  });

  it("omits a block with missing inputs (no broken slot)", () => {
    const html = renderCard(spec([
      { kind: "circularInset", props: { items: [] } },
      { kind: "footer", props: { text: "kept" } },
    ]));
    expect(html).toContain("kept");
    expect(html).not.toContain("border-radius:50%");
  });

  it("honors the dark theme (no forced white on a light bg)", () => {
    const html = renderCard(spec(
      [{ kind: "bodyText", props: { description: "x" } }],
      { ...DEFAULT_CONTROLS, theme: "light" },
    ));
    // light theme body text is dark, not white
    expect(html).toContain("#0f1419");
  });

  it("applies the chosen font stack from controls", () => {
    const html = renderCard(spec(
      [{ kind: "footer", props: { text: "x" } }],
      { ...DEFAULT_CONTROLS, fontFamily: "serif_display" },
    ));
    expect(html).toContain("Playfair Display");
  });

  it("renders a composite spec no preset uses (proves composability)", () => {
    const html = renderCard(spec([
      { kind: "background", props: { mode: "gradient" } },
      { kind: "logo", props: { logos: [{ kind: "wordmark", text: "DS", anchor: "tl", size: 8, opacity: 100 }] } },
      { kind: "tweetHeader", props: { displayName: "X", handle: "x", verified: true } },
      { kind: "statCards", props: { cards: [{ label: "L", value: "V" }] } },
      { kind: "captionStack", props: { pills: [{ text: "C" }] } },
    ]));
    expect(html).toContain("DS");
    expect(html).toContain("verified-tick");
    expect(html).toContain("L");
    expect(html).toContain("C");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-render` → expected: `renderCard` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
// ── renderCard composer ─────────────────────────────────────────────────────
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Playfair+Display:wght@700;900&family=Oswald:wght@500;700&display=swap');`;

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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-render` → expected: all 6 pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-render.test.ts
git commit -m "feat(card-engine): renderCard composer (ordered blocks, theme/font, omit empty blocks)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: 8 preset factories + composability proof

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-presets.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-presets.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { preset, renderCard, type PresetId, type StyleControls } from "../tools/card-engine";

const ALL: PresetId[] = [
  "news_caption", "news_inset", "infographic_stats", "marketing_minimal",
  "tweet_card", "photo_grid", "title_cover", "listicle_body",
];

describe("presets", () => {
  it("every preset returns a renderable CardSpec", () => {
    for (const id of ALL) {
      const spec = preset(id);
      expect(spec.canvas).toEqual({ w: 1080, h: 1350 });
      expect(Array.isArray(spec.blocks)).toBe(true);
      const html = renderCard(spec);
      expect(html).toContain("<!DOCTYPE html>");
    }
  });

  it("news_caption enables background + logo + captionStack", () => {
    const spec = preset("news_caption");
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("background");
    expect(kinds).toContain("logo");
    expect(kinds).toContain("captionStack");
  });

  it("news_inset adds a circularInset block", () => {
    expect(preset("news_inset").blocks.map((b) => b.kind)).toContain("circularInset");
  });

  it("infographic_stats adds a statCards block", () => {
    expect(preset("infographic_stats").blocks.map((b) => b.kind)).toContain("statCards");
  });

  it("tweet_card uses a tweetHeader + bodyText", () => {
    const kinds = preset("tweet_card").blocks.map((b) => b.kind);
    expect(kinds).toContain("tweetHeader");
    expect(kinds).toContain("bodyText");
  });

  it("marketing_minimal uses topTextBottomPhoto + carouselChrome", () => {
    const spec = preset("marketing_minimal");
    const bg = spec.blocks.find((b) => b.kind === "background");
    expect(bg && bg.kind === "background" && bg.props.mode).toBe("topTextBottomPhoto");
    expect(spec.blocks.map((b) => b.kind)).toContain("carouselChrome");
  });

  it("photo_grid uses a photoGrid background", () => {
    const spec = preset("photo_grid");
    const bg = spec.blocks.find((b) => b.kind === "background");
    expect(bg && bg.kind === "background" && bg.props.mode).toBe("photoGrid");
  });

  it("listicle_body uses bodyText + footer", () => {
    const kinds = preset("listicle_body").blocks.map((b) => b.kind);
    expect(kinds).toContain("bodyText");
    expect(kinds).toContain("footer");
  });

  it("applies StyleControls overrides", () => {
    const overrides: Partial<StyleControls> = { brandColor: "#abcabc", theme: "dark" };
    const spec = preset("news_caption", overrides);
    expect(spec.controls.brandColor).toBe("#abcabc");
    expect(spec.controls.theme).toBe("dark");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-presets` → expected: `preset`/`PresetId` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-presets` → expected: all 9 pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-presets.test.ts
git commit -m "feat(card-engine): 8 data-driven preset factories + composability proof

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Headline integrity — `capHeadline`, `capBody`, `dedupeHook` (Component 6)

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-headline.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-headline.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { capHeadline, capBody, jaccardSimilarity, dedupeHook } from "../tools/card-engine";

describe("capHeadline", () => {
  it("returns short headlines unchanged", () => {
    expect(capHeadline("Big news today")).toBe("Big news today");
  });
  it("never cuts mid-word; appends … when over budget", () => {
    const long = "This is an extremely long headline that runs well past the sixteen word and ninety character ceiling for sure indeed truly";
    const out = capHeadline(long);
    expect(out.length).toBeLessThanOrEqual(91);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s\S{1,2}…$/); // no dangling fragment
  });
  it("prefers a full-sentence boundary when one is in budget", () => {
    const out = capHeadline("First clause is done. Second clause keeps going way beyond what we can fit here today okay");
    expect(out.endsWith(".")).toBe(true);
    expect(out).toContain("First clause is done");
  });
  it("collapses internal whitespace", () => {
    expect(capHeadline("a   b   c")).toBe("a b c");
  });
});

describe("capBody", () => {
  it("returns short body unchanged", () => {
    expect(capBody("short body", 120)).toBe("short body");
  });
  it("cuts on a word boundary and appends …", () => {
    const out = capBody("alpha beta gamma delta epsilon", 18);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("epsilon");
    expect(out).not.toMatch(/\S…$/); // ends on a whole word
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical strings and 0 for disjoint", () => {
    expect(jaccardSimilarity("a b c", "a b c")).toBe(1);
    expect(jaccardSimilarity("a b c", "x y z")).toBe(0);
  });
  it("is case/punctuation insensitive", () => {
    expect(jaccardSimilarity("Big News!", "big news")).toBeGreaterThan(0.9);
  });
});

describe("dedupeHook", () => {
  it("drops a hook that is a near-duplicate of the headline", () => {
    expect(dedupeHook("TMC leader arrested near border", "TMC leader arrested near the border")).toBe("");
  });
  it("keeps a hook that adds a different angle", () => {
    expect(dedupeHook("How did this even happen?!", "TMC leader arrested near border")).toBe("How did this even happen?!");
  });
  it("drops an empty/whitespace hook", () => {
    expect(dedupeHook("   ", "Anything")).toBe("");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-headline` → expected: `jaccardSimilarity`/`dedupeHook` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts` (note: `capHeadline`/`capBody` are ported verbatim from `repurpose.router.ts:285-317` so the engine is self-contained; the router keeps its own copies until it migrates):
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-headline` → expected: all pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-headline.test.ts
git commit -m "feat(card-engine): headline integrity — capHeadline/capBody + Jaccard dedupeHook (no duplicate hook/headline)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 18: Backward-compat shim `legacyStyleToCardSpec`

**Files:**
- Modify: `packages/ai/src/tools/card-engine.ts`
- Test: `packages/ai/src/__tests__/card-engine-shim.test.ts`

- [ ] **Step 1: Write the failing test.** Create `packages/ai/src/__tests__/card-engine-shim.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { legacyStyleToCardSpec, renderCard, DEFAULT_CONTROLS } from "../tools/card-engine";

const ctl = { ...DEFAULT_CONTROLS, brandColor: "#e11d48" };

describe("legacyStyleToCardSpec", () => {
  it("maps premium_editorial → news_caption (single caption pill)", () => {
    const spec = legacyStyleToCardSpec(
      { style: "premium_editorial", headline: "Krrish 4 Budget Debunked", channelName: "Moviefied" },
      ctl,
    );
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("background");
    expect(kinds).toContain("captionStack");
    const html = renderCard(spec);
    expect(html).toContain("Krrish 4 Budget Debunked");
  });

  it("maps hook_bars → news_caption with TWO pills (hook + headline), deduped", () => {
    const spec = legacyStyleToCardSpec(
      { style: "hook_bars", headline: "TMC leader arrested near border", hookLine: "How did this happen?!", channelName: "NewsPage" },
      ctl,
    );
    const cap = spec.blocks.find((b) => b.kind === "captionStack");
    expect(cap && cap.kind === "captionStack" && cap.props.pills.length).toBe(2);
    const html = renderCard(spec);
    expect(html).toContain("How did this happen");
    expect(html).toContain("TMC leader arrested near border");
  });

  it("drops the hook when it duplicates the headline (single pill)", () => {
    const spec = legacyStyleToCardSpec(
      { style: "hook_bars", headline: "TMC leader arrested near border", hookLine: "TMC leader arrested near the border", channelName: "NewsPage" },
      ctl,
    );
    const cap = spec.blocks.find((b) => b.kind === "captionStack");
    expect(cap && cap.kind === "captionStack" && cap.props.pills.length).toBe(1);
  });

  it("maps tweet_card → tweet_card preset with header + body", () => {
    const spec = legacyStyleToCardSpec(
      { style: "tweet_card", headline: "Conrad Fisher back!!!", channelName: "Moviefied", handle: "@moviefied", verified: true },
      ctl,
    );
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("tweetHeader");
    const html = renderCard(spec);
    expect(html).toContain("Conrad Fisher back");
    expect(html).toContain("verified-tick");
  });

  it("maps bold_typographic → title_cover", () => {
    const spec = legacyStyleToCardSpec(
      { style: "bold_typographic", headline: "Biggest releases", channelName: "Moviefied" },
      ctl,
    );
    const html = renderCard(spec);
    expect(html).toContain("Biggest releases");
  });

  it("forwards a sanitized bgImageUrl into the background block", () => {
    const spec = legacyStyleToCardSpec(
      { style: "premium_editorial", headline: "x", channelName: "B", bgImageUrl: "https://cdn.x/p.jpg" },
      ctl,
    );
    expect(renderCard(spec)).toContain("https://cdn.x/p.jpg");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-shim` → expected: `legacyStyleToCardSpec` not exported.
- [ ] **Step 3: Minimal implementation.** Append to `packages/ai/src/tools/card-engine.ts`:
```ts
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
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-shim` → expected: all 6 pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/ai/src/tools/card-engine.ts packages/ai/src/__tests__/card-engine-shim.test.ts
git commit -m "feat(card-engine): legacyStyleToCardSpec shim (4 old styles → presets, hook deduped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 19: Export the engine surface + green-suite verification

**Files:**
- Modify: `packages/ai/src/index.ts`
- Test: full AI suite (no new test file; this task wires exports and confirms the security-regression suites stay green)

- [ ] **Step 1: Write the failing test.** Add a barrel-import assertion to the existing types test so a missing root export fails. Append to `packages/ai/src/__tests__/card-engine-types.test.ts`:
```ts
import * as aiRoot from "../index";

describe("card-engine root exports", () => {
  it("re-exports renderCard, preset, legacyStyleToCardSpec from the package root", () => {
    expect(typeof aiRoot.renderCard).toBe("function");
    expect(typeof aiRoot.preset).toBe("function");
    expect(typeof aiRoot.legacyStyleToCardSpec).toBe("function");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-types` → expected: `aiRoot.renderCard is not a function` (not yet exported from index).
- [ ] **Step 3: Minimal implementation.** Add to `packages/ai/src/index.ts` after the existing `buildStaticCreative` export line:
```ts
export {
  renderCard,
  preset,
  legacyStyleToCardSpec,
  renderHighlightMarkup as renderCardHighlightMarkup,
  capHeadline as capCardHeadline,
  capBody as capCardBody,
  dedupeHook,
  jaccardSimilarity,
  CANVAS as CARD_CANVAS,
  DEFAULT_CONTROLS as CARD_DEFAULT_CONTROLS,
} from "./tools/card-engine";
export type {
  CardSpec,
  Block,
  BlockKind,
  StyleControls,
  CaptionPill,
  LogoBlock,
  ImageSlot,
  PresetId,
  FontFamily,
  HighlightMode,
  LegacyStyleInput,
} from "./tools/card-engine";
```
> Note: `renderHighlightMarkup`/`capHeadline`/`capBody` are aliased at the root (`renderCardHighlightMarkup`/`capCardHeadline`/`capCardBody`) because `buildStaticCreative`'s module and `repurpose.router.ts` already export same-named symbols; aliasing avoids a barrel name collision while the migration is in flight.
- [ ] **Step 4: Run the FULL AI suite (expect PASS).** `pnpm -F @postautomation/ai test` → expected: all suites pass, including the untouched security-regression suites (`creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, `creative-theme.test.ts`, `decode-entities.test.ts`) and the 8 new `card-engine-*` suites. Confirm no existing test changed behavior.
- [ ] **Step 5: Type-check the package (expect clean).** `pnpm -F @postautomation/ai exec tsc --noEmit` → expected: no errors.
- [ ] **Step 6: Commit.**
```bash
git add packages/ai/src/index.ts packages/ai/src/__tests__/card-engine-types.test.ts
git commit -m "feat(card-engine): export engine surface from @postautomation/ai root (aliased to avoid collisions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 20: Wire `news-image-generator` to render a CardSpec (additive, opt-in)

**Files:**
- Modify: `packages/ai/src/tools/news-image-generator.ts` (after line 159 — add a new exported function alongside `generateStyledCreativeImage`, leaving it untouched)
- Test: `packages/ai/src/__tests__/card-engine-render.test.ts` (append a render-HTML-shape assertion; no Puppeteer in unit tests)

- [ ] **Step 1: Write the failing test.** Append to `packages/ai/src/__tests__/card-engine-render.test.ts`:
```ts
import { buildCardHtmlForPuppeteer } from "../tools/news-image-generator";

describe("buildCardHtmlForPuppeteer", () => {
  it("returns a renderCard HTML doc for a CardSpec (pure, no browser)", () => {
    const html = buildCardHtmlForPuppeteer(spec([{ kind: "footer", props: { text: "Follow @x" } }]));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Follow @x");
    expect(html).toContain("width:1080px");
  });
});
```
- [ ] **Step 2: Run it (expect FAIL).** `pnpm -F @postautomation/ai test card-engine-render` → expected: `buildCardHtmlForPuppeteer` not exported.
- [ ] **Step 3: Minimal implementation.** In `packages/ai/src/tools/news-image-generator.ts`, add the import at the top (alongside the existing `buildStaticCreative` import on line 4) and a thin pure builder + render entry. Edit line 4:
```ts
import { buildStaticCreative, type StaticCreativeOptions, safeColor } from "./creative-templates";
import { renderCard, type CardSpec } from "./card-engine";
```
Then insert directly after `generateStyledCreativeImage` (after its closing brace, ~line 194):
```ts
/**
 * Pure: render a CardSpec to the same HTML doc renderCard produces. Exported so
 * unit tests can assert the HTML without launching Chrome. Kept separate from the
 * Puppeteer path so the rasterizer and the renderer test in isolation.
 */
export function buildCardHtmlForPuppeteer(spec: CardSpec): string {
  return renderCard(spec);
}

/**
 * Rasterize a CardSpec to PNG via Puppeteer. Mirrors generateStyledCreativeImage's
 * Puppeteer config exactly (waitUntil "load", screenshot-on-timeout, 400ms paint
 * delay, shared-browser option) — only the HTML source differs (renderCard vs
 * buildStaticCreative). Additive: existing callers of generateStyledCreativeImage
 * are unaffected.
 */
export async function generateCardImage(
  spec: CardSpec,
  opts?: { browser?: import("puppeteer").Browser },
): Promise<NewsImageResult> {
  const html = buildCardHtmlForPuppeteer(spec);
  const sharedBrowser = opts?.browser;
  const browser = sharedBrowser ?? (await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  }));
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1080, height: 1350 });
    try {
      await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      console.warn(`[card-engine] setContent wait timed out, screenshotting anyway:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 400));
    const screenshotBuffer = await page.screenshot({ type: "png", encoding: "base64" });
    return { imageBase64: screenshotBuffer as string, mimeType: "image/png", width: 1080, height: 1350, style: "news_card" };
  } finally {
    await page.close().catch(() => {});
    if (!sharedBrowser) await browser.close();
  }
}
```
- [ ] **Step 4: Run it (expect PASS).** `pnpm -F @postautomation/ai test card-engine-render` → expected: the new `buildCardHtmlForPuppeteer` describe passes; whole file still green.
- [ ] **Step 5: Export the new entry points.** Add to the existing `news-image-generator` re-export line in `packages/ai/src/index.ts`:
```ts
export { buildCardHtmlForPuppeteer, generateCardImage } from "./tools/news-image-generator";
```
- [ ] **Step 6: Type-check + full suite (expect clean).** `pnpm -F @postautomation/ai exec tsc --noEmit && pnpm -F @postautomation/ai test` → expected: no type errors, all suites pass.
- [ ] **Step 7: Commit.**
```bash
git add packages/ai/src/tools/news-image-generator.ts packages/ai/src/index.ts packages/ai/src/__tests__/card-engine-render.test.ts
git commit -m "feat(card-engine): generateCardImage Puppeteer entry + pure buildCardHtmlForPuppeteer (additive)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 21: Final library verification + security-regression sweep

**Files:**
- Test: full `@postautomation/ai` suite (no code changes; verification gate per §4 / §5)

- [ ] **Step 1: Run the whole AI test suite.** `pnpm -F @postautomation/ai test` → expected: every suite passes, including all 8 `card-engine-*` suites and the untouched security suites (`creative-templates.test.ts`, `image-fetch-ssrf.test.ts`, `creative-theme.test.ts`, `decode-entities.test.ts`, `overlay-logo-escaping.test.ts`, `overlay-logo-ssrf.test.ts`).
- [ ] **Step 2: Confirm the §4 security checklist by grepping the new module.** `grep -nE "safeColor|safeImageUrl|escapeHtml|renderHighlightMarkup|clampOpacity|safeFontFamily|safeAlign|safeShape|safeEmoji" packages/ai/src/tools/card-engine.ts` → expected: every color/url/text/opacity/enum interpolation is gated (visually verify no raw `${props.bg}`/`${url}`/`${text}` interpolation exists without a `safe*`/`escapeHtml` wrapper).
- [ ] **Step 3: Confirm no shell-exec was introduced.** `grep -nE "execSync|execFileSync|spawn|child_process" packages/ai/src/tools/card-engine.ts` → expected: no matches (the engine is pure HTML-string generation).
- [ ] **Step 4: Type-check the whole package.** `pnpm -F @postautomation/ai exec tsc --noEmit` → expected: clean.
- [ ] **Step 5: Commit (verification gate — no-op if nothing changed; otherwise any cleanup).**
```bash
git commit --allow-empty -m "test(card-engine): full suite green + security-regression sweep (sanitizers/no-exec verified)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for downstream plans (coordination)

- **Plan 1 (image resolution / detection) owns `resolveImageSlot` and `classifyCard`** (A.15, A.18). This plan defines the `ImageSlot` type and `CardHint`-shaped `PresetId` enum so plan 1's resolver can fill `BackgroundBlockProps.imageUrl`/`circularInset.items[].imageUrl` with resolved URLs before calling `renderCard`. This plan does NOT implement the resolver or the vision call.
- **Plan 3 (router/UI/scheduler) owns** the `CreativeTemplate` model extension (A.20), the `creativeTemplate` router methods, `RepurposeTab.tsx`, and Component 7 (worker). It consumes this plan's `renderCard`/`preset`/`legacyStyleToCardSpec` + types. The router keeps its own `capHeadline`/`capBody` until it migrates to the engine's exported versions (aliased at the root to avoid collision).
- **Migration path:** once plan 3 routes repurpose through `generateCardImage(spec)`, the legacy `buildStaticCreative` + the 4 fixed builders in `creative-templates.ts` can be deleted in a follow-up; until then both coexist and NewsGrid/Autopilot are untouched.