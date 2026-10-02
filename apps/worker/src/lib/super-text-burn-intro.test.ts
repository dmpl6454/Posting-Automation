import { describe, it, expect } from "vitest";
import { buildSuperTextCompositeArgs } from "./super-text-burn";

const base = { inputPath: "/tmp/in.mp4", overlayPngPath: "/tmp/strip.png", outputPath: "/tmp/out.mp4" };

describe("buildSuperTextCompositeArgs — intro window", () => {
  it("without showForSeconds the argv is the original every-frame overlay (byte-identical)", () => {
    const args = buildSuperTextCompositeArgs(base);
    expect(args).toContain("[0:v][1:v]overlay=0:0:format=auto[vout]");
    expect(args.join(" ")).not.toContain("enable");
    expect(buildSuperTextCompositeArgs({ ...base, showForSeconds: undefined })).toEqual(args);
  });

  it("intro scope keeps the strip on screen only for the first N seconds", () => {
    const args = buildSuperTextCompositeArgs({ ...base, showForSeconds: 3 });
    expect(args).toContain("[0:v][1:v]overlay=0:0:format=auto:enable='lte(t,3.00)'[vout]");
  });

  it("the window is a formatted NUMBER — garbage cannot reach the ffmpeg expression", () => {
    const filt = (n: number) => {
      const args = buildSuperTextCompositeArgs({ ...base, showForSeconds: n });
      return args[args.indexOf("-filter_complex") + 1]!;
    };
    expect(filt(0)).not.toContain("enable");
    expect(filt(Number.NaN)).not.toContain("enable");
    expect(filt(-5)).not.toContain("enable");
    expect(filt(0.01)).toContain("lte(t,0.10)");
    expect(filt(1e9)).toContain("lte(t,3600.00)");
  });
});
