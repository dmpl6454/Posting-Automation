import { describe, it, expect } from "vitest";
import { displayDimensions, streamRotation } from "./super-text-burn";

/**
 * 2026-10-03 incident: an Instagram story's super text sat mid-frame and ran off
 * the right edge. The source was a phone video — coded 1920×1080 with a 90°
 * display matrix. The worker rendered the strip at the CODED size while ffmpeg
 * overlaid it on the ROTATED (1080×1920) frame.
 *
 * The side-data fixtures below are the VERBATIM `ffprobe -show_streams` output
 * (ffprobe 6.1.1) for a clip written with `-display_rotation 90` / `-90`; the
 * decoded first frame of the same clip measured 1080×1920.
 */
const rotatedPlus90 = {
  codec_type: "video",
  width: 1920,
  height: 1080,
  side_data_list: [
    {
      side_data_type: "Display Matrix",
      displaymatrix:
        "\n00000000:            0      -65536           0\n00000001:        65536           0           0\n00000002:            0           0  1073741824\n",
      rotation: 90,
    },
  ],
};

const rotatedMinus90 = {
  ...rotatedPlus90,
  side_data_list: [{ side_data_type: "Display Matrix", displaymatrix: "…", rotation: -90 }],
};

describe("streamRotation", () => {
  it("reads the Display Matrix side data (ffmpeg ≥ 5), both signs", () => {
    expect(streamRotation(rotatedPlus90)).toBe(90);
    expect(streamRotation(rotatedMinus90)).toBe(270);
  });

  it("falls back to the legacy mov `rotate` tag (ffmpeg < 5) as a string or number", () => {
    expect(streamRotation({ width: 1920, height: 1080, tags: { rotate: "90" } })).toBe(90);
    expect(streamRotation({ width: 1920, height: 1080, tags: { rotate: 270 } })).toBe(270);
    expect(streamRotation({ width: 1920, height: 1080, tags: { rotate: "180" } })).toBe(180);
  });

  it("side data wins over the tag, like ffmpeg itself", () => {
    expect(
      streamRotation({ ...rotatedMinus90, tags: { rotate: "0" } })
    ).toBe(270);
  });

  it("is 0 for a plain stream, a missing stream, and unreadable values", () => {
    expect(streamRotation(undefined)).toBe(0);
    expect(streamRotation({ width: 720, height: 1280 })).toBe(0);
    expect(streamRotation({ width: 720, height: 1280, side_data_list: [] })).toBe(0);
    expect(streamRotation({ width: 720, height: 1280, side_data_list: [{ side_data_type: "Other" }] })).toBe(0);
    expect(streamRotation({ width: 720, height: 1280, tags: { rotate: "sideways" } })).toBe(0);
    expect(streamRotation({ width: 720, height: 1280, tags: { rotate: "" } })).toBe(0);
  });

  it("normalises full turns and rounds an odd angle to the nearest quarter turn", () => {
    expect(streamRotation({ tags: { rotate: "360" } })).toBe(0);
    expect(streamRotation({ tags: { rotate: "-270" } })).toBe(90);
    expect(streamRotation({ tags: { rotate: "450" } })).toBe(90);
    expect(streamRotation({ side_data_list: [{ rotation: -89.9 }] })).toBe(270);
  });
});

describe("displayDimensions — the strip canvas is the DISPLAY size", () => {
  it("swaps the axes for a 90° phone video (the incident)", () => {
    expect(displayDimensions(rotatedPlus90)).toEqual({ width: 1080, height: 1920, rotation: 90 });
    expect(displayDimensions(rotatedMinus90)).toEqual({ width: 1080, height: 1920, rotation: 270 });
  });

  it("keeps the coded size for 0° and 180° (an upside-down clip is still the same shape)", () => {
    expect(displayDimensions({ width: 720, height: 1280 })).toEqual({ width: 720, height: 1280, rotation: 0 });
    expect(displayDimensions({ width: 1920, height: 1080, tags: { rotate: "180" } })).toEqual({
      width: 1920,
      height: 1080,
      rotation: 180,
    });
  });

  it("passes undefined through so the worker's 1080×1920 default still applies", () => {
    expect(displayDimensions(undefined)).toEqual({ width: undefined, height: undefined, rotation: 0 });
    expect(displayDimensions({ tags: { rotate: "90" } })).toEqual({ width: undefined, height: undefined, rotation: 90 });
  });
});
