import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  isVideoWatermarkEnabled,
  planMetaVideoPrep,
  metaReadyObjectKey,
  META_READY_ARGS_VERSION,
  outputDurationAcceptable,
  planMetaReadyStorage,
  isReusableMetaReadyArtifact,
  META_READY_REUSE_MAX_AGE_MS,
} from "./meta-video-prep";

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("isVideoWatermarkEnabled — fail-CLOSED (owner decision 2026-09-16)", () => {
  it("is OFF when the key is unset — the default", () => {
    expect(isVideoWatermarkEnabled({})).toBe(false);
  });

  it("is OFF for an unplumbed compose key, which arrives as an empty string", () => {
    expect(isVideoWatermarkEnabled({ VIDEO_WATERMARK_ENABLED: "" })).toBe(false);
  });

  it("is OFF for anything but the exact string \"true\"", () => {
    expect(isVideoWatermarkEnabled({ VIDEO_WATERMARK_ENABLED: "false" })).toBe(false);
    expect(isVideoWatermarkEnabled({ VIDEO_WATERMARK_ENABLED: "TRUE" })).toBe(false);
    expect(isVideoWatermarkEnabled({ VIDEO_WATERMARK_ENABLED: "1" })).toBe(false);
    expect(isVideoWatermarkEnabled({ VIDEO_WATERMARK_ENABLED: " true" })).toBe(false);
  });

  it("is ON only for \"true\"", () => {
    expect(isVideoWatermarkEnabled({ VIDEO_WATERMARK_ENABLED: "true" })).toBe(true);
  });

  it("reads process.env by default", () => {
    const prev = process.env.VIDEO_WATERMARK_ENABLED;
    try {
      delete process.env.VIDEO_WATERMARK_ENABLED;
      expect(isVideoWatermarkEnabled()).toBe(false);
      process.env.VIDEO_WATERMARK_ENABLED = "true";
      expect(isVideoWatermarkEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VIDEO_WATERMARK_ENABLED;
      else process.env.VIDEO_WATERMARK_ENABLED = prev;
    }
  });
});

describe("planMetaVideoPrep", () => {
  const base = {
    watermarkOn: false,
    hasOverlayText: false,
    publishesAsStory: false,
    isRendition: false,
    tooBig: false,
  };

  it("a plain rendition is published as-is — zero encode", () => {
    expect(planMetaVideoPrep({ ...base, isRendition: true })).toBe("skip-rendition");
  });

  it("an original (no rendition) is normalized once, shared across the fan-out", () => {
    expect(planMetaVideoPrep(base)).toBe("normalize");
  });

  it("a STORY rendition is still encoded — the 9:16 canvas rides inside the encode", () => {
    expect(planMetaVideoPrep({ ...base, isRendition: true, publishesAsStory: true })).toBe("normalize");
    expect(planMetaVideoPrep({ ...base, publishesAsStory: true })).toBe("normalize");
  });

  it("a rendition with burned-in text is still encoded — the rendition has no text", () => {
    expect(planMetaVideoPrep({ ...base, isRendition: true, hasOverlayText: true })).toBe("normalize");
  });

  it("the watermark switch restores the legacy per-target path for every other case", () => {
    expect(planMetaVideoPrep({ ...base, watermarkOn: true })).toBe("watermark");
    expect(planMetaVideoPrep({ ...base, watermarkOn: true, isRendition: true })).toBe("watermark");
    expect(planMetaVideoPrep({ ...base, watermarkOn: true, publishesAsStory: true })).toBe("watermark");
    expect(planMetaVideoPrep({ ...base, watermarkOn: true, hasOverlayText: true })).toBe("watermark");
  });

  it("the size cap outranks everything — a multi-GB re-encode must never run", () => {
    expect(planMetaVideoPrep({ ...base, tooBig: true })).toBe("skip-too-big");
    expect(planMetaVideoPrep({ ...base, tooBig: true, watermarkOn: true })).toBe("skip-too-big");
    expect(planMetaVideoPrep({ ...base, tooBig: true, publishesAsStory: true })).toBe("skip-too-big");
    expect(planMetaVideoPrep({ ...base, tooBig: true, isRendition: true, hasOverlayText: true })).toBe(
      "skip-too-big"
    );
  });

  it("covers the full input matrix with no unexpected plan", () => {
    const bools = [false, true];
    for (const watermarkOn of bools)
      for (const hasOverlayText of bools)
        for (const publishesAsStory of bools)
          for (const isRendition of bools)
            for (const tooBig of bools) {
              const plan = planMetaVideoPrep({ watermarkOn, hasOverlayText, publishesAsStory, isRendition, tooBig });
              if (tooBig) expect(plan).toBe("skip-too-big");
              else if (watermarkOn) expect(plan).toBe("watermark");
              else if (isRendition && !hasOverlayText && !publishesAsStory) expect(plan).toBe("skip-rendition");
              else expect(plan).toBe("normalize");
              // A story is never published without going through an encode
              // unless the size cap forbids it.
              if (publishesAsStory && !tooBig) expect(plan).not.toBe("skip-rendition");
            }
  });
});

describe("metaReadyObjectKey", () => {
  const input = {
    sourceUrl: "https://media.example.com/optimized/org_1/med_1.mp4",
    storyCanvas: false,
  };

  it("is deterministic, so one encode serves the whole fan-out and every retry", () => {
    expect(metaReadyObjectKey(input, sha256hex)).toBe(metaReadyObjectKey({ ...input }, sha256hex));
  });

  it("has the documented shape: metaready prefix, 40 hex chars, .mp4 (the provider sniffs the extension)", () => {
    expect(metaReadyObjectKey(input, sha256hex)).toMatch(/^videos\/metaready\/[0-9a-f]{40}\.mp4$/);
  });

  it("never reuses the per-target overlay prefix", () => {
    expect(metaReadyObjectKey(input, sha256hex).startsWith("videos/overlay_")).toBe(false);
  });

  it("changes with every input that changes the output", () => {
    const k = metaReadyObjectKey(input, sha256hex);
    expect(metaReadyObjectKey({ ...input, sourceUrl: input.sourceUrl + "?x" }, sha256hex)).not.toBe(k);
    expect(metaReadyObjectKey({ ...input, storyCanvas: true }, sha256hex)).not.toBe(k);
    expect(metaReadyObjectKey({ ...input, text: "hi" }, sha256hex)).not.toBe(k);
    const withText = metaReadyObjectKey({ ...input, text: "hi" }, sha256hex);
    expect(metaReadyObjectKey({ ...input, text: "hi", textPosition: "top" }, sha256hex)).not.toBe(withText);
    expect(metaReadyObjectKey({ ...input, text: "hi", textFontSize: 60 }, sha256hex)).not.toBe(withText);
  });

  it("treats undefined and empty text identically — they render the same encode", () => {
    expect(metaReadyObjectKey({ ...input, text: "" }, sha256hex)).toBe(metaReadyObjectKey(input, sha256hex));
    expect(metaReadyObjectKey({ ...input, textPosition: "" }, sha256hex)).toBe(metaReadyObjectKey(input, sha256hex));
  });

  it("hashes a canonical JSON that carries the args version", () => {
    let seen = "";
    metaReadyObjectKey({ ...input, text: "a", textPosition: "bottom", textFontSize: 42 }, (s) => {
      seen = s;
      return "f".repeat(64);
    });
    expect(JSON.parse(seen)).toEqual({
      v: META_READY_ARGS_VERSION,
      sourceUrl: input.sourceUrl,
      text: "a",
      textPosition: "bottom",
      textFontSize: 42,
      storyCanvas: false,
    });
    // Fixed key order — a reordered object literal must not produce a new key.
    expect(Object.keys(JSON.parse(seen))).toEqual([
      "v",
      "sourceUrl",
      "text",
      "textPosition",
      "textFontSize",
      "storyCanvas",
    ]);
  });

  it("truncates the digest to 40 characters", () => {
    expect(metaReadyObjectKey(input, () => "a".repeat(64))).toBe(`videos/metaready/${"a".repeat(40)}.mp4`);
  });
});

describe("outputDurationAcceptable — the 98% truncation rule", () => {
  it("accepts an output of equal or greater length", () => {
    expect(outputDurationAcceptable(60, 60)).toBe(true);
    expect(outputDurationAcceptable(60, 60.05)).toBe(true);
  });

  it("accepts exactly 98%", () => {
    expect(outputDurationAcceptable(100, 98)).toBe(true);
  });

  it("rejects anything under 98% — the 2026-07-21 63s→40s truncation", () => {
    expect(outputDurationAcceptable(100, 97.9)).toBe(false);
    expect(outputDurationAcceptable(63, 40)).toBe(false);
  });

  it("rejects non-finite or non-positive inputs", () => {
    expect(outputDurationAcceptable(NaN, 10)).toBe(false);
    expect(outputDurationAcceptable(10, NaN)).toBe(false);
    expect(outputDurationAcceptable(Infinity, 10)).toBe(false);
    expect(outputDurationAcceptable(10, Infinity)).toBe(false);
    expect(outputDurationAcceptable(0, 0)).toBe(false);
    expect(outputDurationAcceptable(-5, 10)).toBe(false);
  });
});

describe("planMetaReadyStorage", () => {
  it("caches only a VERIFIED output", () => {
    expect(planMetaReadyStorage(10, 10)).toBe("cache");
  });

  it("rejects a short or unmeasurable output when the input length is known", () => {
    expect(planMetaReadyStorage(10, 5)).toBe("reject");
    expect(planMetaReadyStorage(10, NaN)).toBe("reject");
  });

  it("never caches when the input length is unknown — the output cannot be verified", () => {
    expect(planMetaReadyStorage(NaN, 10)).toBe("uncached");
    expect(planMetaReadyStorage(NaN, NaN)).toBe("uncached");
    expect(planMetaReadyStorage(0, 10)).toBe("uncached");
  });
});

describe("isReusableMetaReadyArtifact — never hand out a copy the lifecycle rule may delete", () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(now - ms);

  it("keeps a clear margin below the 7-day videos/metaready/ expiry rule", () => {
    expect(META_READY_REUSE_MAX_AGE_MS).toBeLessThanOrEqual(5 * DAY);
  });

  it("a fresh, non-empty artifact is a hit", () => {
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: ago(60_000), now })).toBe(true);
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: ago(4 * DAY), now })).toBe(true);
  });

  it("an artifact at or past the reuse age is a miss (it gets re-encoded, which resets its age)", () => {
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: ago(META_READY_REUSE_MAX_AGE_MS), now })).toBe(false);
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: ago(6 * DAY), now })).toBe(false);
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: ago(30 * DAY), now })).toBe(false);
  });

  it("empty or unknown-size objects are misses", () => {
    expect(isReusableMetaReadyArtifact({ contentLength: 0, lastModified: ago(1000), now })).toBe(false);
    expect(isReusableMetaReadyArtifact({ contentLength: undefined, lastModified: ago(1000), now })).toBe(false);
  });

  it("an unknown or invalid modification time is a miss (unverifiable)", () => {
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: undefined, now })).toBe(false);
    expect(isReusableMetaReadyArtifact({ contentLength: 10, lastModified: new Date("nope"), now })).toBe(false);
  });
});
