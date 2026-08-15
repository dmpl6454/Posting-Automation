/**
 * Facebook Graph API app-level health checker.
 *
 * The reason we spent 8 days at 100% x-app-usage in April 2026 was nothing
 * was watching. This module makes a single lightweight Graph call and reads
 * the response's `x-app-usage` header — Meta returns it on every request
 * — so we can alert BEFORE we're throttled instead of after users notice.
 *
 * Cost: 1 call per invocation. At 30-minute cadence that is 48 calls/day
 * against a per-app hourly quota measured in thousands, so <0.5% of quota.
 *
 * Uses an APP access token (`{app_id}|{app_secret}`) rather than a user
 * token — the response's x-app-usage covers the whole app quota regardless
 * of which token asked, and app tokens don't consume user rate-limit
 * budgets. See https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 */

export interface FbAppHealthReading {
  /** Percentage of API-call quota used, 0-100+ (can exceed 100 briefly). */
  callCount: number;
  /** Percentage of CPU-time quota used. */
  totalCpuTime: number;
  /** Percentage of total-time quota used. */
  totalTime: number;
  /** max of the three — treat as the effective usage level. */
  maxUsage: number;
  hitAt: Date;
}

const HEALTH_API_VERSION = "v18.0";

export async function readFacebookAppHealth(
  appId: string,
  appSecret: string,
  timeoutMs = 10_000
): Promise<FbAppHealthReading | null> {
  const appToken = `${appId}|${appSecret}`;

  // Query the app node itself — cheapest call that reliably returns
  // x-app-usage. `/me` needs a user token; `/{app-id}` works with app-token
  // and always exists.
  const url =
    `https://graph.facebook.com/${HEALTH_API_VERSION}/${appId}` +
    `?fields=id&access_token=${appToken}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err: any) {
    console.warn(`[fb-health] fetch failed: ${err?.message}`);
    return null;
  }

  const usageHeader = res.headers.get("x-app-usage");
  if (!usageHeader) {
    // Meta occasionally omits the header on cached responses. Not an error.
    return null;
  }

  try {
    const parsed = JSON.parse(usageHeader) as {
      call_count?: number;
      total_cputime?: number;
      total_time?: number;
    };
    const callCount = Number(parsed.call_count ?? 0);
    const totalCpuTime = Number(parsed.total_cputime ?? 0);
    const totalTime = Number(parsed.total_time ?? 0);
    return {
      callCount,
      totalCpuTime,
      totalTime,
      maxUsage: Math.max(callCount, totalCpuTime, totalTime),
      hitAt: new Date(),
    };
  } catch (err: any) {
    console.warn(`[fb-health] failed to parse x-app-usage: ${err?.message}`);
    return null;
  }
}
