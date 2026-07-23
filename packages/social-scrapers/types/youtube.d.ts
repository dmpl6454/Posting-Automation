import { ScraperOptions, FollowerResult } from "./shared";
/** Parse "553 thousand subscribers" / "1.08 million" / "1.4M" → integer, or null. */
export declare function parseYouTubeSubscribers(text: string): number | null;
/** Extract a channel's subscriber count from its rendered HTML. Pure — exported for
 *  unit tests with a captured fixture.
 *
 *  The channel's OWN count lives in pageHeaderRenderer → contentMetadataViewModel as
 *  an `accessibilityLabel` mentioning "subscribers". That is the ONLY such label on
 *  the page — the related-channels sidebar uses `subscriberCountText` instead (which
 *  is a DIFFERENT channel's number). So we anchor on the accessibilityLabel first. */
export declare function parseYouTubeChannelHtml(html: string): number | null;
/** Scrape a channel's subscriber count from its public page URL (e.g.
 *  https://www.youtube.com/@Handle or /channel/UC…). Fail-open → null on any miss. */
export declare function scrapeYouTubeSubscribers(channelUrl: string, opts?: ScraperOptions): Promise<number | null>;
export interface YtAccountRef {
    /** Your own account id — passed through so you can map results back. */
    id: string;
    /** May be a UC… id, an @Handle, or a display name. */
    handle: string;
    /** May contain /channel/UC… or /@Handle. */
    profileUrl: string;
}
export interface YtFollowerResult {
    accountId: string;
    subscribers: number;
}
/**
 * Resolve current subscriber counts via the official Data API v3.
 * Fail-open: never throws; unresolvable accounts (deleted, hidden subs, quota
 * exhausted, missing key, network error) are simply absent from the result array.
 */
export declare function fetchYouTubeSubscriberCounts(accounts: YtAccountRef[], opts: ScraperOptions & {
    apiKey?: string;
    maxSearchLookups?: number;
}): Promise<YtFollowerResult[]>;
/** Convenience wrapper: single channel URL → FollowerResult (scrape path). */
export declare function scrapeYouTubeFollowers(channelUrl: string, opts?: ScraperOptions): Promise<FollowerResult>;
