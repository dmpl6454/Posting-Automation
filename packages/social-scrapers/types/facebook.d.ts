import { ScraperOptions, FollowerResult, EngagementResult } from "./shared";
/**
 * Scrape a Facebook Page/profile follower (or like) count. Fail-open → null.
 * @param profileUrl  the stored profile URL (may be facebook.com/profile.php?id=<n>
 *                    or a vanity /slug)
 * @param handle      fallback slug if the URL has none
 */
export declare function scrapeFacebookFollowers(profileUrl: string, handle: string, opts?: ScraperOptions): Promise<number | null>;
/** Convenience wrapper → FollowerResult. */
export declare function scrapeFacebookFollowerResult(profileUrl: string, handle: string, opts?: ScraperOptions): Promise<FollowerResult>;
/** Parse engagement + caption out of a reel page's HTML. Pure + synchronous —
 *  exported for unit tests with captured fixtures. See the TARGET-SCOPING note above. */
export declare function parseFbReelHtml(html: string): Omit<EngagementResult, "walled" | "shares">;
/**
 * Fetch + parse one public reel's engagement by its NUMERIC reel id. Fail-open:
 * returns all-null (walled:true on a block) on any non-200, login redirect, short
 * body, timeout, or throw. Opaque /share/ or pfbid ids are not accepted — resolve
 * them to a numeric /reel/<id> first (a single unauthenticated 302 usually works).
 */
export declare function scrapeFacebookReelEngagement(reelId: string, opts?: ScraperOptions): Promise<EngagementResult>;
