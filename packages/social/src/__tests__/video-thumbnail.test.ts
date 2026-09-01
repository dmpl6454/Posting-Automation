import { describe, it, expect } from "vitest";
import { resolveVideoThumbnailUrl, supportsInstagramCover } from "../utils/video-thumbnail";

/**
 * Custom video covers. The failure that makes this worth strict validation: Meta
 * cURLs `cover_url` server-side, so a malformed one does not degrade the cover —
 * it puts the media container into ERROR and fails the ENTIRE reel publish.
 */
describe("resolveVideoThumbnailUrl", () => {
  it("returns null when no thumbnail was chosen — the byte-identical path", () => {
    // Every provider gates on this, so null must mean "behave exactly as before".
    expect(resolveVideoThumbnailUrl(undefined)).toBeNull();
    expect(resolveVideoThumbnailUrl(null)).toBeNull();
    expect(resolveVideoThumbnailUrl({})).toBeNull();
    expect(resolveVideoThumbnailUrl({ videoThumbnail: null })).toBeNull();
  });

  it("returns the URL for a well-formed reference", () => {
    expect(
      resolveVideoThumbnailUrl({
        videoThumbnail: { mediaId: "m1", url: "https://cdn.example.com/a/cover.jpg" },
      })
    ).toBe("https://cdn.example.com/a/cover.jpg");
  });

  it("trims incidental whitespace around an otherwise valid URL", () => {
    expect(
      resolveVideoThumbnailUrl({ videoThumbnail: { mediaId: "m1", url: "  https://x.io/c.jpg  " } })
    ).toBe("https://x.io/c.jpg");
  });

  it("rejects anything that is not an http(s) URL", () => {
    // A data: or file: URL is meaningless to a platform that fetches it, and
    // javascript: has no business reaching a request body.
    for (const url of [
      "data:image/jpeg;base64,AAAA",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "//cdn.example.com/c.jpg",
      "cdn.example.com/c.jpg",
      "",
      "   ",
    ]) {
      expect(
        resolveVideoThumbnailUrl({ videoThumbnail: { mediaId: "m", url } }),
        `url=${JSON.stringify(url)}`
      ).toBeNull();
    }
  });

  it("rejects URLs carrying quotes, angle brackets or embedded whitespace", () => {
    // Allowlist, not denylist — the value is interpolated into request bodies.
    for (const url of [
      'https://x.io/c.jpg"&access_token=stolen',
      "https://x.io/c.jpg'",
      "https://x.io/<script>.jpg",
      "https://x.io/two words.jpg",
      "https://x.io/c.jpg\nHost: evil",
    ]) {
      expect(resolveVideoThumbnailUrl({ videoThumbnail: { mediaId: "m", url } }), url).toBeNull();
    }
  });

  it("rejects a malformed reference rather than throwing", () => {
    for (const bad of [{ url: 123 }, { mediaId: "m" }, "https://x.io/c.jpg", ["https://x.io/c.jpg"]]) {
      expect(resolveVideoThumbnailUrl({ videoThumbnail: bad as any })).toBeNull();
    }
  });
});

describe("supportsInstagramCover", () => {
  it("allows a cover only on REELS", () => {
    expect(supportsInstagramCover("REELS")).toBe(true);
  });

  it("refuses STORIES and every other container type", () => {
    // ⚠️ cover_url on a STORIES container 400s container creation and fails the
    // whole publish — Meta documents it as reels-only.
    for (const t of ["STORIES", "VIDEO", "IMAGE", "CAROUSEL", "", "reels"]) {
      expect(supportsInstagramCover(t), t).toBe(false);
    }
  });
});
