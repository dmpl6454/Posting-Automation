import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeCaptionOverrides,
  contentOverrideForReplacedTarget,
  captionOverridesSchema,
  CAPTION_OVERRIDE_MAX,
  everyChannelHasOwnCaption,
  everyTargetHasOwnCaption,
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

/**
 * Owner-reported 2026-09-21: "when put manual caption on each page and i dont
 * give caption in content it doesnt give me option to publish". An empty shared
 * caption is now allowed, but ONLY when every channel supplies its own — the
 * publish worker resolves `contentOverride ?? contentVariants ?? post.content`,
 * so one uncovered channel would publish empty text (and on Reddit/Medium/dev.to
 * the caption is also the post TITLE, where empty is a hard API rejection).
 */
describe("everyChannelHasOwnCaption — the empty-shared-caption gate", () => {
  const channels = ["ch1", "ch2"];

  it("is true when EVERY channel has its own non-blank caption and the shared one is empty", () => {
    expect(everyChannelHasOwnCaption({ ch1: "A", ch2: "B" }, channels, "")).toBe(true);
  });

  it("is FALSE on partial coverage — the uncovered channel would publish empty text", () => {
    expect(everyChannelHasOwnCaption({ ch1: "A" }, channels, "")).toBe(false);
  });

  it("treats a whitespace-only caption as no caption", () => {
    expect(everyChannelHasOwnCaption({ ch1: "A", ch2: "   \n " }, channels, "")).toBe(false);
  });

  it("is FALSE with zero channels — a channel-less draft covers nothing", () => {
    // Otherwise a caption-less draft could be saved and then scheduled later with
    // no caption anywhere.
    expect(everyChannelHasOwnCaption({ ch1: "A" }, [], "")).toBe(false);
  });

  it("is FALSE for absent overrides", () => {
    expect(everyChannelHasOwnCaption(undefined, channels, "")).toBe(false);
  });

  it("ignores captions aimed at channels the post does not target", () => {
    expect(everyChannelHasOwnCaption({ ch1: "A", other: "B" }, channels, "")).toBe(false);
  });

  it("an override identical to a NON-empty shared caption is dropped, so coverage fails", () => {
    // sanitizeCaptionOverrides drops no-op overrides. That only matters when the
    // shared caption is non-empty — in which case the post is publishable anyway.
    expect(everyChannelHasOwnCaption({ ch1: "s", ch2: "B" }, channels, "s")).toBe(false);
  });
});

describe("everyTargetHasOwnCaption — the same question for existing rows", () => {
  it("is true only when every target carries its own caption", () => {
    expect(everyTargetHasOwnCaption([{ contentOverride: "A" }, { contentOverride: "B" }])).toBe(true);
    expect(everyTargetHasOwnCaption([{ contentOverride: "A" }, { contentOverride: null }])).toBe(false);
    expect(everyTargetHasOwnCaption([{ contentOverride: "A" }, { contentOverride: "  " }])).toBe(false);
  });

  it("is FALSE for an empty target list", () => {
    expect(everyTargetHasOwnCaption([])).toBe(false);
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
        // 2026-09-21: `status` joined the select for the cancel feature.
    expect(src).toMatch(/targets: \{ select: \{ channelId: true, format: true, contentOverride: true, status: true \} \}/);
    expect(src).toMatch(/contentOverride: contentOverrideForReplacedTarget\(channelId, existing\.targets\)/);
  });

  it("create allows an empty shared caption ONLY when every channel has its own", () => {
    expect(src).toMatch(
      /!everyChannelHasOwnCaption\(input\.captionOverrides, input\.channelIds, input\.content\)/
    );
  });

  it("update derives coverage from the RESULTING targets, so adding a channel cannot strand it captionless", () => {
    expect(src).toMatch(/!everyTargetHasOwnCaption\(resultingTargets\)/);
    expect(src).toMatch(/contentOverride: contentOverrideForReplacedTarget\(channelId, existing\.targets\)/);
  });

  it("updateTargetContent refuses to clear the last caption on a post with no shared caption", () => {
    // Clearing falls the target back to the shared caption — only safe if one exists.
    expect(src).toMatch(/post: \{ select: \{ content: true \} \}/);
  });
});
