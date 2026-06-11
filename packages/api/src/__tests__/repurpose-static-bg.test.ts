import { describe, it, expect } from "vitest";
import { pickArticleBgImage } from "../routers/repurpose.router";

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
});
