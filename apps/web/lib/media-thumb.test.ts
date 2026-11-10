import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { mediaThumbSrc } from "./media-thumb";

describe("mediaThumbSrc", () => {
  it("returns the worker's WebP", () => {
    expect(mediaThumbSrc({ thumbnailUrl: "https://s3.example.com/orgs/o/media/m/thumb_512_v1.webp" })).toBe(
      "https://s3.example.com/orgs/o/media/m/thumb_512_v1.webp"
    );
  });
  it("never hands a video file to <img>", () => {
    expect(mediaThumbSrc({ thumbnailUrl: "https://s3.example.com/x/clip.MOV" })).toBeNull();
    expect(mediaThumbSrc({ thumbnailUrl: "https://s3.example.com/x/clip.mp4?v=1" })).toBeNull();
  });
  it("ignores missing and non-http values", () => {
    expect(mediaThumbSrc({ thumbnailUrl: null })).toBeNull();
    expect(mediaThumbSrc({})).toBeNull();
    expect(mediaThumbSrc({ thumbnailUrl: "javascript:alert(1)" })).toBeNull();
    expect(mediaThumbSrc({ thumbnailUrl: "blob:abc" })).toBeNull();
  });
});

describe("grid wiring", () => {
  const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
  it("Media page and picker draw the thumbnail for videos instead of a <video> per tile", () => {
    for (const f of ["app/dashboard/media/page.tsx", "components/media-picker-dialog.tsx"]) {
      const src = read(f);
      expect(src).toMatch(/isVideo && mediaThumbSrc\(item\)|startsWith\("video\/"\) && mediaThumbSrc\(media\)/);
      // A raw thumbnailUrl must never reach src= directly (only through mediaThumbSrc).
      expect(src).not.toMatch(/src=\{[a-z]+\.thumbnailUrl/);
    }
  });
});
