import { describe, it, expect } from "vitest";
import { buildOverlayFfmpegArgs } from "./video-overlay";

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
