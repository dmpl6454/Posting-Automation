export * from "./shared";
export * from "./meta-graph";
export * from "./youtube";
export * from "./instagram";
export * from "./facebook";
export * from "./snapchat";
export * from "./twitter";
import { ScraperOptions, FollowerResult, EngagementResult } from "./shared";
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
export declare function scrapeFollowerCount(acc: AccountRef, opts?: ScraperOptions): Promise<FollowerResult>;
/**
 * One-call per-post engagement dispatcher. Only Facebook reels and Snapchat
 * Spotlight expose scrapeable engagement; other platforms return all-null.
 * @param postId  numeric reel id (Facebook) or spotlight id (Snapchat)
 */
export declare function scrapeEngagement(platform: Platform, postId: string, opts?: ScraperOptions): Promise<EngagementResult>;
