import { describe, it, expect } from "vitest";
import { classifyMediaUrl, isVideoMediaItem } from "../components/previews/preview-media";
import { withPosterHint } from "./video-poster";

describe("withPosterHint", () => {
  it("appends the Safari poster-frame fragment exactly once", () => {
    expect(withPosterHint("https://cdn/v.mp4")).toBe("https://cdn/v.mp4#t=0.001");
    expect(withPosterHint("https://cdn/v.mp4?sig=1")).toBe("https://cdn/v.mp4?sig=1#t=0.001");
    expect(withPosterHint("https://cdn/v.mp4#t=5")).toBe("https://cdn/v.mp4#t=5");
  });
});

/**
 * Guards the video/image split that keeps video URLs out of <img>.
 * WebKit's image loader ingests an ENTIRE video blob into memory (+1.57GB
 * measured for a 1.6GB file, 2026-07-21) — misclassifying a video as an
 * image re-introduces the Safari mid-upload tab kill.
 */
describe("classifyMediaUrl", () => {
  it("honors an explicit kind when the URL carries no contrary evidence", () => {
    expect(classifyMediaUrl("blob:https://x/abc", "video")).toBe("video");
    expect(classifyMediaUrl("blob:https://x/abc", "image")).toBe("image");
  });

  it("overrides a caller-supplied 'image' when the URL itself says video (backstop)", () => {
    // NOTE: this assertion used to be .toBe("image") — trusting the caller
    // blindly. A broken Compose classifier then passed kind "image" for an
    // uppercase-.MOV library pick and the video rendered through <img>
    // (Safari memory kill, 2026-09-01). The failure directions are
    // asymmetric: <video> on an image is cosmetic; <img> on a video is an
    // OOM — so a video-extension URL now always wins over kind "image".
    expect(classifyMediaUrl("https://cdn/x.mp4", "image")).toBe("video");
    expect(classifyMediaUrl("https://cdn/x.MOV", "image")).toBe("video");
  });

  it("classifies remote video URLs by extension (incl. query strings)", () => {
    expect(classifyMediaUrl("https://cdn/v.mp4")).toBe("video");
    expect(classifyMediaUrl("https://cdn/v.MOV?sig=abc")).toBe("video");
    expect(classifyMediaUrl("https://cdn/v.webm")).toBe("video");
    expect(classifyMediaUrl("https://cdn/v.m4v")).toBe("video");
  });

  it("defaults unknown/extension-less URLs to image (legacy behavior)", () => {
    expect(classifyMediaUrl("https://cdn/photo.jpg")).toBe("image");
    expect(classifyMediaUrl("blob:https://x/no-kind-info")).toBe("image");
    expect(classifyMediaUrl("https://cdn/opaque")).toBe("image");
  });
});

/**
 * The ONE classifier Compose uses for its media tiles, submit gates and
 * preview `mediaKinds`. The tile's Thumbnail + Super-text controls and the
 * <img>-vs-<video> choice all hang off this, so a false "image" here is both
 * a hidden-features bug AND the WebKit memory-ingest bug at once.
 */
describe("isVideoMediaItem", () => {
  it("classifies fresh uploads by File MIME type (still on blob: URLs)", () => {
    expect(isVideoMediaItem({ url: "blob:https://x/abc", file: { type: "video/quicktime" } })).toBe(true);
    expect(isVideoMediaItem({ url: "blob:https://x/abc", file: { type: "image/png" } })).toBe(false);
  });

  it("classifies library picks / restored drafts (no File) case-insensitively — the .MOV regression", () => {
    // S3 keys preserve the original extension's case (iPhone videos are
    // ".MOV"). The pre-fix classifier was case-sensitive, so these rendered
    // as broken <img> tiles with the Thumbnail/Super-text controls hidden
    // and the full video ingested into memory by WebKit (2026-09-01).
    expect(isVideoMediaItem({ url: "https://s3/org/123-abc.MOV" })).toBe(true);
    expect(isVideoMediaItem({ url: "https://s3/org/123-abc.MP4?X-Amz-Signature=x" })).toBe(true);
    expect(isVideoMediaItem({ url: "https://s3/org/123-abc.m4v" })).toBe(true);
    expect(isVideoMediaItem({ url: "https://s3/org/123-abc.mp4" })).toBe(true);
  });

  it("still treats images as images", () => {
    expect(isVideoMediaItem({ url: "https://s3/org/123-abc.JPG" })).toBe(false);
    expect(isVideoMediaItem({ url: "https://s3/org/123-abc.png" })).toBe(false);
  });

  it("errs toward video on ambiguous URLs that name video (the cheap failure direction)", () => {
    expect(isVideoMediaItem({ url: "https://s3/org/Video-export" })).toBe(true);
  });
});
