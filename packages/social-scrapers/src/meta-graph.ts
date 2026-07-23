// ── Meta (Instagram + Facebook) Graph API helper ─────────────────────────────
//
// A thin, injectable wrapper over graph.facebook.com. Used by the Instagram
// business_discovery path and the Facebook owned-Page insights path. Reads its
// token from GraphOptions (or process.env.META_SYSTEM_USER_TOKEN as a fallback) —
// a permanent Meta System-User token, which never expires and can read the
// follower counts + published-post insights of every Page/IG account in your
// Business Manager WITHOUT publishing the app (System-User reads of your OWN
// business's accounts work on Standard access in Development mode).
//
// graphFetch is fail-open: it NEVER throws. It resolves to {ok,rateLimited,status,
// data,error}. Callers check `rateLimited` to short-circuit a run (Meta enforces a
// coarse ~200 calls/user/hour limit shared across all your Graph traffic).

export const GRAPH_BASE = "https://graph.facebook.com/v21.0";

/** Meta error codes that indicate throttling / over-limit — short-circuit the run.
 *   4 app limit · 17 user (~200/hr) · 32 page limit · 613 rate limit */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

export interface GraphError { message?: string; code?: number; error_subcode?: number; type?: string }

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
  onUsage?: (u: { provider: string; operation: string; calls: number; units: number }) => void;
}

export function getMetaToken(o?: GraphOptions): string | undefined {
  return o?.token ?? process.env.META_SYSTEM_USER_TOKEN;
}

/** True when a token is available — mirror this into your provider's isSupported()
 *  so you never poll Meta with no token ("dark switch"). */
export function metaConfigured(o?: GraphOptions): boolean {
  return !!getMetaToken(o);
}

export function isRateLimitError(httpStatus: number, err?: GraphError): boolean {
  if (httpStatus === 429) return true;
  if (err) {
    if (err.code != null && RATE_LIMIT_CODES.has(err.code)) return true;
    if (typeof err.message === "string" && /rate limit/i.test(err.message)) return true;
  }
  return false;
}

function opFromPath(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("business_discovery")) return "graph-business-discovery";
  if (p.includes("me/accounts")) return "graph-me-accounts";
  if (p.includes("/insights")) return "graph-insights";
  if (p.includes("published_posts")) return "graph-published-posts";
  if (p.includes("/media")) return "graph-media";
  return "graph-other";
}

/**
 * Fetch a Graph path (relative to GRAPH_BASE, or an absolute paging cursor).
 * Injects the access_token, parses JSON, maps Meta errors + rate-limits.
 * NEVER throws. `path` may already contain a query string (e.g. `?fields=…`).
 */
export async function graphFetch<T = any>(
  path: string,
  o: GraphOptions = {},
  params: Record<string, string | number | undefined> = {},
): Promise<GraphFetchResult<T>> {
  const token = getMetaToken(o);
  if (!token) return { ok: false, rateLimited: false, status: 0, error: "META token not configured" };
  const fetchImpl = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 10_000;

  const isAbsolute = /^https?:\/\//i.test(path);
  const url = new URL(isAbsolute ? path : `${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));

  o.onUsage?.({ provider: "meta", operation: opFromPath(path), calls: 1, units: 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url.toString(), { signal: controller.signal });
    let body: any;
    try { body = await res.json(); } catch { body = undefined; }
    const err = body?.error as GraphError | undefined;
    if (!res.ok || err) {
      return { ok: false, rateLimited: isRateLimitError(res.status, err), status: res.status, error: err?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, rateLimited: false, status: res.status, data: body as T };
  } catch (e) {
    return { ok: false, rateLimited: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
