import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FRAME_STEP_SEC, clampSeekTime, formatTimecode, frameFileName } from "./video-frame";

describe("clampSeekTime", () => {
  it("keeps the target inside the playable range", () => {
    expect(clampSeekTime(3, 10)).toBe(3);
    expect(clampSeekTime(-1, 10)).toBe(0);
    expect(clampSeekTime(50, 10)).toBeCloseTo(10 - FRAME_STEP_SEC);
  });

  it("never returns NaN for an unknown duration or a bad target", () => {
    expect(clampSeekTime(5, 0)).toBe(0);
    expect(clampSeekTime(5, NaN)).toBe(0);
    expect(clampSeekTime(NaN, 10)).toBe(0);
  });
});

describe("formatTimecode / frameFileName", () => {
  it("formats minutes, seconds and hundredths", () => {
    expect(formatTimecode(0)).toBe("0:00.00");
    expect(formatTimecode(65.4)).toBe("1:05.40");
    expect(formatTimecode(NaN)).toBe("0:00.00");
  });

  it("names the captured frame after its position, as a jpg", () => {
    expect(frameFileName(12.481)).toBe("cover-frame-12.48s.jpg");
    expect(frameFileName(-3)).toBe("cover-frame-0.00s.jpg");
  });
});

describe("pick-a-frame cover wiring (2026-10-23)", () => {
  const ROOT = join(__dirname, "..", "..", "..");
  const compose = readFileSync(join(ROOT, "apps/web/components/content-agent/ComposeTab.tsx"), "utf8");
  const picker = readFileSync(join(ROOT, "apps/web/components/content-agent/VideoCoverPicker.tsx"), "utf8");

  it("sends the chosen frame through the SAME cover path as an uploaded image", () => {
    // prepareThumbnail → upload → videoThumbnail; no second cover pipeline.
    expect(compose).toMatch(/void handleThumbnailUpload\(idx, file\)/);
  });

  it("finds the tile by URL at pick time, never by a stale index", () => {
    expect(compose).toMatch(/postMediaRef\.current\.findIndex\(\(m\) => m\.url === pickedUrl\)/);
  });

  it("never creates a <video> for a large LOCAL file (OOM rule)", () => {
    expect(compose).toMatch(/tile\.file\.size > TILE_VIDEO_PREVIEW_MAX_BYTES/);
    expect(compose).toMatch(/canPreview=\{!isLargeLocal\}/);
  });

  it("reads pixels with CORS and releases the player on close", () => {
    expect(picker).toMatch(/crossOrigin="anonymous"/);
    expect(picker).toMatch(/removeAttribute\("src"\)/);
    expect(picker).toMatch(/el\.load\(\)/);
  });

  it("keeps image upload available inside the picker", () => {
    expect(picker).toMatch(/accept="image\/\*"/);
    expect(picker).toMatch(/Upload an image instead/);
  });
});
