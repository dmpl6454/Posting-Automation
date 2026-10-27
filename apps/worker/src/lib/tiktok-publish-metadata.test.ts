import { describe, it, expect } from "vitest";
import {
  tiktokProviderMetadata,
  videoDurationFromMedia,
  withoutInheritedTikTokKeys,
} from "./tiktok-publish-metadata";

const SETTINGS = {
  privacyLevel: "SELF_ONLY",
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  brandOrganic: false,
  brandContent: false,
  isAigc: false,
};

describe("videoDurationFromMedia", () => {
  it("prefers the probe's exact durationSec, then the rounded column, from the first VIDEO", () => {
    expect(
      videoDurationFromMedia([
        { fileType: "image/jpeg", duration: 99 },
        { fileType: "video/mp4", duration: 13, metadata: { optimize: { probe: { durationSec: 12.6 } } } },
      ])
    ).toBe(12.6);
    expect(videoDurationFromMedia([{ fileType: "video/quicktime", duration: 13, metadata: { optimize: { status: "pending" } } }])).toBe(13);
  });

  it("is null when nothing is known, or for junk values", () => {
    expect(videoDurationFromMedia([])).toBeNull();
    expect(videoDurationFromMedia([{ fileType: "image/png", duration: 5 }])).toBeNull();
    expect(videoDurationFromMedia([{ fileType: "video/mp4", duration: null, metadata: null }])).toBeNull();
    expect(videoDurationFromMedia([{ fileType: "video/mp4", duration: 0, metadata: { optimize: { probe: { durationSec: "x" } } } }])).toBeNull();
    expect(videoDurationFromMedia([{ fileType: "video/mp4", metadata: { optimize: { probe: { durationSec: -4 } } } }])).toBeNull();
  });
});

describe("tiktokProviderMetadata", () => {
  it("reads this channel's block only, and omits every unknown key", () => {
    const postMetadata = { tiktokByChannel: { a: SETTINGS, b: { ...SETTINGS, privacyLevel: "PUBLIC_TO_EVERYONE" } } };
    expect(tiktokProviderMetadata({ postMetadata, channelId: "a", channelUsername: "creator.one", media: [] })).toEqual({
      tiktok: SETTINGS,
      channelUsername: "creator.one",
    });
    expect(tiktokProviderMetadata({ postMetadata, channelId: "zzz", channelUsername: "", media: [] })).toEqual({});
    // An inherited-from-prototype name must not resolve to anything.
    expect(tiktokProviderMetadata({ postMetadata, channelId: "__proto__", channelUsername: null, media: [] })).toEqual({});
  });
});

describe("withoutInheritedTikTokKeys", () => {
  it("drops the raw settings copy and the per-channel map, keeps the checkpoint and everything else", () => {
    const spread = { tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE" }, tiktokByChannel: {}, tiktokPublish: { publishId: "p" }, title: "t" };
    expect(withoutInheritedTikTokKeys(spread)).toEqual({ tiktokPublish: { publishId: "p" }, title: "t" });
    // Pure: the input is not mutated.
    expect(spread.tiktok).toBeDefined();
  });
});
