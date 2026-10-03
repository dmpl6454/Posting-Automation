import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level contract for the sidebar REEL preview (2026-10-03). Owner ask:
 * "in preview show reel safe area and show super text in sidebar preview".
 *
 * The rules locked here are the ones a refactor would most plausibly undo:
 * the switcher's explicit prop rebuild, ONE strip renderer, no bare <img>,
 * and Compose handing the preview the strip of the FIRST VIDEO tile.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const compose = read("apps/web/components/content-agent/ComposeTab.tsx");
const switcher = read("apps/web/components/previews/post-preview-switcher.tsx");
const instagram = read("apps/web/components/previews/instagram-preview.tsx");
const facebook = read("apps/web/components/previews/facebook-preview.tsx");
const reelFrame = read("apps/web/components/previews/reel-frame.tsx");
const youtube = read("apps/web/components/previews/youtube-preview.tsx");
const overlay = read("apps/web/components/previews/super-text-overlay.tsx");
const safeZone = read("apps/web/components/previews/reel-safe-zone.tsx");

describe("the switcher threads the new fields through its explicit rebuild", () => {
  it("destructures AND rebuilds superText + videoAspect", () => {
    const rebuild = switcher.slice(switcher.indexOf("const previewProps: PostPreviewProps = {"));
    for (const key of ["superText", "videoAspect"]) {
      expect(switcher).toMatch(new RegExp(`\\n  ${key},\\n`)); // destructure
      expect(rebuild.slice(0, rebuild.indexOf("};"))).toContain(`\n    ${key},\n`); // rebuild
    }
  });

  it("every PostPreviewProps copy declares both fields", () => {
    for (const f of ["twitter", "instagram", "facebook", "linkedin", "generic"]) {
      const src = read(`apps/web/components/previews/${f}-preview.tsx`);
      expect(src).toMatch(/superText\?: SuperTextConfig \| null;/);
      expect(src).toMatch(/videoAspect\?: number \| null;/);
    }
  });
});

describe("Compose hands the preview the FIRST VIDEO tile's strip and the probed aspect", () => {
  it("passes superText from the first video item and videoAspect from the probe", () => {
    expect(compose).toMatch(/superText=\{postMedia\.find\(\(m\) => isVideoMediaItem\(m\)\)\?\.superText \?\? null\}/);
    expect(compose).toMatch(/videoAspect=\{videoAspect\}/);
  });
});

describe("Instagram AND Facebook: one video is a 9:16 reel, through the ONE shared ReelFrame", () => {
  it("both cards decide reel-ness with isSingleReel over the classified first kind", () => {
    for (const src of [instagram, facebook]) {
      expect(src).toMatch(/const isReel = isSingleReel\(mediaUrls, firstKind\)/);
      expect(src).toMatch(/classifyMediaUrl\(mediaUrls\[0\], mediaKinds\?\.\[0\]\)/);
    }
  });

  it("both cards render <ReelFrame> for a reel, naming their platform, and never a private copy of the frame", () => {
    // The Facebook card kept its 16:9 feed box for an hour after the Instagram
    // frame shipped — a per-card copy is exactly what lets the two drift.
    expect(instagram).toMatch(/\{isReel && mediaUrls\?\.\[0\] \? \(\s*<ReelFrame[\s\S]*?platformName="Instagram"/);
    expect(facebook).toMatch(/\{isReel && mediaUrls\[0\] \? \(\s*<ReelFrame[\s\S]*?platformName="Facebook"/);
    for (const src of [instagram, facebook]) {
      expect(src).not.toContain('data-testid="reel-frame"');
      expect(src).not.toContain("<ReelSafeZone");
      expect(src).not.toContain("<SuperTextOverlay");
    }
    // Facebook's reel branch is tested BEFORE the single-media 16:9 box.
    expect(facebook.indexOf("{isReel && mediaUrls[0] ? (")).toBeLessThan(facebook.indexOf("mediaUrls.length === 1 ? ("));
  });

  it("ReelFrame renders at the reel aspect with CONTAINED media, the safe zone, and the overlay", () => {
    const frame = reelFrame.slice(reelFrame.indexOf('data-testid="reel-frame"'));
    const block = frame.slice(0, frame.indexOf("</div>\n      <p"));
    expect(reelFrame).toMatch(/style=\{\{ aspectRatio: `\$\{REEL_FRAME_ASPECT\}` \}\}/);
    expect(block).toMatch(/className="h-full w-full object-contain"/);
    expect(block).toContain("<ReelSafeZone />");
    expect(block).toMatch(/<SuperTextOverlay config=\{superText\} containerAspect=\{REEL_FRAME_ASPECT\} videoAspect=\{videoAspect\} \/>/);
    expect(block).toContain("superTextScopeLabel(superText)");
  });

  it("the legend quotes the constants and the platform prop, never hand-typed values", () => {
    expect(reelFrame).toContain("REEL_SAFE_ZONE.topPct");
    expect(reelFrame).toContain("REEL_SAFE_ZONE.bottomPct");
    expect(reelFrame).toContain("REEL_SAFE_ZONE.sidePct");
    expect(reelFrame).toMatch(/Shaded = where \{platformName\}/);
  });

  it("ReelFrame renders media only through PreviewMedia (no bare <img>, no bare <video>)", () => {
    const frame = reelFrame.slice(reelFrame.indexOf('data-testid="reel-frame"'));
    const block = frame.slice(0, frame.indexOf("</div>\n      <p"));
    expect(block).toContain("<PreviewMedia");
    expect(block).not.toMatch(/<img\b/);
    expect(block).not.toMatch(/<video\b/);
  });
});

describe("YouTube draws the same strip inside its 16:9 player", () => {
  it("overlays only for a video with a strip, at the player's aspect", () => {
    expect(youtube).toMatch(/\{firstMedia && isVideo && superText \? \(\s*<SuperTextOverlay config=\{superText\} containerAspect=\{16 \/ 9\} videoAspect=\{videoAspect\} \/>/);
  });
});

describe("ONE strip renderer, decorative overlays", () => {
  it("the overlay reuses SuperTextStrip and sizes the font from the VIDEO rect's measured width", () => {
    expect(overlay).toMatch(/import \{ SuperTextStrip \} from "\.\.\/content-agent\/super-text-strip"/);
    expect(overlay).toMatch(/containedRect\(containerAspect, videoAspect\)/);
    expect(overlay).toMatch(/new ResizeObserver/);
    expect(overlay).toMatch(/<SuperTextStrip config=\{config\} stageWidth=\{frameWidth\} \/>/);
    // Never a second markup path for the strip.
    expect(overlay).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it("both overlays are pointer-events: none and aria-hidden", () => {
    for (const src of [overlay, safeZone]) {
      expect(src).toMatch(/pointer-events-none absolute inset-0/);
      expect(src).toMatch(/aria-hidden="true"/);
    }
  });

  it("the safe zone draws from REEL_SAFE_ZONE, not literals", () => {
    expect(safeZone).toMatch(/const \{ topPct, bottomPct, sidePct \} = REEL_SAFE_ZONE/);
    // Comments stripped: the docblock quotes Meta's figures on purpose.
    const code = safeZone.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(14|35|6)%/);
  });
});
