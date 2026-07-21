import { describe, it, expect } from "vitest";
import {
  evaluateOptimization,
  buildTranscodeArgs,
  choosePublishUrl,
  planOptimizeGate,
  OPTIMIZE_SIZE_BYTES,
} from "../media-optimize";

const GB = 1024 * 1024 * 1024;

describe("evaluateOptimization", () => {
  it("passes a normal social export untouched (H.264+AAC, small, sane bitrate)", () => {
    const v = evaluateOptimization(
      { videoCodec: "h264", audioCodec: "aac", width: 1080, height: 1920, bitrate: 6_000_000 },
      15_000_000
    );
    expect(v.needed).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it("flags the live-verified camera master on every axis (PCM, >1GB, 222Mbps, 4K)", () => {
    const v = evaluateOptimization(
      { videoCodec: "h264", audioCodec: "pcm_s16be", width: 3840, height: 2160, bitrate: 222_010_815 },
      1_745_005_007
    );
    expect(v.needed).toBe(true);
    expect(v.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("flags HEVC video and silent-track files correctly", () => {
    expect(evaluateOptimization({ videoCodec: "hevc", audioCodec: "aac" }, 1000).needed).toBe(true);
    // no audio track at all is fine — platforms accept silent video
    expect(evaluateOptimization({ videoCodec: "h264" }, 1000).needed).toBe(false);
  });
});

describe("buildTranscodeArgs", () => {
  it("is an argv array with faststart, AAC, H.264 and the 1920 cap", () => {
    const args = buildTranscodeArgs("https://s3/x.mp4", "/tmp/out.mp4");
    expect(args[0]).toBe("-y");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args.join(" ")).toContain("force_original_aspect_ratio=decrease");
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });
});

describe("choosePublishUrl", () => {
  const done = { optimize: { status: "done", url: "https://s3/opt.mp4" } };
  const doneBadCodec = { optimize: { status: "done", url: "https://s3/opt.mp4", probe: { audioCodec: "pcm_s16be", videoCodec: "h264" } } };
  it("IG always prefers the rendition (IG's own ceiling is 1080 wide)", () => {
    expect(choosePublishUrl("INSTAGRAM", { url: "o", fileType: "video/mp4", metadata: done })).toBe("https://s3/opt.mp4");
    // images never touched; no rendition yet → original
    expect(choosePublishUrl("INSTAGRAM", { url: "o", fileType: "image/png", metadata: done })).toBe("o");
    expect(choosePublishUrl("INSTAGRAM", { url: "o", fileType: "video/mp4" })).toBe("o");
  });
  it("FB keeps the FULL-RESOLUTION original unless codec-broken or over the size cap", () => {
    // clean 4K export optimized only for bitrate/resolution → FB gets the original
    expect(choosePublishUrl("FACEBOOK", { url: "o", fileType: "video/mp4", fileSize: 800_000_000, metadata: done })).toBe("o");
    // PCM audio master → rendition (original is unpublishable)
    expect(choosePublishUrl("FACEBOOK", { url: "o", fileType: "video/mp4", fileSize: 800_000_000, metadata: doneBadCodec })).toBe("https://s3/opt.mp4");
    // over the safe cap → rendition
    expect(choosePublishUrl("FACEBOOK", { url: "o", fileType: "video/mp4", fileSize: 1_700_000_000, metadata: done })).toBe("https://s3/opt.mp4");
  });
  it("YouTube deliberately always gets the master", () => {
    expect(choosePublishUrl("YOUTUBE", { url: "o", fileType: "video/mp4", metadata: done })).toBe("o");
  });
});

describe("planOptimizeGate", () => {
  const base = { id: "m1", url: "o", fileType: "video/mp4" };
  const now = Date.parse("2026-07-21T12:00:00Z");

  it("small videos publish immediately — zero regression", () => {
    expect(
      planOptimizeGate({ platform: "INSTAGRAM", media: [{ ...base, fileSize: 150_000_000 }], now })
    ).toEqual({ action: "proceed" });
  });

  it("non-IG/FB platforms are never gated", () => {
    expect(
      planOptimizeGate({ platform: "YOUTUBE", media: [{ ...base, fileSize: 3 * GB }], now })
    ).toEqual({ action: "proceed" });
  });

  it("over-cap video with no/pending optimization → wait", () => {
    expect(
      planOptimizeGate({ platform: "INSTAGRAM", media: [{ ...base, fileSize: 1.7 * GB }], now })
    ).toEqual({ action: "wait", mediaId: "m1" });
    expect(
      planOptimizeGate({
        platform: "INSTAGRAM",
        media: [{ ...base, fileSize: 1.7 * GB, metadata: { optimize: { status: "processing", enqueuedAt: new Date(now - 60_000).toISOString() } } }],
        now,
      })
    ).toEqual({ action: "wait", mediaId: "m1" });
  });

  it("over-cap video with a finished rendition → proceed", () => {
    expect(
      planOptimizeGate({
        platform: "INSTAGRAM",
        media: [{ ...base, fileSize: 1.7 * GB, metadata: { optimize: { status: "done", url: "u" } } }],
        now,
      })
    ).toEqual({ action: "proceed" });
  });

  it("failed optimization or exceeded wait ceiling → fail with an actionable message", () => {
    const failed = planOptimizeGate({
      platform: "INSTAGRAM",
      media: [{ ...base, fileSize: 1.7 * GB, metadata: { optimize: { status: "failed", reasons: ["audio codec pcm_s16be"] } } }],
      now,
    });
    expect(failed.action).toBe("fail");
    expect((failed as { message: string }).message).toContain("H.264 + AAC");

    const stale = planOptimizeGate({
      platform: "INSTAGRAM",
      media: [{ ...base, fileSize: 1.7 * GB, metadata: { optimize: { status: "processing", enqueuedAt: new Date(now - 46 * 60_000).toISOString() } } }],
      now,
    });
    expect(stale.action).toBe("fail");
  });

  it("boundary: exactly at the size threshold publishes as-is", () => {
    expect(
      planOptimizeGate({ platform: "INSTAGRAM", media: [{ ...base, fileSize: OPTIMIZE_SIZE_BYTES }], now })
    ).toEqual({ action: "proceed" });
  });
});
