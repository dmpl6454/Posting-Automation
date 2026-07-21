import { describe, it, expect } from "vitest";
import { classifyMediaUrl } from "../components/previews/preview-media";
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
  it("honors an explicit kind above any URL heuristic", () => {
    expect(classifyMediaUrl("blob:https://x/abc", "video")).toBe("video");
    expect(classifyMediaUrl("blob:https://x/abc", "image")).toBe("image");
    expect(classifyMediaUrl("https://cdn/x.mp4", "image")).toBe("image");
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
