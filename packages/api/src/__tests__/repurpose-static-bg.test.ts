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
          "https://sb.scorecardresearch.com/p?x",
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
  });
});

describe("isRasterPhotoUrl", () => {
  it("rejects a scorecardresearch tracking pixel", () => {
    expect(isRasterPhotoUrl("https://sb.scorecardresearch.com/p?c1=2&c2=9548033")).toBe(false);
  });

  it("rejects a logo .svg", () => {
    expect(
      isRasterPhotoUrl("https://drop.ndtv.com/test//hk-ndtv/images/ndtv-profit.svg"),
    ).toBe(false);
  });

  it("rejects an icon/logo keyword url", () => {
    expect(isRasterPhotoUrl("https://x.com/icon.png")).toBe(false);
    expect(isRasterPhotoUrl("https://x.com/logo.png")).toBe(false);
  });

  it("rejects a malformed url", () => {
    expect(isRasterPhotoUrl("not a url")).toBe(false);
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
});
