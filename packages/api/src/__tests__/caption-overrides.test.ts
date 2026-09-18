import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeCaptionOverrides,
  contentOverrideForReplacedTarget,
  captionOverridesSchema,
  CAPTION_OVERRIDE_MAX,
} from "../lib/caption-overrides";

/**
 * Manual per-channel captions from Compose (2026-09-18). The pure helpers are
 * tested directly; the router wiring is asserted at the SOURCE level (house
 * pattern — see video-thumbnail-post-create.test.ts) because what must not regress
 * is that the sanitiser runs and that an unused feature writes the pre-feature row.
 */

describe("sanitizeCaptionOverrides", () => {
  const channels = ["ch1", "ch2", "ch3"];

  it("returns undefined for absent input — the byte-identical path", () => {
    expect(sanitizeCaptionOverrides(undefined, channels, "shared")).toBeUndefined();
  });

  it("returns undefined when nothing survives, never an empty object", () => {
    expect(sanitizeCaptionOverrides({ ch1: "   ", ch2: "" }, channels, "shared")).toBeUndefined();
  });

  it("drops captions for channels the post does not target", () => {
    expect(sanitizeCaptionOverrides({ ch1: "A", other: "B" }, channels, "shared")).toEqual({ ch1: "A" });
  });

  it("drops a caption identical to the shared one (a no-op override)", () => {
    // Storing it would show a fake "custom" badge and block a later shared-caption
    // edit from reaching that channel.
    expect(sanitizeCaptionOverrides({ ch1: "shared", ch2: " shared \n" }, channels, "shared")).toBeUndefined();
  });

  it("keeps a differing caption VERBATIM (no trimming of the stored value)", () => {
    const caption = "Line one\n\nLine two 😍 ";
    expect(sanitizeCaptionOverrides({ ch2: caption }, channels, "shared")).toEqual({ ch2: caption });
  });

  it("ignores non-string values from a malformed client map", () => {
    expect(sanitizeCaptionOverrides({ ch1: 42 as any, ch2: "ok" }, channels, "shared")).toEqual({ ch2: "ok" });
  });

  it("schema caps each caption at the same ceiling as post.updateTargetContent", () => {
    expect(CAPTION_OVERRIDE_MAX).toBe(100_000);
    expect(captionOverridesSchema.safeParse({ a: "x".repeat(CAPTION_OVERRIDE_MAX) }).success).toBe(true);
    expect(captionOverridesSchema.safeParse({ a: "x".repeat(CAPTION_OVERRIDE_MAX + 1) }).success).toBe(false);
  });
});

describe("contentOverrideForReplacedTarget", () => {
  const existing = [
    { channelId: "kept", contentOverride: "Custom for kept" },
    { channelId: "plain", contentOverride: null },
  ];

  it("a kept channel keeps its per-channel caption", () => {
    expect(contentOverrideForReplacedTarget("kept", existing)).toBe("Custom for kept");
  });

  it("a kept channel without one stays on the shared caption", () => {
    expect(contentOverrideForReplacedTarget("plain", existing)).toBeNull();
  });

  it("a NEW channel starts on the shared caption", () => {
    expect(contentOverrideForReplacedTarget("new", existing)).toBeNull();
  });
});

describe("post.router wiring (source-level contract)", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..");
  const src = readFileSync(join(ROOT, "packages/api/src/routers/post.router.ts"), "utf8");

  it("post.create accepts captionOverrides through the shared schema", () => {
    expect(src).toMatch(/captionOverrides: captionOverridesSchema\.optional\(\)/);
  });

  it("runs the sanitiser against the post's OWN channelIds and shared content, never for a story", () => {
    expect(src).toMatch(
      /const overrides = isStory\s*\?\s*undefined\s*:\s*sanitizeCaptionOverrides\(input\.captionOverrides, input\.channelIds, input\.content\)/
    );
  });

  it("spreads contentOverride into a target ONLY when present — an unused feature writes the pre-feature row", () => {
    expect(src).toMatch(/\.\.\.\(overrides\?\.\[channelId\] \? \{ contentOverride: overrides\[channelId\] \} : \{\}\)/);
  });

  it("post.update selects contentOverride and carries it through channel replacement", () => {
    // Without this, adding one channel on the post page wiped every per-channel
    // caption (AI-generated and hand-written alike).
    expect(src).toMatch(/targets: \{ select: \{ channelId: true, format: true, contentOverride: true \} \}/);
    expect(src).toMatch(/contentOverride: contentOverrideForReplacedTarget\(channelId, existing\.targets\)/);
  });
});
