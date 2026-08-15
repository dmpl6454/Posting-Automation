/**
 * Facebook Graph API deprecation warning cache.
 *
 * WHY
 * ---
 * Meta sends deprecation notices in response headers when we hit a
 * deprecated field or endpoint (e.g. the FB "impressions" → "post_media_view"
 * rename bit us for months before anyone noticed). Passive header sniffing
 * catches these on real traffic — no polling, no API cost.
 *
 * DESIGN
 * ------
 * The provider is the natural place to sniff (every response passes through
 * graphFetch), but the provider must stay a pure API layer — no Prisma, no
 * cross-cutting log writes on a hot path. So we cache warnings in-memory
 * here, and a worker cron drains the cache to ErrorLog on its own schedule.
 *
 * That gives us:
 *   - zero DB writes on the request path
 *   - per-process dedup so a burst of the same warning doesn't spam anything
 *   - the drain cron can dedup across time (ErrorLog fingerprint) without
 *     the provider knowing about ErrorLog at all
 *
 * DEDUP KEY
 * ---------
 * `${headerName}|${cleanEndpoint}|${warning[:100]}` — collapses the same
 * deprecation warning on the same endpoint into one cached entry regardless
 * of how many times it was seen.
 */

export interface FbDeprecationRecord {
  /** Which header carried the warning (e.g. "x-fb-api-version-warning"). */
  headerName: string;
  /** The warning message Meta sent. */
  warning: string;
  /** The endpoint that produced the warning, with IDs redacted. */
  endpoint: string;
  /** First time we saw this exact record within the process's lifetime. */
  firstSeenAt: Date;
  /** Last time we saw it. */
  lastSeenAt: Date;
  /** How many responses carried this warning (per-process, since last drain). */
  occurrences: number;
}

/**
 * Headers Meta uses to signal a deprecation.
 *
 * Order matters: x-fb-api-version-warning is the primary current channel,
 * x-ad-api-version-warning appeared on the ads endpoints, and
 * x-fb-api-warning is a general warning channel that sometimes carries
 * deprecation notices too.
 */
export const FB_DEPRECATION_HEADERS = [
  "x-fb-api-version-warning",
  "x-ad-api-version-warning",
  "x-fb-api-warning",
];

// Process-local cache. Cleared by drainFbDeprecationCache().
const cache = new Map<string, FbDeprecationRecord>();

/**
 * Redact numeric IDs from an endpoint path so different pages'/posts'
 * warnings collapse into one dedup key.
 * `/{pageId}/feed?fields=...` → `/:id/feed`
 */
function cleanEndpoint(rawEndpoint: string): string {
  const withoutQuery = rawEndpoint.split("?")[0] ?? rawEndpoint;
  // Meta IDs are all-numeric or numeric_numeric (page_post format).
  return withoutQuery.replace(/\/(\d+(?:_\d+)?)/g, "/:id");
}

/**
 * Look at a Graph API response and, if it carries a deprecation warning
 * header, record it in the in-process cache. Never throws — a broken
 * warning-cache MUST NOT break the API call.
 */
export function recordFbDeprecationFromResponse(
  res: Response,
  endpoint: string
): void {
  try {
    let headerName: string | null = null;
    let warning: string | null = null;

    for (const name of FB_DEPRECATION_HEADERS) {
      const v = res.headers.get(name);
      if (v && v.length > 0) {
        headerName = name;
        warning = v;
        break;
      }
    }

    if (!headerName || !warning) return;

    const clean = cleanEndpoint(endpoint);
    const key = `${headerName}|${clean}|${warning.slice(0, 100)}`;
    const now = new Date();
    const existing = cache.get(key);
    if (existing) {
      existing.lastSeenAt = now;
      existing.occurrences++;
    } else {
      cache.set(key, {
        headerName,
        warning,
        endpoint: clean,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrences: 1,
      });
    }
  } catch {
    // Sniffing must never throw. Warnings are best-effort.
  }
}

/**
 * Return all currently cached deprecation records and clear the cache.
 * Intended for a periodic drainer cron.
 */
export function drainFbDeprecationCache(): FbDeprecationRecord[] {
  const out = Array.from(cache.values());
  cache.clear();
  return out;
}

/**
 * Cache size, for logging/observability.
 */
export function fbDeprecationCacheSize(): number {
  return cache.size;
}
