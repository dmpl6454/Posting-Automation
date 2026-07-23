import { ScraperOptions } from "./shared";
/**
 * Pure extractor for the UserByScreenName response body (already-parsed JSON).
 * Never throws — any missing/malformed path returns null. Exported for unit tests.
 * Handles success, {"data":{}} (dead handle → null), and a soft errors[] array
 * present alongside a populated legacy.followers_count (count still extracted).
 */
export declare function parseTwitterFollowersResponse(json: unknown): number | null;
/**
 * Resolve X/Twitter follower counts for a batch of handles. Fail-open: any failure
 * yields a smaller/empty map (keyed lowercased handle → count), never a throw.
 * @param opts.delayMs  polite delay between per-handle calls (default 500ms; 0 in tests)
 */
export declare function fetchTwitterFollowerMap(handles: string[], opts?: ScraperOptions & {
    delayMs?: number;
}): Promise<Map<string, number>>;
