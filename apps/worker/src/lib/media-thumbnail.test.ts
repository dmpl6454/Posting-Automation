/**
 * Media-grid WebP thumbnails (2026-11-10) — real sharp and real ffmpeg.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  grabVideoFrame,
  hasCurrentThumbnail,
  planThumbnail,
  renderThumbnailWebp,
  thumbnailKey,
  THUMB_EDGE,
  THUMB_MAX_IMAGE_BYTES,
} from "./media-thumbnail";

const url = "https://s3.example.com/a.jpg";

describe("planThumbnail", () => {
  it("images and videos get one; everything else is skipped", () => {
    expect(planThumbnail({ fileType: "image/jpeg", fileSize: 1000, url })).toEqual({ kind: "image" });
    expect(planThumbnail({ fileType: "video/mp4", fileSize: 3_000_000_000n, url })).toEqual({ kind: "video" });
    expect(planThumbnail({ fileType: "image/svg+xml", fileSize: 10, url }).kind).toBe("skip");
    expect(planThumbnail({ fileType: "application/pdf", fileSize: 10, url }).kind).toBe("skip");
    expect(planThumbnail({ fileType: "image/png", fileSize: THUMB_MAX_IMAGE_BYTES + 1, url }).kind).toBe("skip");
    expect(planThumbnail({ fileType: "image/png", fileSize: 10, url: "blob:x" }).kind).toBe("skip");
  });

  it("key and current-version check agree", () => {
    const key = thumbnailKey("org1", "m1");
    expect(key).toBe(`orgs/org1/media/m1/thumb_${THUMB_EDGE}_v1.webp`);
    expect(hasCurrentThumbnail(`https://s3.example.com/${key}`)).toBe(true);
    expect(hasCurrentThumbnail("https://s3.example.com/orgs/o/media/m/thumb_400x400.jpg")).toBe(false);
    expect(hasCurrentThumbnail(null)).toBe(false);
  });
});

describe("renderThumbnailWebp", () => {
  it("makes a small square WebP from a large photo", async () => {
    const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    const out = await renderThumbnailWebp(big);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(THUMB_EDGE);
    expect(meta.height).toBe(THUMB_EDGE);
    expect(out.length).toBeLessThan(big.length / 5);
  });

  it("applies EXIF orientation (a sideways phone photo comes out upright)", async () => {
    // Stored 600x300 with orientation 6 (rotate 90°): displayed 300x600, a tall photo.
    // Top half red, bottom half blue AFTER rotation ⇒ the top-centre of the
    // square crop must be the stored image's left side.
    const stored = await sharp({
      create: { width: 600, height: 300, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .composite([{ input: { create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 0, b: 0 } } }, left: 0, top: 0 }])
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const out = await renderThumbnailWebp(stored);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3);
    // Not upscaled: 300 wide is the limit.
    expect(info.width).toBeLessThanOrEqual(THUMB_EDGE);
    const top = px(Math.floor(info.width / 2), 2);
    const bottom = px(Math.floor(info.width / 2), info.height - 3);
    // Orientation 6 rotates clockwise: the stored LEFT (red) ends up on TOP.
    expect(top[0]).toBeGreaterThan(200);
    expect(bottom[2]).toBeGreaterThan(200);
  });
});

describe("grabVideoFrame (real ffmpeg)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "thumbtest-"));
    for (const [name, secs] of [["long.mp4", 3], ["short.mp4", 0.5]] as const) {
      execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=320x240:rate=25:duration=${secs}`, "-pix_fmt", "yuv420p", path.join(dir, name)]);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("grabs a frame and turns it into a WebP", async () => {
    const png = await grabVideoFrame(path.join(dir, "long.mp4"));
    const webp = await renderThumbnailWebp(png);
    const meta = await sharp(webp).metadata();
    expect(meta.format).toBe("webp");
    // Smaller than the thumbnail edge: kept as-is, never upscaled (the grid's
    // object-cover crops it square on screen).
    expect([meta.width, meta.height]).toEqual([320, 240]);
  });

  it("falls back to an earlier frame for a clip shorter than 1s", async () => {
    const png = await grabVideoFrame(path.join(dir, "short.mp4"));
    expect((await sharp(png).metadata()).width).toBe(320);
  });

  it("fails clearly on a file that is not a video", async () => {
    await expect(grabVideoFrame(path.join(dir, "missing.mp4"))).rejects.toThrow(/Could not read a frame/);
  });
});
