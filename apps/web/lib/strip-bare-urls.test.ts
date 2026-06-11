import { describe, expect, it } from "vitest";
import { stripBareUrls } from "./strip-bare-urls";

describe("stripBareUrls", () => {
  it("removes a single bare http(s) URL", () => {
    expect(stripBareUrls("neon and moody https://example.com/x.jpg")).toBe("neon and moody");
  });

  it("removes multiple URLs and collapses whitespace", () => {
    expect(
      stripBareUrls("warm tones https://a.com/1.png cinematic https://b.com/2 grain"),
    ).toBe("warm tones cinematic grain");
  });

  it("leaves plain text untouched", () => {
    expect(stripBareUrls("35mm film grain, warm tones")).toBe("35mm film grain, warm tones");
  });

  it("trims surrounding whitespace", () => {
    expect(stripBareUrls("  https://x.com  ")).toBe("");
  });

  it("returns empty string for a URL-only value", () => {
    expect(stripBareUrls("https://instagram.com/p/abc123")).toBe("");
  });

  it("does not touch text that merely contains 'http' as a word", () => {
    expect(stripBareUrls("the http protocol")).toBe("the http protocol");
  });
});
