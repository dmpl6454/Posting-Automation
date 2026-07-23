import { ScraperOptions, FollowerResult, EngagementResult } from "./shared";
/** Parse a subscriber count out of a Snapchat public-profile HTML page. Pure —
 *  exported for unit tests. Strategy order: __NEXT_DATA__ → JSON-LD FollowAction →
 *  og:description → inline "subscriberCount"/"followerCount". */
export declare function parseSnapchatProfileHtml(html: string): number | null;
/** Ordered candidate profile URLs. The stored profile_url (/t/ or /p/) is tried
 *  FIRST — that's where the count lives; /add/<handle> 404s for most real accounts. */
export declare function snapchatCandidateUrls(handle: string, profileUrl?: string | null): string[];
/**
 * Scrape a Snapchat account's follower count. Pass the stored `profileUrl` (a /t/ or
 * /p/ link) — it is tried first. Fail-open: { followers: null } on any miss (caller
 * keeps the existing value); { followers: null, walled: true } on a hard block.
 */
export declare function scrapeSnapchatFollowers(handle: string, profileUrl?: string | null, opts?: ScraperOptions): Promise<FollowerResult>;
/** Parse a /spotlight/<id> page's __NEXT_DATA__ and read spotlightStories[0] ONLY.
 *  Pure + synchronous — exported for unit tests. `likes` is always null. */
export declare function parseSnapchatSpotlightHtml(html: string): Omit<EngagementResult, "walled">;
/**
 * Fetch + parse one public Spotlight's engagement by its id. Fail-open → all-null
 * (walled:true on a block) on any non-200, login redirect, short body, missing blob,
 * parse miss, or timeout.
 */
export declare function scrapeSnapchatSpotlightEngagement(spotlightId: string, opts?: ScraperOptions): Promise<EngagementResult>;
