import { describe, it, expect } from "vitest";
import { getSocialProvider, getSupportedPlatforms } from "../abstract/social.factory";
import { TwitterProvider } from "../providers/twitter.provider";
import { LinkedInProvider } from "../providers/linkedin.provider";
import { FacebookProvider } from "../providers/facebook.provider";
import { InstagramProvider } from "../providers/instagram.provider";
import { RedditProvider } from "../providers/reddit.provider";
import { YouTubeProvider } from "../providers/youtube.provider";
import { TikTokProvider } from "../providers/tiktok.provider";
import { PinterestProvider } from "../providers/pinterest.provider";
import { ThreadsProvider } from "../providers/threads.provider";
import { TelegramProvider } from "../providers/telegram.provider";
import { DiscordProvider } from "../providers/discord.provider";
import { SlackProvider } from "../providers/slack.provider";
import { MastodonProvider } from "../providers/mastodon.provider";
import { BlueskyProvider } from "../providers/bluesky.provider";
import { MediumProvider } from "../providers/medium.provider";
import { DevtoProvider } from "../providers/devto.provider";

// All 16 platforms with their expected class, displayName, and key constraint values
const platformExpectations = [
  {
    platform: "TWITTER" as const,
    ProviderClass: TwitterProvider,
    displayName: "Twitter / X",
    maxContentLength: 280,
    maxMediaCount: 4,
  },
  {
    platform: "LINKEDIN" as const,
    ProviderClass: LinkedInProvider,
    displayName: "LinkedIn",
    maxContentLength: 3000,
    maxMediaCount: 20,
  },
  {
    platform: "FACEBOOK" as const,
    ProviderClass: FacebookProvider,
    displayName: "Facebook",
    maxContentLength: 63206,
    maxMediaCount: 10,
  },
  {
    platform: "INSTAGRAM" as const,
    ProviderClass: InstagramProvider,
    displayName: "Instagram",
    maxContentLength: 2200,
    maxMediaCount: 10,
  },
  {
    platform: "REDDIT" as const,
    ProviderClass: RedditProvider,
    displayName: "Reddit",
    maxContentLength: 40000,
    maxMediaCount: 1,
  },
  {
    platform: "YOUTUBE" as const,
    ProviderClass: YouTubeProvider,
    displayName: "YouTube",
    maxContentLength: 5000,
    maxMediaCount: 1,
  },
  {
    platform: "TIKTOK" as const,
    ProviderClass: TikTokProvider,
    displayName: "TikTok",
    maxContentLength: 2200,
    maxMediaCount: 1,
  },
  {
    platform: "PINTEREST" as const,
    ProviderClass: PinterestProvider,
    displayName: "Pinterest",
    maxContentLength: 500,
    maxMediaCount: 1,
  },
  {
    platform: "THREADS" as const,
    ProviderClass: ThreadsProvider,
    displayName: "Threads",
    maxContentLength: 500,
    maxMediaCount: 10,
  },
  {
    platform: "TELEGRAM" as const,
    ProviderClass: TelegramProvider,
    displayName: "Telegram",
    maxContentLength: 4096,
    maxMediaCount: 10,
  },
  {
    platform: "DISCORD" as const,
    ProviderClass: DiscordProvider,
    displayName: "Discord",
    maxContentLength: 2000,
    maxMediaCount: 10,
  },
  {
    platform: "SLACK" as const,
    ProviderClass: SlackProvider,
    displayName: "Slack",
    maxContentLength: 40000,
    maxMediaCount: 10,
  },
  {
    platform: "MASTODON" as const,
    ProviderClass: MastodonProvider,
    displayName: "Mastodon",
    maxContentLength: 500,
    maxMediaCount: 4,
  },
  {
    platform: "BLUESKY" as const,
    ProviderClass: BlueskyProvider,
    displayName: "Bluesky",
    maxContentLength: 300,
    maxMediaCount: 4,
  },
  {
    platform: "MEDIUM" as const,
    ProviderClass: MediumProvider,
    displayName: "Medium",
    maxContentLength: 100000,
    maxMediaCount: 0,
  },
  {
    platform: "DEVTO" as const,
    ProviderClass: DevtoProvider,
    displayName: "Dev.to",
    maxContentLength: 100000,
    maxMediaCount: 0,
  },
];

describe("getSocialProvider", () => {
  it.each(platformExpectations)(
    "returns correct provider instance for $platform",
    ({ platform, ProviderClass }) => {
      const provider = getSocialProvider(platform);
      expect(provider).toBeInstanceOf(ProviderClass);
    }
  );

  it.each(platformExpectations)(
    "$platform provider has correct platform property",
    ({ platform }) => {
      const provider = getSocialProvider(platform);
      expect(provider.platform).toBe(platform);
    }
  );

  it.each(platformExpectations)(
    "$platform provider has correct displayName: $displayName",
    ({ platform, displayName }) => {
      const provider = getSocialProvider(platform);
      expect(provider.displayName).toBe(displayName);
    }
  );

  it.each(platformExpectations)(
    "$platform provider has valid constraints (maxContentLength > 0)",
    ({ platform, maxContentLength }) => {
      const provider = getSocialProvider(platform);
      expect(provider.constraints.maxContentLength).toBe(maxContentLength);
      expect(provider.constraints.maxContentLength).toBeGreaterThan(0);
    }
  );

  it.each(platformExpectations)(
    "$platform provider has valid constraints (maxMediaCount = $maxMediaCount)",
    ({ platform, maxMediaCount }) => {
      const provider = getSocialProvider(platform);
      expect(provider.constraints.maxMediaCount).toBe(maxMediaCount);
      expect(provider.constraints.maxMediaCount).toBeGreaterThanOrEqual(0);
    }
  );

  it.each(platformExpectations)(
    "$platform provider has supportedMediaTypes as an array",
    ({ platform }) => {
      const provider = getSocialProvider(platform);
      expect(Array.isArray(provider.constraints.supportedMediaTypes)).toBe(true);
    }
  );

  it("returns the same instance on repeated calls (singleton)", () => {
    const first = getSocialProvider("TWITTER");
    const second = getSocialProvider("TWITTER");
    expect(first).toBe(second);
  });

  it("throws an error for an unknown platform", () => {
    expect(() => getSocialProvider("UNKNOWN_PLATFORM" as any)).toThrow(
      "No provider registered for platform: UNKNOWN_PLATFORM"
    );
  });
});

describe("getSupportedPlatforms", () => {
  it("returns all 16 supported platforms", () => {
    const platforms = getSupportedPlatforms();
    expect(platforms).toHaveLength(16);
  });

  it("includes every expected platform", () => {
    const platforms = getSupportedPlatforms();
    const expectedPlatforms = platformExpectations.map((e) => e.platform);
    for (const expected of expectedPlatforms) {
      expect(platforms).toContain(expected);
    }
  });
});
