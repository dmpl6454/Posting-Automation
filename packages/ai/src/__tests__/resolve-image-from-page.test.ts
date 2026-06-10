import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveImageFromPageUrl } from "../utils/url-extractor";

/**
 * `resolveImageFromPageUrl` turns an HTML POST PAGE URL (Instagram / Facebook
 * /post pages are `text/html`, not image files) into its `og:image` /
 * `twitter:image` so users can paste a post URL as a style reference.
 *
 * We mock `global.fetch` with a Response-like object exposing `.ok`,
 * `.headers.get("content-type")`, and `.arrayBuffer()` (the implementation
 * reads arrayBuffer to enforce the ~2MB body cap).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockHtmlResponse(html: string, contentType = "text/html; charset=utf-8") {
  const buf = new TextEncoder().encode(html).buffer;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
      arrayBuffer: async () => buf,
    }))
  );
}

describe("resolveImageFromPageUrl", () => {
  it("returns the og:image when present", async () => {
    mockHtmlResponse(
      `<html><head><meta property="og:image" content="https://cdn.example.com/p.jpg"></head></html>`
    );
    const result = await resolveImageFromPageUrl("https://www.instagram.com/p/abc123/");
    expect(result).toBe("https://cdn.example.com/p.jpg");
  });

  it("falls back to twitter:image when there is no og:image", async () => {
    mockHtmlResponse(
      `<html><head><meta property="twitter:image" content="https://cdn.example.com/t.jpg"></head></html>`
    );
    const result = await resolveImageFromPageUrl("https://www.facebook.com/some/post/");
    expect(result).toBe("https://cdn.example.com/t.jpg");
  });

  it("returns null when neither og:image nor twitter:image is present", async () => {
    mockHtmlResponse(`<html><head><title>No image here</title></head></html>`);
    const result = await resolveImageFromPageUrl("https://example.com/article");
    expect(result).toBeNull();
  });

  it("returns null and does not parse when the content-type is not text/html", async () => {
    // og:image-looking bytes, but content-type is image/png → must NOT parse.
    mockHtmlResponse(
      `<meta property="og:image" content="https://cdn.example.com/should-not-parse.jpg">`,
      "image/png"
    );
    const result = await resolveImageFromPageUrl("https://cdn.example.com/raw.png");
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const result = await resolveImageFromPageUrl("https://example.com/boom");
    expect(result).toBeNull();
  });

  it("returns null on a non-ok response (e.g. 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        headers: { get: () => "text/html" },
        arrayBuffer: async () => new ArrayBuffer(0),
      }))
    );
    const result = await resolveImageFromPageUrl("https://example.com/missing");
    expect(result).toBeNull();
  });
});
