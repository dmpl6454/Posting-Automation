import { describe, it, expect } from "vitest";
import {
  tiktokProviderMetadata,
  videoDurationFromMedia,
  tiktokInheritedMetadata,
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

describe("tiktokInheritedMetadata", () => {
  it("drops the raw settings copy and the per-channel map, keeps the TARGET's checkpoint and everything else", () => {
    const post = { tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE" }, tiktokByChannel: {}, title: "t" };
    const target = { tiktokPublish: { publishId: "p" } };
    expect(tiktokInheritedMetadata(post, target)).toEqual({ tiktokPublish: { publishId: "p" }, title: "t" });
    // Pure: the inputs are not mutated.
    expect(post.tiktok).toBeDefined();
  });

  it("never takes a checkpoint, handle or video length from POST metadata (a client can write it there)", () => {
    // post.create's metadata is .passthrough(): a forged checkpoint there used to
    // be inherited by every TikTok target without one of its own — the provider
    // then RESUMED someone's earlier publish and marked this post PUBLISHED.
    const forged = {
      tiktokPublish: { publishId: "v_pub_url~v2-1.old", createdAt: "2026-10-01T00:00:00Z", source: "PULL_FROM_URL" },
      channelUsername: "someone.else",
      videoDurationSec: 1,
      title: "t",
    };
    expect(tiktokInheritedMetadata(forged, null)).toEqual({ title: "t" });
    // The target's own checkpoint (written only through onCheckpoint) still wins.
    expect(tiktokInheritedMetadata(forged, { tiktokPublish: { publishId: "real" } })).toEqual({
      title: "t",
      tiktokPublish: { publishId: "real" },
    });
  });

  it("drops a handle or video length on the TARGET too — only the worker supplies those", () => {
    expect(tiktokInheritedMetadata({}, { channelUsername: "x", videoDurationSec: 2, keep: 1 })).toEqual({ keep: 1 });
  });
});
