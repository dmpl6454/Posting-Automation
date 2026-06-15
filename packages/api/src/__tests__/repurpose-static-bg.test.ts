import { describe, it, expect } from "vitest";
import { pickArticleBgImage, isRasterPhotoUrl } from "../routers/repurpose.router";

describe("pickArticleBgImage", () => {
  it("returns the first https image when all are allowed", () => {
    expect(
      pickArticleBgImage(["https://cdn/x.jpg", "https://cdn/y.jpg"], () => true),
    ).toBe("https://cdn/x.jpg");
  });

  it("skips http:// images (downstream safeImageUrl rejects them) and picks the first https one", () => {
    expect(
      pickArticleBgImage(["http://cdn/x.jpg", "https://cdn/y.jpg"], () => true),
    ).toBe("https://cdn/y.jpg");
  });

  it("returns undefined when the only image is disallowed by the guard", () => {
    expect(pickArticleBgImage(["https://cdn/x.jpg"], () => false)).toBeUndefined();
  });

  it("returns undefined for an empty array", () => {
    expect(pickArticleBgImage([], () => true)).toBeUndefined();
  });

  it("returns undefined when images is undefined", () => {
    expect(pickArticleBgImage(undefined, () => true)).toBeUndefined();
  });

  it("skips a tracking pixel + logo SVG and picks the real raster hero (B5)", () => {
    expect(
      pickArticleBgImage(
        [
          "https://sb.scorecardresearch.com/p",
          "https://drop.ndtv.com/a/ndtv-profit.svg",
          "https://c.ndtvimg.com/real.jpg",
        ],
        () => true,
      ),
    ).toBe("https://c.ndtvimg.com/real.jpg");
  });

  it("returns undefined when the only image is a logo SVG", () => {
    expect(pickArticleBgImage(["https://cdn/logo.svg"], () => true)).toBeUndefined();
  });

  it("returns undefined for an insecure http:// photo (https-only kept)", () => {
    expect(pickArticleBgImage(["http://insecure/photo.jpg"], () => true)).toBeUndefined();
    expect(pickArticleBgImage(["http://insecure/p.jpg"], () => true)).toBeUndefined();
  });

  // ── T5 follow-up: the key regression — token/host-label matching ────
  it("returns a 'silicon' hero (was dropped by the icon substring)", () => {
    expect(
      pickArticleBgImage(["https://static.toiimg.com/silicon-valley.jpg"], () => true),
    ).toBe("https://static.toiimg.com/silicon-valley.jpg");
  });

  it("returns the real publisher analyticsindiamag.com hero (was dropped by analytics substring)", () => {
    expect(
      pickArticleBgImage(["https://img.analyticsindiamag.com/hero.jpg"], () => true),
    ).toBe("https://img.analyticsindiamag.com/hero.jpg");
  });
});

describe("isRasterPhotoUrl", () => {
  // ── ACCEPT — must NOT be dropped (T5 regression) ────────────────────
  it("accepts a 'silicon' hero (icon substring false-positive)", () => {
    expect(isRasterPhotoUrl("https://static.toiimg.com/silicon-valley.jpg")).toBe(true);
  });

  it("accepts the real publisher analyticsindiamag.com (analytics substring false-positive)", () => {
    expect(isRasterPhotoUrl("https://img.analyticsindiamag.com/hero.jpg")).toBe(true);
  });

  it("accepts a 'Pixel 7' / 'Avatar 2' / 'Beacon Hill' story photo (hero keeps chrome words)", () => {
    expect(isRasterPhotoUrl("https://cdn.site.com/pixel-7-review.jpg")).toBe(true);
    expect(isRasterPhotoUrl("https://cdn.site.com/avatar-2-box-office.jpg")).toBe(true);
    expect(isRasterPhotoUrl("https://cdn.site.com/beacon-hill-fire.jpg")).toBe(true);
  });

  // The hero path does NOT apply chrome keywords (mirror of isLikelyOgPhoto).
  it("accepts a logo.png hero (chrome keywords NOT applied to the hero)", () => {
    expect(isRasterPhotoUrl("https://x.com/logo.png")).toBe(true);
    expect(isRasterPhotoUrl("https://x.com/icon.png")).toBe(true);
  });

  it("accepts a real raster hero with a query string", () => {
    expect(
      isRasterPhotoUrl("https://c.ndtvimg.com/2026-06/abc_625x300.jpg?im=FitAndFill"),
    ).toBe(true);
  });

  it("accepts a plain .png", () => {
    expect(isRasterPhotoUrl("https://c.ndtvimg.com/x.png")).toBe(true);
  });

  it("accepts an extensionless CDN image url", () => {
    expect(isRasterPhotoUrl("https://images.cdn.com/photo?w=800")).toBe(true);
  });

  // ── REJECT — still junk ─────────────────────────────────────────────
  it("rejects a scorecardresearch tracking pixel", () => {
    expect(isRasterPhotoUrl("https://sb.scorecardresearch.com/p?c1=2&c2=9548033")).toBe(false);
  });

  it("rejects a logo .svg", () => {
    expect(
      isRasterPhotoUrl("https://drop.ndtv.com/test//hk-ndtv/images/ndtv-profit.svg"),
    ).toBe(false);
    expect(isRasterPhotoUrl("https://cdn/logo.svg")).toBe(false);
  });

  it("rejects 'analytics' as a full host LABEL", () => {
    expect(isRasterPhotoUrl("https://analytics.tracker.com/p.jpg")).toBe(false);
  });

  it("rejects a malformed url", () => {
    expect(isRasterPhotoUrl("not a url")).toBe(false);
  });
});
