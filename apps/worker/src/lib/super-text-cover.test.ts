import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  COVER_MAX_EDGE,
  buildFrameGrabArgs,
  composeCoverJpeg,
  coverCandidateTimes,
  pickBestCover,
  planCoverBase,
  prepareCoverBase,
  scoreCoverCandidate,
} from "./super-text-cover";

/** A flat-colour frame — what a fade-in or a black leader looks like. */
async function flat(w: number, h: number, rgb: { r: number; g: number; b: number }) {
  return sharp({ create: { width: w, height: h, channels: 3, background: rgb } }).png().toBuffer();
}

/** A high-detail frame: a checkerboard of alternating tiles. */
async function textured(w: number, h: number, tile = 8) {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = ((Math.floor(x / tile) + Math.floor(y / tile)) % 2) * 200 + 30;
      const i = (y * w + x) * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("coverCandidateTimes", () => {
  it("samples a few EARLY moments, never past the end of a short clip", () => {
    expect(coverCandidateTimes(8)).toEqual([0.2, 1, 2]);
    expect(coverCandidateTimes(30)).toEqual([0.2, 1, 2, 4]);
    expect(coverCandidateTimes(1.5)).toEqual([0.2, 0.4, 1]);
    expect(coverCandidateTimes(0.3)).toEqual([0.1]);
  });
  it("falls back to fixed early offsets when the duration is unknown", () => {
    expect(coverCandidateTimes(undefined)).toEqual([0.2, 1, 2, 3]);
  });
});

describe("scoreCoverCandidate + pickBestCover", () => {
  it("prefers a detailed frame over a black fade and over a blown-out flash", async () => {
    const black = await scoreCoverCandidate(await flat(320, 180, { r: 5, g: 5, b: 5 }));
    const white = await scoreCoverCandidate(await flat(320, 180, { r: 250, g: 250, b: 250 }));
    const detail = await scoreCoverCandidate(await textured(320, 180));
    expect(black.brightness).toBeLessThan(20);
    expect(white.brightness).toBeGreaterThan(235);
    expect(detail.score).toBeGreaterThan(black.score * 10);
    expect(detail.score).toBeGreaterThan(white.score * 10);
    const best = pickBestCover([
      { t: 0.2, score: black.score },
      { t: 1, score: detail.score },
      { t: 2, score: white.score },
    ]);
    expect(best?.t).toBe(1);
  });

  it("keeps the EARLIER frame on a near-tie (a later frame must beat it by >10%)", () => {
    expect(pickBestCover([{ t: 0.2, score: 100 }, { t: 1, score: 105 }])?.t).toBe(0.2);
    expect(pickBestCover([{ t: 0.2, score: 100 }, { t: 1, score: 120 }])?.t).toBe(1);
    expect(pickBestCover([])).toBeNull();
  });
});

describe("planCoverBase", () => {
  it("starts from the user's uploaded cover when there is one", () => {
    expect(planCoverBase({ videoThumbnail: { mediaId: "m", url: "https://s3/cover.jpg" } })).toEqual({
      kind: "user-cover",
      url: "https://s3/cover.jpg",
    });
  });
  it("otherwise grabs a frame — and never stacks a strip on a cover WE generated earlier", () => {
    expect(planCoverBase(null)).toEqual({ kind: "first-frame" });
    expect(planCoverBase({})).toEqual({ kind: "first-frame" });
    expect(
      planCoverBase({ videoThumbnail: { mediaId: "m", url: "https://s3/c.jpg", superText: { sourceMediaId: "src" } } })
    ).toEqual({ kind: "first-frame" });
    expect(planCoverBase({ videoThumbnail: { mediaId: "m", url: "ftp://nope" } })).toEqual({ kind: "first-frame" });
  });
});

describe("prepareCoverBase + composeCoverJpeg (real pixels)", () => {
  it("caps the long edge and reports the FINAL size the strip must be rendered at", async () => {
    const base = await prepareCoverBase(await textured(3840, 2160, 64));
    expect(Math.max(base.width, base.height)).toBe(COVER_MAX_EDGE);
    expect(base.width).toBe(1920);
    expect(base.height).toBe(1080);
  });

  it("does not enlarge a small frame", async () => {
    const base = await prepareCoverBase(await textured(540, 960, 16));
    expect([base.width, base.height]).toEqual([540, 960]);
  });

  it("composites the strip over the frame and returns a JPEG under the cap", async () => {
    const base = await prepareCoverBase(await flat(400, 700, { r: 40, g: 90, b: 140 }));
    // A transparent full-frame PNG with an opaque white block — a stand-in strip.
    const strip = await sharp({ create: { width: 400, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        {
          input: await sharp({ create: { width: 300, height: 80, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
            .png()
            .toBuffer(),
          left: 50,
          top: 500,
        },
      ])
      .png()
      .toBuffer();
    const jpeg = await composeCoverJpeg(base, strip);
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([400, 700]);
    // Inside the strip it is white; outside it is still the frame colour.
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };
    expect(px(200, 540)[0]).toBeGreaterThan(240);
    expect(px(200, 100)[2]).toBeGreaterThan(120);
    expect(px(200, 100)[0]).toBeLessThan(80);
  });

  it("refuses a strip rendered at the wrong size (it would land in the wrong place)", async () => {
    const base = await prepareCoverBase(await flat(400, 700, { r: 1, g: 2, b: 3 }));
    const wrong = await sharp({ create: { width: 401, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    await expect(composeCoverJpeg(base, wrong)).rejects.toThrow(/does not match/);
  });
});

describe("buildFrameGrabArgs", () => {
  it("seeks on INPUT (short read) and writes one PNG frame", () => {
    const args = buildFrameGrabArgs("https://s3/v.mp4", "/tmp/f.png", 1);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args).toContain("-frames:v");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
    expect(args.at(-1)).toBe("/tmp/f.png");
    expect(args).toContain("png");
    // 8-bit frames only — a 16-bit PNG skews every scorer statistic.
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("rgb24");
  });

  it("scoreCoverCandidate reads 8-bit statistics even from a 16-bit PNG", async () => {
    const png16 = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .png()
      .toBuffer();
    const score = await scoreCoverCandidate(png16);
    expect(score.brightness).toBeLessThan(20);
  });
});
