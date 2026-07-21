import { describe, it, expect } from "vitest";
import { resolveVideoMime } from "./video-mime";

describe("resolveVideoMime", () => {
  it("passes through proper video types unchanged", () => {
    expect(resolveVideoMime("clip.mp4", "video/mp4")).toBe("video/mp4");
    expect(resolveVideoMime("rec.mov", "video/quicktime")).toBe("video/quicktime");
    expect(resolveVideoMime("v.webm", "video/webm")).toBe("video/webm");
  });

  it("normalizes Apple's x-m4v alias to plain mp4", () => {
    expect(resolveVideoMime("movie.m4v", "video/x-m4v")).toBe("video/mp4");
  });

  it("maps an EMPTY reported type from the extension (Windows registry gap)", () => {
    expect(resolveVideoMime("screenrec.mov", "")).toBe("video/quicktime");
    expect(resolveVideoMime("clip.MP4", "")).toBe("video/mp4");
    expect(resolveVideoMime("movie.m4v", "")).toBe("video/mp4");
    expect(resolveVideoMime("v.webm", "")).toBe("video/webm");
  });

  it("returns null for unknown empty-type extensions (caller rejects clearly)", () => {
    expect(resolveVideoMime("raw.mkv", "")).toBeNull();
    expect(resolveVideoMime("noext", "")).toBeNull();
  });

  it("does not claim non-video types", () => {
    expect(resolveVideoMime("pic.png", "image/png")).toBeNull();
    expect(resolveVideoMime("doc.pdf", "application/pdf")).toBeNull();
  });

  it("keeps exotic video containers as-reported so the server allowlist owns the verdict", () => {
    // mkv IS reported as a video type — the server rejects it with an
    // actionable message; the client must not silently rewrite it to mp4.
    expect(resolveVideoMime("raw.mkv", "video/x-matroska")).toBe("video/x-matroska");
  });
});
