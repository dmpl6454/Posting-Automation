import { describe, it, expect } from "vitest";
import { buildPublishTokens, publishIdempotencyKey, CHANNEL_ROUTED_PLATFORMS } from "./publish-tokens";

describe("buildPublishTokens", () => {
  const meta = { instance: "https://hachyderm.io", kind: "self-hosted", siteUrl: "https://b.example" };

  it.each(["MASTODON", "WORDPRESS", "DISCORD"])("%s receives the channel's own metadata", (platform) => {
    expect(buildPublishTokens(platform, "a", "r", meta)).toEqual({ accessToken: "a", refreshToken: "r", metadata: meta });
  });

  it.each(["FACEBOOK", "INSTAGRAM", "YOUTUBE", "TWITTER", "LINKEDIN", "BLUESKY", "TELEGRAM"])(
    "%s receives exactly { accessToken, refreshToken }, as before",
    (platform) => {
      const t = buildPublishTokens(platform, "a", undefined, meta);
      expect(Object.keys(t)).toEqual(["accessToken", "refreshToken"]);
      expect(t).toEqual({ accessToken: "a", refreshToken: undefined });
    },
  );

  it("no usable metadata means no metadata key", () => {
    for (const m of [null, undefined, "x", ["a"]]) {
      expect("metadata" in buildPublishTokens("MASTODON", "a", "r", m)).toBe(false);
    }
  });

  it("covers exactly the three channel-routed platforms", () => {
    expect([...CHANNEL_ROUTED_PLATFORMS].sort()).toEqual(["DISCORD", "MASTODON", "WORDPRESS"]);
  });
});

describe("publishIdempotencyKey", () => {
  it("is stable for the same target and content, and differs when either changes", () => {
    const k = publishIdempotencyKey("MASTODON", "t1", "hello", ["u1"]);
    expect(k).toMatch(/^pa-t1-[0-9a-f]{16}$/);
    expect(publishIdempotencyKey("MASTODON", "t1", "hello", ["u1"])).toBe(k);
    expect(publishIdempotencyKey("MASTODON", "t1", "hello!", ["u1"])).not.toBe(k);
    expect(publishIdempotencyKey("MASTODON", "t1", "hello", ["u2"])).not.toBe(k);
    expect(publishIdempotencyKey("MASTODON", "t2", "hello", ["u1"])).not.toBe(k);
  });

  it("is only for Mastodon", () => {
    expect(publishIdempotencyKey("WORDPRESS", "t1", "x", [])).toBeUndefined();
    expect(publishIdempotencyKey("INSTAGRAM", "t1", "x", [])).toBeUndefined();
  });
});
