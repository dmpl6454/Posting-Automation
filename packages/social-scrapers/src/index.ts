// @dashmani/social-scrapers — reusable, dependency-free social-platform scrapers.
//
// Two capability families:
//   • FOLLOWER COUNTS (account growth) — YouTube, Instagram, Facebook, Snapchat, X.
//   • PER-POST ENGAGEMENT (views/likes/comments) — Facebook reels, Snapchat Spotlight.
//
// Every function is FAIL-OPEN (returns null on any miss/block/timeout, never throws)
// and takes an optional `ScraperOptions` ({ fetchImpl, onUsage, timeoutMs, logger }).
// Nothing here touches a DB, an ORM, or env vars (except optional token/key fallbacks).
//
// ⚠️ Scrapers depend on live HTML/JSON shapes that platforms change without notice.
// Verify each one from the SAME network origin you'll run it on (a datacenter IP can
// see different walls than a residential IP) before trusting it in production.

export * from "./shared";
export * from "./meta-graph";
export * from "./youtube";
export * from "./instagram";
export * from "./facebook";
export * from "./snapchat";
export * from "./twitter";

// ── High-level convenience dispatchers ───────────────────────────────────────

import { ScraperOptions, FollowerResult, EngagementResult } from "./shared";
import { scrapeYouTubeFollowers } from "./youtube";
import { scrapeInstagramFollowerResult } from "./instagram";
import { scrapeFacebookFollowerResult, scrapeFacebookReelEngagement } from "./facebook";
import { scrapeSnapchatFollowers, scrapeSnapchatSpotlightEngagement } from "./snapchat";
import { fetchTwitterFollowerMap } from "./twitter";

export type Platform = "youtube" | "instagram" | "facebook" | "snapchat" | "twitter";

export interface AccountRef {
  platform: Platform;
  /** handle/username (no @ needed) — used by IG/X/SC/FB fallbacks. */
  handle: string;
  /** stored profile URL — used by YouTube/Facebook/Snapchat. */
  profileUrl?: string | null;
}

/**
 * One-call follower-count dispatcher. Routes to the right platform scraper and
 * always returns a FollowerResult (followers:null on a miss). Note X/Twitter is
 * batch-oriented (one guest token per call) — for many X handles call
 * fetchTwitterFollowerMap directly instead of this per-account helper.
 */
export async function scrapeFollowerCount(acc: AccountRef, opts?: ScraperOptions): Promise<FollowerResult> {
  switch (acc.platform) {
    case "youtube":
      return acc.profileUrl ? scrapeYouTubeFollowers(acc.profileUrl, opts) : { followers: null };
    case "instagram":
      return scrapeInstagramFollowerResult(acc.handle, opts);
    case "facebook":
      return scrapeFacebookFollowerResult(acc.profileUrl ?? "", acc.handle, opts);
    case "snapchat":
      return scrapeSnapchatFollowers(acc.handle, acc.profileUrl, opts);
    case "twitter": {
      const map = await fetchTwitterFollowerMap([acc.handle], opts);
      const n = map.get(acc.handle.toLowerCase());
      return { followers: n ?? null };
    }
    default:
      return { followers: null };
  }
}

/**
 * One-call per-post engagement dispatcher. Only Facebook reels and Snapchat
 * Spotlight expose scrapeable engagement; other platforms return all-null.
 * @param postId  numeric reel id (Facebook) or spotlight id (Snapchat)
 */
export async function scrapeEngagement(
  platform: Platform, postId: string, opts?: ScraperOptions,
): Promise<EngagementResult> {
  if (platform === "facebook") return scrapeFacebookReelEngagement(postId, opts);
  if (platform === "snapchat") return scrapeSnapchatSpotlightEngagement(postId, opts);
  return { views: null, likes: null, comments: null, shares: null, caption: null };
}
