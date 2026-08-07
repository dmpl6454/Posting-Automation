import { describe, it, expect } from "vitest";
// Import from the dependency-free module, NOT ./video-overlay — the latter
// pulls @postautomation/ai (langchain/langsmith) and the AWS SDK, which makes a
// pure argv test cost minutes and breaks on unrelated ESM interop issues.
import { buildOverlayFfmpegArgs } from "./video-overlay-args";

describe("buildOverlayFfmpegArgs", () => {
  it("returns an array of discrete args (no shell quoting)", () => {
    const args = buildOverlayFfmpegArgs({
      inputArgs: ["-i", "/tmp/in.mp4"],
      filterComplex: "[0:v]drawtext=text='hi'[vout]",
      outputPath: "/tmp/out.mp4",
    });
    expect(Array.isArray(args)).toBe(true);
    // No element may carry surrounding shell quotes — execFileSync passes each
    // verbatim, so a quote would become part of the literal filename / value.
    for (const a of args) {
      expect(a.startsWith('"')).toBe(false);
      expect(a.endsWith('"')).toBe(false);
    }
  });

  it("keeps filterComplex as ONE element (not split, not quoted)", () => {
    const filterComplex =
      "[0:v]drawtext=text='a;b':x=10[vlogo];[vlogo]drawtext=text='c'[vout]";
    const args = buildOverlayFfmpegArgs({
      inputArgs: ["-i", "/tmp/in.mp4"],
      filterComplex,
      outputPath: "/tmp/out.mp4",
    });
    const idx = args.indexOf("-filter_complex");
    expect(idx).toBeGreaterThanOrEqual(0);
    // The whole filtergraph (including the `;` separators) is the SINGLE next
    // element — never split across multiple args, never quote-wrapped.
    expect(args[idx + 1]).toBe(filterComplex);
  });

  it("maps [vout] and outputPath as their own unquoted elements", () => {
    const args = buildOverlayFfmpegArgs({
      inputArgs: ["-i", "/tmp/in.mp4"],
      filterComplex: "[0:v]null[vout]",
      outputPath: "/tmp/out.mp4",
    });
    const mapIdx = args.indexOf("-map");
    expect(args[mapIdx + 1]).toBe("[vout]"); // NOT "\"[vout]\""
    expect(args[args.length - 1]).toBe("/tmp/out.mp4"); // NOT "\"/tmp/out.mp4\""
  });

  /**
   * REGRESSION GUARD — 2026-08-07 incident.
   *
   * The overlay pass ran `-preset ultrafast` with NO rate control. Burning a
   * watermark forces a re-encode, and with no -crf/-maxrate the encoder holds
   * quality by spending bits: a 35.7MB optimized rendition came back out at
   * 128MB (3.6×). Instagram then had to pull 128MB per target from a saturated
   * box, so its container processing outran the publish poll budget and 14 of
   * 39 targets FAILED. These assertions exist so the constraints cannot be
   * quietly dropped again.
   */
  describe("rate control (2026-08-07 regression guard)", () => {
    const args = buildOverlayFfmpegArgs({
      inputArgs: ["-i", "/tmp/in.mp4"],
      filterComplex: "[0:v]null[vout]",
      outputPath: "/tmp/out.mp4",
    });
    const valueOf = (flag: string) => args[args.indexOf(flag) + 1];

    it("pins an explicit codec and a size-bounding CRF", () => {
      expect(valueOf("-c:v")).toBe("libx264");
      expect(valueOf("-crf")).toBe("23");
    });

    it("caps the bitrate so the output cannot balloon past its input", () => {
      expect(args).toContain("-maxrate");
      expect(args).toContain("-bufsize");
      // A cap only bounds size if it is actually below the ~10Mbps the
      // unconstrained encode produced.
      const maxrateMbps = parseInt(valueOf("-maxrate")!.replace(/M$/, ""), 10);
      expect(maxrateMbps).toBeLessThanOrEqual(8);
    });

    it("never reverts to the unconstrained ultrafast preset", () => {
      expect(valueOf("-preset")).not.toBe("ultrafast");
    });

    it("bounds ffmpeg threads so concurrent encodes cannot starve nginx/MinIO", () => {
      const threads = parseInt(valueOf("-threads") ?? "", 10);
      expect(threads).toBeGreaterThanOrEqual(1);
      // 4-core prod box, VIDEO_OVERLAY_CONCURRENCY=2 → must leave a core to serve.
      expect(threads).toBeLessThanOrEqual(2);
    });

    it("still stream-copies audio (re-encoding it would be pure waste)", () => {
      expect(valueOf("-codec:a")).toBe("copy");
    });
  });

  it("a shell-injection payload in filterComplex stays inert (one literal element, no shell parsing)", () => {
    // If text/channelName ever carried metachars, they'd be inside this single
    // element. With execFileSync there is no shell to interpret `$(...)`/`;`/`|`.
    const malicious = "[0:v]drawtext=text='$(touch /tmp/pwn); rm -rf /'[vout]";
    const args = buildOverlayFfmpegArgs({
      inputArgs: ["-i", "/tmp/in.mp4"],
      filterComplex: malicious,
      outputPath: "/tmp/out.mp4",
    });
    // Exactly one element equals the payload; it is not spread across args.
    expect(args.filter((a) => a === malicious)).toHaveLength(1);
    expect(args.filter((a) => a.includes("$("))).toHaveLength(1);
  });
});
