import { describe, it, expect } from "vitest";
import { sniffImageMime, assertSafeStoredContentType } from "../lib/media-content-type";

/**
 * Stored content types come from the FILE, never from the client (security
 * audit 2026-09-28).
 *
 * image.saveGenerated wrote the client's `mimeType` string straight into the S3
 * object's Content-Type, and /media/ is served from the APP'S OWN ORIGIN. So a
 * signed-up user could store `text/html` (or SVG) and have it render as a page
 * on postautomation.co.in, running script with any visitor's session.
 */

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46];
const GIF = [...Buffer.from("GIF89a"), 1, 0, 1, 0];
const WEBP = [...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];

describe("sniffImageMime", () => {
  it("identifies the four image formats generation produces", () => {
    expect(sniffImageMime(Buffer.from(PNG))).toBe("image/png");
    expect(sniffImageMime(Buffer.from(JPEG))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from(GIF))).toBe("image/gif");
    expect(sniffImageMime(Buffer.from(WEBP))).toBe("image/webp");
    expect(sniffImageMime(Buffer.from([...Buffer.from("GIF87a"), 1, 0]))).toBe("image/gif");
  });

  it("returns null for anything else — HTML, SVG, scripts, empty, truncated", () => {
    expect(sniffImageMime(Buffer.from("<!doctype html><script>alert(1)</script>"))).toBeNull();
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
    expect(sniffImageMime(Buffer.from("RIFF1234AVI LIST"))).toBeNull(); // RIFF but not WEBP
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it("ignores what the base64 CLAIMED to be", () => {
    // The point: the bytes decide. A PNG labelled text/html is stored as a PNG.
    expect(sniffImageMime(Buffer.from(b64(PNG), "base64"))).toBe("image/png");
  });
});

describe("assertSafeStoredContentType (defence in depth for every direct writer)", () => {
  it("allows image and video types the app serves", () => {
    for (const t of ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"]) {
      expect(() => assertSafeStoredContentType(t)).not.toThrow();
    }
  });

  it("refuses anything a browser would run or render as a document", () => {
    for (const t of [
      "text/html",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
      "application/javascript",
      "text/javascript",
      "application/pdf",
      "",
      "IMAGE/SVG+XML",
    ]) {
      expect(() => assertSafeStoredContentType(t)).toThrow();
    }
  });
});

describe("the unbound presigned upload route stays gone", () => {
  it("media.getUploadUrl no longer exists", async () => {
    const { mediaRouter } = await import("../routers/media.router");
    expect((mediaRouter as any)._def.procedures.getUploadUrl).toBeUndefined();
    // Its harmless org-scoped companion is untouched.
    expect((mediaRouter as any)._def.procedures.confirmUpload).toBeDefined();
  });
});
