import { describe, it, expect } from "vitest";
import {
  planThumbnailTransform,
  needsReencode,
  describeThumbAdjustment,
  THUMB_MAX_BYTES,
  THUMB_MAX_EDGE,
} from "./thumbnail-image";

/**
 * Pure-geometry contract for the "smart" cover pipeline. The first release hard-
 * refused any image over 2MB ("Thumbnail is too large") — phone photos are
 * routinely 3–8MB, so the picker was unusable (owner-reported 2026-09-02). These
 * lock the fit-instead-of-refuse behavior at the decision level, since the
 * canvas glue itself has no vitest harness.
 */
describe("planThumbnailTransform", () => {
  it("center-crops a landscape image to a 9:16 reel's aspect", () => {
    // 4000×3000 photo onto a 1080×1920 reel (aspect 0.5625).
    const t = planThumbnailTransform(4000, 3000, 1080 / 1920);
    expect(t.cropped).toBe(true);
    expect(t.sh).toBe(3000); // full height kept
    expect(t.sw).toBe(Math.round(3000 * (1080 / 1920))); // 1688 — sides trimmed
    expect(t.sx).toBe(Math.round((4000 - t.sw) / 2)); // centered
    expect(t.sy).toBe(0);
    // Then scaled so the long edge fits THUMB_MAX_EDGE.
    expect(Math.max(t.outW, t.outH)).toBeLessThanOrEqual(THUMB_MAX_EDGE);
    expect(t.scaled).toBe(true);
    // Output keeps the video's aspect.
    expect(t.outW / t.outH).toBeCloseTo(1080 / 1920, 1);
  });

  it("crops top/bottom when the image is taller than the video", () => {
    const t = planThumbnailTransform(1080, 2400, 1080 / 1920);
    expect(t.cropped).toBe(true);
    expect(t.sw).toBe(1080);
    expect(t.sh).toBe(Math.round(1080 / (1080 / 1920))); // 1920
    expect(t.sy).toBe(Math.round((2400 - t.sh) / 2));
  });

  it("does not crop when the aspect already matches within tolerance", () => {
    // 1082×1920 vs 1080×1920 — a rounding-level difference must not cost a re-encode.
    const t = planThumbnailTransform(1082, 1920, 1080 / 1920);
    expect(t.cropped).toBe(false);
  });

  it("does not crop when the video aspect is unknown — resize only, never guess", () => {
    const t = planThumbnailTransform(6000, 4000, null);
    expect(t.cropped).toBe(false);
    expect(t.outW).toBe(THUMB_MAX_EDGE);
    expect(t.scaled).toBe(true);
  });

  it("never upscales a small image", () => {
    const t = planThumbnailTransform(800, 600, null);
    expect(t.outW).toBe(800);
    expect(t.outH).toBe(600);
    expect(t.scaled).toBe(false);
  });
});

describe("needsReencode", () => {
  const fits = planThumbnailTransform(1280, 720, null);

  it("passes a small JPEG through byte-identical (the pre-existing happy path)", () => {
    expect(needsReencode("image/jpeg", 500_000, fits)).toBe(false);
    expect(needsReencode("image/png", 500_000, fits)).toBe(false);
  });

  it("re-encodes anything over the 2MB YouTube cap instead of refusing it", () => {
    expect(needsReencode("image/jpeg", THUMB_MAX_BYTES + 1, fits)).toBe(true);
  });

  it("normalizes non-JPEG/PNG formats the platforms would reject at publish time", () => {
    // HEIC from an iPhone passed the old image/* guard, then died server-side
    // with an opaque allowlist error — the reported "different error".
    expect(needsReencode("image/heic", 500_000, fits)).toBe(true);
    expect(needsReencode("image/webp", 500_000, fits)).toBe(true);
  });

  it("re-encodes when a crop or scale is planned", () => {
    const cropped = planThumbnailTransform(4000, 3000, 9 / 16);
    expect(needsReencode("image/jpeg", 500_000, cropped)).toBe(true);
  });
});

describe("describeThumbAdjustment", () => {
  it("says nothing for an untouched image", () => {
    const t = planThumbnailTransform(1280, 720, null);
    expect(describeThumbAdjustment(t, false, 500_000)).toBeNull();
  });

  it("names the crop and resize so the user knows what happened", () => {
    const t = planThumbnailTransform(4000, 3000, 1080 / 1920);
    const note = describeThumbAdjustment(t, false, 1_400_000);
    expect(note).toMatch(/cropped to the video's aspect/);
    expect(note).toMatch(/resized to \d+×\d+/);
    expect(note).toMatch(/1\.3MB/);
  });
});