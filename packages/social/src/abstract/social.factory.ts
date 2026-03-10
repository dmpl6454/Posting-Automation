import type { SocialPlatform } from "@postautomation/db";
import type { SocialProvider } from "./social.abstract";
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

const providerMap: Partial<Record<SocialPlatform, new () => SocialProvider>> = {
  TWITTER: TwitterProvider,
  LINKEDIN: LinkedInProvider,
  FACEBOOK: FacebookProvider,
  INSTAGRAM: InstagramProvider,
  REDDIT: RedditProvider,
  YOUTUBE: YouTubeProvider,
  TIKTOK: TikTokProvider,
  PINTEREST: PinterestProvider,
  THREADS: ThreadsProvider,
  TELEGRAM: TelegramProvider,
  DISCORD: DiscordProvider,
  SLACK: SlackProvider,
  MASTODON: MastodonProvider,
  BLUESKY: BlueskyProvider,
  MEDIUM: MediumProvider,
  DEVTO: DevtoProvider,
};

const instances = new Map<SocialPlatform, SocialProvider>();

export function getSocialProvider(platform: SocialPlatform): SocialProvider {
  if (!instances.has(platform)) {
    const ProviderClass = providerMap[platform];
    if (!ProviderClass) {
      throw new Error(`No provider registered for platform: ${platform}`);
    }
    instances.set(platform, new ProviderClass());
  }
  return instances.get(platform)!;
}

export function getSupportedPlatforms(): SocialPlatform[] {
  return Object.keys(providerMap) as SocialPlatform[];
}
