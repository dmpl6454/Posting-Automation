import { describe, it, expect } from "vitest";
import { validateVideoAgainstPlatforms } from "../lib/media-constraints";

const video = (over: Partial<{ fileName: string; fileType: string; fileSize: number; metadata: unknown }> = {}) => ({
  fileName: "clip.mp4",
  fileType: "video/mp4",
  fileSize: 100_000_000,
  metadata: null as unknown,
  ...over,
});

describe("validateVideoAgainstPlatforms", () => {
  it("never blocks non-Meta platforms or image media", () => {
    expect(validateVideoAgainstPlatforms([video({ metadata: { optimize: { status: "failed" } } })], ["YOUTUBE", "TWITTER"])).toBeNull();
    expect(
      validateVideoAgainstPlatforms([{ ...video(), fileType: "image/png", metadata: { optimize: { status: "failed" } } }], ["INSTAGRAM"])
    ).toBeNull();
  });

  it("passes normal videos (no metadata yet, pending, done, skipped)", () => {
    expect(validateVideoAgainstPlatforms([video()], ["INSTAGRAM"])).toBeNull();
    for (const status of ["pending", "processing", "done", "skipped"]) {
      expect(validateVideoAgainstPlatforms([video({ metadata: { optimize: { status } } })], ["INSTAGRAM"])).toBeNull();
    }
  });

  it("refuses a failed optimization with an actionable message", () => {
    const msg = validateVideoAgainstPlatforms(
      [video({ fileName: "master.mp4", metadata: { optimize: { status: "failed", reasons: ["audio codec pcm_s16be"] } } })],
      ["INSTAGRAM"]
    );
    expect(msg).toContain("master.mp4");
    expect(msg).toContain("H.264 + AAC");
    expect(msg).toContain("pcm_s16be");
  });

  it("refuses probed durations over Instagram's 15-minute ceiling — IG targets only", () => {
    const long = video({ metadata: { optimize: { status: "skipped", probe: { durationSec: 16 * 60 } } } });
    expect(validateVideoAgainstPlatforms([long], ["INSTAGRAM"])).toContain("15 minutes");
    expect(validateVideoAgainstPlatforms([long], ["FACEBOOK"])).toBeNull();
  });
});
