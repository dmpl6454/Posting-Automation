import { describe, it, expect } from "vitest";
import {
  normalizeStoryMentions,
  validateStoryPost,
  storyInputSchema,
  isStoryModeMetadata,
  sanitizeFormatByChannelId,
  formatForReplacedTarget,
  STORY_MAX_MENTIONS,
} from "../lib/instagram-story";

describe("normalizeStoryMentions", () => {
  it("strips @, trims, dedupes case-insensitively and keeps order", () => {
    expect(normalizeStoryMentions([" @NatGeo ", "natgeo", "nasa"])).toEqual({
      mentions: ["NatGeo", "nasa"],
      invalid: [],
    });
  });

  it("NAMES every invalid username instead of silently dropping it", () => {
    expect(normalizeStoryMentions(["ok", "not ok", "bad-dash", "a".repeat(31)])).toEqual({
      mentions: ["ok"],
      invalid: ["not ok", "bad-dash", "a".repeat(31)],
    });
  });

  it("reports the overflow past STORY_MAX_MENTIONS rather than truncating quietly", () => {
    const many = Array.from({ length: STORY_MAX_MENTIONS + 1 }, (_, i) => `u${i}`);
    const r = normalizeStoryMentions(many);
    expect(r.mentions).toHaveLength(STORY_MAX_MENTIONS);
    expect(r.invalid).toEqual([`u${STORY_MAX_MENTIONS}`]);
  });

  it("ignores blank entries", () => {
    expect(normalizeStoryMentions(["", "  ", "ok"])).toEqual({ mentions: ["ok"], invalid: [] });
  });
});

describe("validateStoryPost", () => {
  const ig = (id: string) => ({ id, platform: "INSTAGRAM", name: `ig-${id}` });

  it("accepts one media to one or many Instagram channels", () => {
    expect(validateStoryPost({ channels: [ig("a"), ig("b")], mediaCount: 1, scheduling: true })).toBeNull();
  });

  it("names the offending non-Instagram channels", () => {
    const err = validateStoryPost({
      channels: [ig("a"), { id: "f", platform: "FACEBOOK", name: "My Page" }],
      mediaCount: 1,
      scheduling: true,
    });
    expect(err).toMatch(/Instagram/);
    expect(err).toContain("My Page");
  });

  it("requires exactly one media to publish, and never two even as a draft", () => {
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 0, scheduling: true })).toMatch(/one image or video/);
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 2, scheduling: true })).toMatch(/exactly one/);
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 2, scheduling: false })).toMatch(/exactly one/);
    // A media-less DRAFT is fine — the user attaches later.
    expect(validateStoryPost({ channels: [ig("a")], mediaCount: 0, scheduling: false })).toBeNull();
  });

  it("allows a channel-less story draft", () => {
    expect(validateStoryPost({ channels: [], mediaCount: 1, scheduling: false })).toBeNull();
  });
});

describe("storyInputSchema", () => {
  it("defaults mentions to [] and bounds the raw input", () => {
    expect(storyInputSchema.parse({})).toEqual({ mentions: [] });
    expect(storyInputSchema.safeParse({ mentions: Array.from({ length: 51 }, () => "u") }).success).toBe(false);
    expect(storyInputSchema.safeParse({ mentions: ["x".repeat(65)] }).success).toBe(false);
  });
});

describe("isStoryModeMetadata", () => {
  it("is true only for the object marker post.create writes", () => {
    expect(isStoryModeMetadata({ instagramStory: { mentions: [] } })).toBe(true);
    expect(isStoryModeMetadata({ instagramStory: [] })).toBe(false);
    expect(isStoryModeMetadata({ instagramStory: "x" })).toBe(false);
    expect(isStoryModeMetadata({})).toBe(false);
    expect(isStoryModeMetadata(null)).toBe(false);
  });
});

describe("sanitizeFormatByChannelId", () => {
  const channels = [
    { id: "ig", platform: "INSTAGRAM" },
    { id: "yt", platform: "YOUTUBE" },
    { id: "fb", platform: "FACEBOOK" },
  ];

  it("keeps a valid video format when a video IS attached", () => {
    expect(sanitizeFormatByChannelId({ ig: "REEL", yt: "SHORT" }, channels, true)).toEqual({
      ig: "REEL",
      yt: "SHORT",
    });
  });

  it("drops a STALE picker value when no video is attached — the image-story trap", () => {
    // attach video → pick Story → remove video → attach image → publish.
    // Before Instagram stories this was inert; now it would publish a story.
    expect(sanitizeFormatByChannelId({ ig: "STORY" }, channels, false)).toBeUndefined();
    expect(sanitizeFormatByChannelId({ ig: "REEL", yt: "VIDEO" }, channels, false)).toBeUndefined();
  });

  it("drops a format whose platform cannot understand it", () => {
    expect(sanitizeFormatByChannelId({ fb: "STORY", yt: "REEL", ig: "SHORT" }, channels, true)).toBeUndefined();
  });

  it("drops entries for channels this post does not target", () => {
    expect(sanitizeFormatByChannelId({ ghost: "REEL", ig: "REEL" }, channels, true)).toEqual({ ig: "REEL" });
  });

  it("keeps non-video formats regardless of attachments", () => {
    expect(sanitizeFormatByChannelId({ ig: "CAROUSEL" }, channels, false)).toEqual({ ig: "CAROUSEL" });
  });

  it("passes undefined through untouched", () => {
    expect(sanitizeFormatByChannelId(undefined, channels, true)).toBeUndefined();
  });
});

describe("formatForReplacedTarget", () => {
  const existing = [
    { channelId: "a", format: "STORY" },
    { channelId: "b", format: null },
    { channelId: "c", format: "REEL" },
  ];

  it("CARRIES a kept channel's existing format — dropping it turned stories into reels", () => {
    // post.update recreated targets with channelId+status only, so adding one
    // channel from the post detail page silently re-published a Story as a REEL.
    expect(formatForReplacedTarget("a", existing, false)).toBe("STORY");
    expect(formatForReplacedTarget("c", existing, false)).toBe("REEL");
  });

  it("gives a NEW channel STORY on a story post, and nothing otherwise", () => {
    expect(formatForReplacedTarget("new", existing, true)).toBe("STORY");
    expect(formatForReplacedTarget("new", existing, false)).toBeNull();
  });

  it("repairs a kept channel that lost its format on an earlier edit of a story post", () => {
    expect(formatForReplacedTarget("b", existing, true)).toBe("STORY");
    expect(formatForReplacedTarget("b", existing, false)).toBeNull();
  });
});
