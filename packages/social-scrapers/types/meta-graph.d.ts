export declare const GRAPH_BASE = "https://graph.facebook.com/v21.0";
export interface GraphError {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
}
export interface GraphFetchResult<T = any> {
    ok: boolean;
    rateLimited: boolean;
    status: number;
    data?: T;
    error?: string;
}
/** Config for every Graph call. Token can be passed explicitly or read from
 *  process.env.META_SYSTEM_USER_TOKEN. `fetchImpl` is injectable for tests/proxy. */
export interface GraphOptions {
    token?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    onUsage?: (u: {
        provider: string;
        operation: string;
        calls: number;
        units: number;
    }) => void;
}
export declare function getMetaToken(o?: GraphOptions): string | undefined;
/** True when a token is available — mirror this into your provider's isSupported()
 *  so you never poll Meta with no token ("dark switch"). */
export declare function metaConfigured(o?: GraphOptions): boolean;
export declare function isRateLimitError(httpStatus: number, err?: GraphError): boolean;
/**
 * Fetch a Graph path (relative to GRAPH_BASE, or an absolute paging cursor).
 * Injects the access_token, parses JSON, maps Meta errors + rate-limits.
 * NEVER throws. `path` may already contain a query string (e.g. `?fields=…`).
 */
export declare function graphFetch<T = any>(path: string, o?: GraphOptions, params?: Record<string, string | number | undefined>): Promise<GraphFetchResult<T>>;
