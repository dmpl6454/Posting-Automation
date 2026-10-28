import { describe, it, expect } from "vitest";
import {
  evaluateOptimization,
  buildTranscodeArgs,
  choosePublishUrl,
  planOptimizeGate,
  OPTIMIZE_SIZE_BYTES,
  OPTIMIZE_ARGS_VERSION,
  isCurrentRendition,
  parseFrameRate,
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

// 2026-10-10 (IG "error code 2207082"): Meta's Reels/Stories spec is AAC at
// 48kHz max in 1–2 channels, 23–60 FPS, 8-bit 4:2:0 SDR. Files outside it now
// get a rendition.
describe("evaluateOptimization — Meta video spec", () => {
  const ok = { videoCodec: "h264", audioCodec: "aac", width: 1080, height: 1920, bitrate: 6_000_000 };

  it("still passes a normal phone export (30fps, 8-bit, bt709, 44.1/48kHz stereo)", () => {
    expect(
      evaluateOptimization({ ...ok, fps: 29.97, pixFmt: "yuv420p", colorTransfer: "bt709", audioSampleRate: 44100, audioChannels: 2 }, 1000).needed
    ).toBe(false);
    expect(evaluateOptimization({ ...ok, fps: 60, audioSampleRate: 48000, audioChannels: 1 }, 1000).needed).toBe(false);
  });

  it("flags slow-motion above 60fps", () => {
    const v = evaluateOptimization({ ...ok, fps: 120 }, 1000);
    expect(v.needed).toBe(true);
    expect(v.reasons.join()).toMatch(/120fps/);
  });

  it("flags HDR (HLG or PQ) and 10-bit / non-4:2:0 video", () => {
    expect(evaluateOptimization({ ...ok, colorTransfer: "arib-std-b67", pixFmt: "yuv420p10le" }, 1000).reasons.join()).toMatch(/HDR/);
    expect(evaluateOptimization({ ...ok, colorTransfer: "smpte2084" }, 1000).needed).toBe(true);
    expect(evaluateOptimization({ ...ok, pixFmt: "yuv420p10le" }, 1000).reasons.join()).toMatch(/8-bit 4:2:0/);
    expect(evaluateOptimization({ ...ok, pixFmt: "yuv444p" }, 1000).needed).toBe(true);
  });

  it("flags audio above 48kHz or with more than two channels", () => {
    expect(evaluateOptimization({ ...ok, audioSampleRate: 96000 }, 1000).reasons.join()).toMatch(/96kHz/);
    expect(evaluateOptimization({ ...ok, audioChannels: 6 }, 1000).reasons.join()).toMatch(/6-channel/);
  });
});

describe("parseFrameRate", () => {
  it("reads ffprobe rationals and rejects unknowns", () => {
    expect(parseFrameRate("60/1")).toBe(60);
    expect(parseFrameRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseFrameRate("0/0")).toBeUndefined();
    expect(parseFrameRate(undefined)).toBeUndefined();
  });
});

describe("isCurrentRendition", () => {
  it("only trusts a finished rendition made by the current transcode args", () => {
    expect(isCurrentRendition({ optimize: { status: "done", url: "u", argsVersion: OPTIMIZE_ARGS_VERSION } })).toBe(true);
    expect(isCurrentRendition({ optimize: { status: "done", url: "u" } })).toBe(false); // made before 2026-10-10
    expect(isCurrentRendition({ optimize: { status: "processing", argsVersion: OPTIMIZE_ARGS_VERSION } })).toBe(false);
    expect(isCurrentRendition(null)).toBe(false);
  });
});

describe("buildTranscodeArgs", () => {
  it("encodes to Meta's spec: AAC 48kHz stereo, at most 60fps, SDR bt709 tags", () => {
    const args = buildTranscodeArgs("https://s3/x.mp4", "/tmp/out.mp4");
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-ar")).toBe("48000");
    expect(at("-ac")).toBe("2");
    expect(at("-fpsmax")).toBe("60");
    expect(at("-color_trc")).toBe("bt709");
    expect(at("-pix_fmt")).toBe("yuv420p");
  });

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
  it("X keeps originals up to its 512MB INIT cap, rendition above (live-seen maxFileSizeExceeded)", () => {
    expect(choosePublishUrl("TWITTER", { url: "o", fileType: "video/mp4", fileSize: 400_000_000, metadata: done })).toBe("o");
    expect(choosePublishUrl("TWITTER", { url: "o", fileType: "video/mp4", fileSize: 600_000_000, metadata: done })).toBe("https://s3/opt.mp4");
    expect(choosePublishUrl("TWITTER", { url: "o", fileType: "video/mp4", fileSize: 100_000_000, metadata: doneBadCodec })).toBe("https://s3/opt.mp4");
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

  it("non-capped platforms are never gated", () => {
    expect(
      planOptimizeGate({ platform: "YOUTUBE", media: [{ ...base, fileSize: 3 * GB }], now })
    ).toEqual({ action: "proceed" });
  });

  it("X gates above 512MB, proceeds below", () => {
    expect(
      planOptimizeGate({ platform: "TWITTER", media: [{ ...base, fileSize: 600_000_000 }], now })
    ).toEqual({ action: "wait", mediaId: "m1" });
    expect(
      planOptimizeGate({ platform: "TWITTER", media: [{ ...base, fileSize: 400_000_000 }], now })
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

describe("choosePublishUrl — TikTok (2026-10-28)", () => {
  // TikTok takes H.264/H.265/VP8/VP9, 23–60fps, 360–4096px, up to 4GB — so a
  // phone or camera export usually publishes as the ORIGINAL (full quality, like
  // Facebook). The rendition is used only when the stored probe proves the
  // original is out of that spec AND a rendition exists.
  const R = "https://s3/opt.mp4";
  const done = (probe: Record<string, unknown>) => ({ optimize: { status: "done", url: R, probe } });
  const pick = (metadata: unknown, fileSize = 200_000_000, fileType = "video/mp4") =>
    choosePublishUrl("TIKTOK", { url: "o", fileType, fileSize, metadata });

  it("keeps the original for every codec TikTok accepts, even when a rendition exists", () => {
    for (const videoCodec of ["h264", "hevc", "vp8", "vp9"]) {
      expect(pick(done({ videoCodec, fps: 30, width: 2160, height: 3840 }))).toBe("o");
    }
    // 4K at 60fps is in spec for TikTok (Instagram would get the rendition).
    expect(pick(done({ videoCodec: "h264", fps: 60, width: 3840, height: 2160 }))).toBe("o");
    expect(pick(done({ videoCodec: "h264", fps: 59.94, width: 4096, height: 2160 }))).toBe("o");
    // PCM audio says nothing about TikTok's video spec — not a reason to downgrade.
    expect(pick(done({ videoCodec: "h264", audioCodec: "pcm_s16be", fps: 30, width: 1080, height: 1920 }))).toBe("o");
  });

  it("uses the rendition when the probe shows the original is out of TikTok's spec", () => {
    expect(pick(done({ videoCodec: "prores", fps: 30, width: 1920, height: 1080 }))).toBe(R);
    expect(pick(done({ videoCodec: "h264", fps: 120, width: 1920, height: 1080 }))).toBe(R);
    expect(pick(done({ videoCodec: "hevc", fps: 30, width: 5760, height: 3240 }))).toBe(R);
    expect(pick(done({ videoCodec: "h264", fps: 30, width: 1080, height: 1920 }), 4 * GB + 1)).toBe(R);
  });

  it("keeps the original when there is no rendition or no probe — it never guesses", () => {
    expect(pick({ optimize: { status: "processing", probe: { videoCodec: "prores" } } })).toBe("o");
    expect(pick({ optimize: { status: "failed", probe: { videoCodec: "prores" } } })).toBe("o");
    expect(pick({ optimize: { status: "done", url: R } })).toBe("o");
    expect(pick(null)).toBe("o");
    expect(pick(undefined)).toBe("o");
  });

  it("never touches an image", () => {
    expect(pick(done({ videoCodec: "prores" }), 1000, "image/jpeg")).toBe("o");
  });
});

describe("planOptimizeGate — TikTok waits on a rendition only above TikTok's own 4 GB limit", () => {
  const base = { id: "m1", url: "o", fileType: "video/mp4" };
  const now = Date.parse("2026-10-28T12:00:00Z");
  it.each([
    ["a 3.5GB original with no optimization", undefined],
    ["a pending optimization", { optimize: { status: "processing", enqueuedAt: new Date(now - 60_000).toISOString() } }],
    ["a failed optimization", { optimize: { status: "failed", reasons: ["video codec prores"] } }],
    ["a long-stale optimization", { optimize: { status: "processing", enqueuedAt: new Date(now - 3 * 3600_000).toISOString() } }],
  ])("%s → proceed", (_label, metadata) => {
    expect(
      planOptimizeGate({ platform: "TIKTOK", media: [{ ...base, fileSize: 3.5 * GB, metadata }], now })
    ).toEqual({ action: "proceed" });
  });
});

describe("planOptimizeGate — a TikTok original over 4,000,000,000 bytes", () => {
  // Uploads are capped at 4 GiB (4,294,967,296) but TikTok's "4 GB" is decimal:
  // an original in between was sent and refused AFTER init, costing one of the
  // creator's ~15 daily posts.
  const base = { id: "m1", url: "o", fileType: "video/mp4", fileSize: 4_100_000_000 };
  const now = Date.parse("2026-10-28T12:00:00Z");
  it("waits for the rendition", () => {
    expect(planOptimizeGate({ platform: "TIKTOK", media: [{ ...base, metadata: { optimize: { status: "processing", enqueuedAt: new Date(now - 60_000).toISOString() } } }], now })).toEqual({
      action: "wait",
      mediaId: "m1",
    });
  });
  it("proceeds once the rendition exists (choosePublishUrl then sends it)", () => {
    const metadata = { optimize: { status: "done", url: "r" } };
    expect(planOptimizeGate({ platform: "TIKTOK", media: [{ ...base, metadata }], now })).toEqual({ action: "proceed" });
    expect(choosePublishUrl("TIKTOK", { ...base, metadata })).toBe("r");
  });
  it("fails with a TikTok-worded message when the rendition failed", () => {
    const out = planOptimizeGate({ platform: "TIKTOK", media: [{ ...base, metadata: { optimize: { status: "failed", error: "x" } } }], now });
    expect(out.action).toBe("fail");
    expect((out as { message: string }).message).toMatch(/TikTok/);
  });
  it("exactly 4,000,000,000 bytes still goes as-is", () => {
    expect(planOptimizeGate({ platform: "TIKTOK", media: [{ ...base, fileSize: 4_000_000_000 }], now })).toEqual({ action: "proceed" });
  });
});
