import { describe, it, expect } from "vitest";
import { __test__ } from "../utils/url-extractor";

// __test__ exposes isLikelyContentPhoto (inline <img> list) + isLikelyOgPhoto
// (og:image/twitter:image hero). T5 follow-up: the original filters matched
// keyword/host SUBSTRINGS, which wrongly dropped legit news photos
// (`silicon`, the real publisher `analyticsindiamag.com`, "Pixel 7",
// "Avatar 2", "Beacon Hill"). Matching is now token/host-label based; chrome
// keywords only apply to the inline list, never the hero.
describe("isLikelyContentPhoto (inline <img> filter)", () => {
  // ── ACCEPT — must NOT be dropped (the T5 regression) ────────────────
  it("accepts a 'silicon' photo (icon substring false-positive)", () => {
    expect(
      __test__.isLikelyContentPhoto("https://static.toiimg.com/photo/silicon-valley-summit.jpg"),
    ).toBe(true);
  });

  it("accepts an 'iconic' host photo (icon substring false-positive)", () => {
    expect(
      __test__.isLikelyContentPhoto("https://images.iconic-news.com/2026/story.jpg"),
    ).toBe(true);
  });

  it("accepts the real publisher analyticsindiamag.com (analytics substring false-positive)", () => {
    expect(
      __test__.isLikelyContentPhoto("https://img.analyticsindiamag.com/hero.jpg"),
    ).toBe(true);
  });

  it("accepts an 'Avatar 2' story photo (avatar substring false-positive)", () => {
    expect(
      __test__.isLikelyContentPhoto("https://cdn.site.com/avatar-2-box-office.jpg"),
    ).toBe(true);
  });

  it("accepts a 'Pixel 7' review photo (pixel substring false-positive)", () => {
    expect(
      __test__.isLikelyContentPhoto("https://cdn.site.com/pixel-7-review.jpg"),
    ).toBe(true);
  });

  it("accepts a 'Beacon Hill' story photo (beacon substring false-positive)", () => {
    expect(
      __test__.isLikelyContentPhoto("https://cdn.site.com/beacon-hill-fire.jpg"),
    ).toBe(true);
  });

  it("accepts a real raster hero with a query string", () => {
    expect(
      __test__.isLikelyContentPhoto("https://c.ndtvimg.com/x_625x300.jpg?im=FitAndFill"),
    ).toBe(true);
  });

  it("accepts an extensionless CDN image url", () => {
    expect(__test__.isLikelyContentPhoto("https://images.cdn.com/photo?w=800")).toBe(true);
  });

  it("accepts a plain .png", () => {
    expect(__test__.isLikelyContentPhoto("https://c.ndtvimg.com/x.png")).toBe(true);
  });

  // ── REJECT — still junk ─────────────────────────────────────────────
  it("rejects a scorecardresearch tracking pixel", () => {
    expect(
      __test__.isLikelyContentPhoto("https://sb.scorecardresearch.com/p?c1=2&c2=9548033"),
    ).toBe(false);
  });

  it("rejects a logo .svg", () => {
    expect(
      __test__.isLikelyContentPhoto(
        "https://drop.ndtv.com/test//hk-ndtv/NDTV-world/new-pages/images/ndtv-profit.svg",
      ),
    ).toBe(false);
  });

  it("rejects a nav-icon chrome filename (inline path)", () => {
    expect(__test__.isLikelyContentPhoto("https://cdn/nav-icon.png")).toBe(false);
  });

  it("rejects a site-logo chrome filename", () => {
    expect(__test__.isLikelyContentPhoto("https://cdn/site-logo.png")).toBe(false);
  });

  it("rejects a 1x1 tracking gif filename", () => {
    expect(__test__.isLikelyContentPhoto("https://cdn/1x1.gif")).toBe(false);
  });

  it("rejects 'analytics' as a full host LABEL", () => {
    expect(__test__.isLikelyContentPhoto("https://analytics.tracker.com/p.jpg")).toBe(false);
  });

  it("rejects a malformed url", () => {
    expect(__test__.isLikelyContentPhoto("not a url")).toBe(false);
  });
});

describe("isLikelyOgPhoto (hero — no chrome-keyword filter)", () => {
  // ── ACCEPT — same false-positive heroes survive ─────────────────────
  it("accepts a 'silicon' hero", () => {
    expect(
      __test__.isLikelyOgPhoto("https://static.toiimg.com/photo/silicon-valley-summit.jpg"),
    ).toBe(true);
  });

  it("accepts the real publisher analyticsindiamag.com hero", () => {
    expect(__test__.isLikelyOgPhoto("https://img.analyticsindiamag.com/hero.jpg")).toBe(true);
  });

  it("accepts a 'Pixel 7' hero", () => {
    expect(__test__.isLikelyOgPhoto("https://cdn.site.com/pixel-7-review.jpg")).toBe(true);
  });

  // The hero path does NOT apply chrome keywords — a 'site-logo' og:image is
  // the publisher's chosen hero and is kept (the og-vs-inline distinction).
  it("ACCEPTS a site-logo.png hero (chrome keywords NOT applied to og)", () => {
    expect(__test__.isLikelyOgPhoto("https://cdn/site-logo.png")).toBe(true);
  });

  // ── REJECT — only unambiguous junk ──────────────────────────────────
  it("rejects a scorecardresearch tracking pixel hero", () => {
    expect(__test__.isLikelyOgPhoto("https://sb.scorecardresearch.com/p?c1=2")).toBe(false);
  });

  it("rejects an .svg hero", () => {
    expect(__test__.isLikelyOgPhoto("https://drop.ndtv.com/a/ndtv-profit.svg")).toBe(false);
  });

  it("rejects 'analytics' as a full host LABEL", () => {
    expect(__test__.isLikelyOgPhoto("https://analytics.tracker.com/p.jpg")).toBe(false);
  });

  it("rejects a malformed url", () => {
    expect(__test__.isLikelyOgPhoto("not a url")).toBe(false);
  });
});
