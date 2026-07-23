/** Injectable fetch so callers can supply a proxy/retrying/rate-limited fetch, and
 *  tests can supply a fixture fetch with no network. Defaults to global `fetch`. */
export type FetchFn = typeof fetch;
/** Optional usage/telemetry hook. The original app fed this into a cost sheet; here
 *  it is a no-op unless you pass one. Fire-and-forget — never awaited, never blocks. */
export type UsageHook = (u: {
    provider: string;
    operation: string;
    calls: number;
    units: number;
}) => void;
/** Options every scraper accepts. All fields optional — sensible defaults apply. */
export interface ScraperOptions {
    /** Custom fetch (proxy, retry, rate-limit). Default: global fetch. */
    fetchImpl?: FetchFn;
    /** Telemetry callback. Default: no-op. */
    onUsage?: UsageHook;
    /** Per-request timeout in ms. Default: 12_000. */
    timeoutMs?: number;
    /** A `console`-like sink for the one-line-per-account diagnostics. Pass `null`
     *  to silence. Default: the global `console`. */
    logger?: Pick<Console, "log" | "error"> | null;
}
export interface ResolvedOptions {
    fetchImpl: FetchFn;
    onUsage: UsageHook;
    timeoutMs: number;
    logger: Pick<Console, "log" | "error"> | null;
}
export declare function resolveOptions(o?: ScraperOptions): ResolvedOptions;
/** A User-Agent that reliably gets the server-rendered (un-walled) HTML from
 *  Facebook, Snapchat, and YouTube. Facebook/Snapchat serve a 600KB empty app
 *  shell to a normal Chrome UA but the full JSON-embedded HTML to Googlebot. */
export declare const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
/** fetch with an AbortController timeout. Returns null on any network/abort error
 *  (fail-open) — the caller treats null as "miss", never as a crash. */
export declare function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: FetchFn, timeoutMs: number): Promise<Response | null>;
export declare function sleep(ms: number): Promise<void>;
/** Devanagari digit (०–९) → ASCII. Facebook/Snapchat localise Indian pages so a
 *  follower count may arrive as "१,४१,६३,०५२" instead of "14,163,052". */
export declare function devanagariToAscii(input: string): string;
/** Decode the HTML entities that show up inside og: meta tags (numeric refs used
 *  for Devanagari digits, plus &amp; &quot; &#x27; etc.). Best-effort. */
export declare function decodeHtmlEntities(s: string): string;
/** Parse "14M" / "1.2K" / "553,000" / "553 thousand" / "1,41,63,052" / "1.41 crore"
 *  → integer, or null. Handles Western AND Indian unit words. */
export declare function parseCount(text: string): number | null;
/** Result of a follower-count scrape. `followers === null` means "miss — keep the
 *  existing value". `walled` distinguishes a hard block (login wall / non-200) from
 *  "profile loaded but no count found", so a caller can short-circuit after N walls. */
export interface FollowerResult {
    followers: number | null;
    walled?: boolean;
}
/** Result of a per-post engagement scrape. Any field may be null (honest absence —
 *  e.g. Snapchat exposes no like metric, so `likes` is ALWAYS null there). */
export interface EngagementResult {
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    caption: string | null;
    walled?: boolean;
}
