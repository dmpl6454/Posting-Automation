import { describe, it, expect } from "vitest";
import { __test__ } from "../utils/url-extractor";

// __test__ exposes isLikelyContentPhoto for unit testing (B5 — drop tracking
// pixels / SVG logos from extracted article images so a real raster hero is
// picked as the static-creative background).
describe("isLikelyContentPhoto", () => {
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

  it("rejects icon/logo keyword urls", () => {
    expect(__test__.isLikelyContentPhoto("https://x.com/icon.png")).toBe(false);
    expect(__test__.isLikelyContentPhoto("https://x.com/logo.png")).toBe(false);
  });

  it("rejects a malformed url", () => {
    expect(__test__.isLikelyContentPhoto("not a url")).toBe(false);
  });

  it("accepts a real raster hero with a query string", () => {
    expect(
      __test__.isLikelyContentPhoto("https://c.ndtvimg.com/2026-06/abc_625x300.jpg?im=FitAndFill"),
    ).toBe(true);
  });

  it("accepts a plain .png", () => {
    expect(__test__.isLikelyContentPhoto("https://c.ndtvimg.com/x.png")).toBe(true);
  });

  it("accepts an extensionless CDN image url", () => {
    expect(__test__.isLikelyContentPhoto("https://images.cdn.com/photo?w=800")).toBe(true);
  });
});
