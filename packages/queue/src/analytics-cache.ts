/**
 * Insights cache versioning (2026-11-10).
 *
 * The web container caches heavy Insights queries in Redis under keys that
 * include a per-org VERSION. Anything that changes an org's numbers bumps the
 * version, which makes every cached entry for that org unreachable at once
 * (they then expire on their short TTL). Lives in packages/queue because both
 * containers touch it: the worker bumps after publishes and snapshot writes,
 * the web container reads it and bumps on Sync Now / channel changes.
 */

/** Minimal Redis surface, so callers can pass any ioredis client. */
interface RedisLike {
  multi(): { incr(key: string): unknown; expire(key: string, seconds: number): unknown; exec(): Promise<unknown> };
}

export function analyticsCacheVersionKey(organizationId: string): string {
  return `cache:analytics-ver:${organizationId}`;
}

/** Version keys live a week past their last bump; a reset to 0 then can't meet a live entry (entry TTL is minutes). */
export const ANALYTICS_CACHE_VERSION_TTL_S = 7 * 24 * 60 * 60;

/**
 * Bump an org's Insights cache version. Never throws and never blocks the
 * caller: it is not awaited for its result, and a Redis error is swallowed.
 */
export function bumpAnalyticsCacheVersion(redis: RedisLike, organizationId: string | null | undefined): void {
  if (!organizationId) return;
  try {
    const key = analyticsCacheVersionKey(organizationId);
    const m = redis.multi();
    m.incr(key);
    m.expire(key, ANALYTICS_CACHE_VERSION_TTL_S);
    m.exec().catch(() => {});
  } catch {
    /* cache bookkeeping must never affect the caller */
  }
}
