import { ScraperOptions, FollowerResult } from "./shared";
import { GraphOptions } from "./meta-graph";
export declare function resetInstagramRateLimit(): void;
/**
 * Scrape one public IG account's follower count via `web_profile_info`.
 * Zero-key. Fail-open → null. Marks the whole run rate-limited on a 2nd 429/401 so
 * the caller stops hammering (call resetInstagramRateLimit() before a new batch).
 *
 * @param opts.backoffMs  delay after the first 429/401 before one retry (default 30s)
 */
export declare function scrapeInstagramFollowers(username: string, opts?: ScraperOptions & {
    backoffMs?: number;
}): Promise<number | null>;
/** Convenience wrapper: username → FollowerResult (scrape path). */
export declare function scrapeInstagramFollowerResult(username: string, opts?: ScraperOptions & {
    backoffMs?: number;
}): Promise<FollowerResult>;
export interface IgPublicCounts {
    followers: number | null;
    mediaCount: number | null;
}
export interface IgPublicMedia {
    shortcode: string;
    caption: string | null;
    permalink: string;
    timestamp?: string;
}
/**
 * Follower + media counts for public IG accounts we DON'T administer, by username,
 * via the business_discovery edge. Fail-open: returns a (possibly empty) map; a
 * miss on any handle just omits it. Rate-limit → early return of what we have.
 */
export declare function fetchPublicInstagramFollowerMap(handles: string[], opts: GraphOptions): Promise<Map<string, IgPublicCounts>>;
/**
 * Recent public captions for external IG accounts by username, via the
 * business_discovery.media edge. Fail-open. Permalink shortcode == the post id you
 * key on. `limit` caps posts per account (default 50, the edge's page size).
 */
export declare function fetchPublicInstagramCaptions(handles: string[], opts: GraphOptions & {
    mediaLimit?: number;
}): Promise<Map<string, IgPublicMedia[]>>;
