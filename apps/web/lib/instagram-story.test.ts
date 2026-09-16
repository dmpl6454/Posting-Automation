import { describe, it, expect } from "vitest";
import {
  isInstagramChannel,
  storySelectableChannels,
  pruneSelectionForStory,
  groupSelectableIds,
  addMentions,
  sanitizeRestoredMentions,
  storyBlockReason,
  STORY_MAX_MENTIONS,
} from "./instagram-story";

const ch = (id: string, platform: string, isActive = true) => ({ id, platform, isActive });

describe("storySelectableChannels / pruneSelectionForStory", () => {
  const channels = [ch("ig1", "INSTAGRAM"), ch("fb1", "FACEBOOK"), ch("ig2", "INSTAGRAM"), ch("yt", "YOUTUBE")];

  it("Post mode returns every channel untouched; Story mode keeps Instagram AND Facebook", () => {
    // 2026-09-16: Facebook Page stories are publishable, so they are selectable.
    expect(storySelectableChannels(channels, "post")).toEqual(channels);
    expect(storySelectableChannels(channels, "story").map((c) => c.id)).toEqual(["ig1", "fb1", "ig2"]);
    expect(storySelectableChannels(undefined, "story")).toEqual([]);
    expect(isInstagramChannel(ch("x", "INSTAGRAM"))).toBe(true);
  });

  it("prunes platforms with no story surface, and unknown ids, reporting how many went", () => {
    expect(pruneSelectionForStory(["ig1", "fb1", "yt", "ghost"], channels)).toEqual({
      next: ["ig1", "fb1"],
      removed: 2,
    });
  });

  it("is a no-op when every selected channel can take a story", () => {
    expect(pruneSelectionForStory(["ig1", "ig2"], channels)).toEqual({ next: ["ig1", "ig2"], removed: 0 });
    expect(pruneSelectionForStory(["ig1", "fb1"], channels)).toEqual({ next: ["ig1", "fb1"], removed: 0 });
  });
});

describe("groupSelectableIds", () => {
  const live = new Set(["ig1", "fb1", "ig2"]);
  const group = {
    channels: [ch("ig1", "INSTAGRAM"), ch("fb1", "FACEBOOK"), ch("ig2", "INSTAGRAM", false), ch("gone", "INSTAGRAM")],
  };

  it("Post mode: active members still in the live list, any platform (today's rule)", () => {
    expect(groupSelectableIds(group, live, "post")).toEqual(["ig1", "fb1"]);
  });

  it("Story mode: ONLY active, live story-capable members (Instagram and Facebook)", () => {
    // One click must never pull a YouTube or X channel into a story.
    expect(groupSelectableIds(group, live, "story")).toEqual(["ig1", "fb1"]);
  });

  it("Story mode yields nothing for a group whose members have no story surface", () => {
    expect(groupSelectableIds({ channels: [ch("yt1", "YOUTUBE")] }, new Set(["yt1"]), "story")).toEqual([]);
    expect(groupSelectableIds({}, live, "story")).toEqual([]);
  });
});

describe("addMentions", () => {
  it("splits on commas and whitespace, strips @, dedupes, names invalid entries", () => {
    expect(addMentions(["natgeo"], "@nasa, NATGEO spacex bad-name")).toEqual({
      mentions: ["natgeo", "nasa", "spacex"],
      invalid: ["bad-name"],
      dropped: 0,
    });
  });

  it("caps at STORY_MAX_MENTIONS and counts the overflow", () => {
    const existing = Array.from({ length: STORY_MAX_MENTIONS - 1 }, (_, i) => `u${i}`);
    const r = addMentions(existing, "a b c");
    expect(r.mentions).toHaveLength(STORY_MAX_MENTIONS);
    expect(r.dropped).toBe(2);
  });

  it("empty input is a no-op", () => {
    expect(addMentions(["x"], "   ")).toEqual({ mentions: ["x"], invalid: [], dropped: 0 });
  });
});

describe("sanitizeRestoredMentions", () => {
  it("drops anything a persisted draft should not be trusted with", () => {
    // One bad username reaching post.create rejects the ENTIRE post.
    expect(sanitizeRestoredMentions(["ok", "bad name", 42, null, "@fine"])).toEqual(["ok", "fine"]);
    expect(sanitizeRestoredMentions("natgeo")).toEqual([]);
    expect(sanitizeRestoredMentions(undefined)).toEqual([]);
  });
});

describe("storyBlockReason", () => {
  it("names the one thing standing in the way", () => {
    expect(storyBlockReason({ mediaCount: 0, selectedCount: 1, uploading: false })).toMatch(/one image or video/);
    expect(storyBlockReason({ mediaCount: 2, selectedCount: 1, uploading: false })).toMatch(/remove 1 attachment/);
    expect(storyBlockReason({ mediaCount: 3, selectedCount: 1, uploading: false })).toMatch(/remove 2 attachments/);
    expect(storyBlockReason({ mediaCount: 1, selectedCount: 0, uploading: false })).toMatch(
      /Instagram or Facebook channel/
    );
    expect(storyBlockReason({ mediaCount: 1, selectedCount: 1, uploading: true })).toMatch(/uploading/);
  });

  it("returns null when the story is ready", () => {
    expect(storyBlockReason({ mediaCount: 1, selectedCount: 1, uploading: false })).toBeNull();
  });

  it("reports the upload first — it is the one that resolves by itself", () => {
    expect(storyBlockReason({ mediaCount: 0, selectedCount: 0, uploading: true })).toMatch(/uploading/);
  });
});
