import { bumpAnalyticsCacheVersion, createRedisConnection } from "@postautomation/queue";

let redis: ReturnType<typeof createRedisConnection> | null = null;

/**
 * Tell the web container's Insights cache that this org's numbers changed
 * (a publish or a new analytics snapshot). Fire-and-forget: never awaited for
 * its result, never throws.
 */
export function bumpInsightsCache(organizationId: string | null | undefined): void {
  if (!organizationId) return;
  try {
    if (!redis) redis = createRedisConnection();
    bumpAnalyticsCacheVersion(redis, organizationId);
  } catch {
    /* cache bookkeeping must never affect publishing or analytics */
  }
}
