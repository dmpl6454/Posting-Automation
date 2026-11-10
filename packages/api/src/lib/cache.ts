import IORedis from "ioredis";
import superjson from "superjson";
import { createHash } from "node:crypto";
import { analyticsCacheVersionKey, bumpAnalyticsCacheVersion } from "@postautomation/queue";

/**
 * Redis read cache for heavy Insights queries (2026-11-10).
 *
 * Rules that keep it safe:
 * - **Never in the way.** Its own client with a short command timeout, no
 *   offline queue and one retry: if Redis is slow or down, every call falls
 *   through to the database within ~250 ms. (The BullMQ connection uses
 *   `maxRetriesPerRequest: null`, which would hang a request forever.)
 * - **Org-scoped keys.** `cache:analytics:{org}:{version}:{path}:{inputHash}`.
 *   The org id comes from the authenticated context, never from input.
 * - **Invalidation by version.** `bumpAnalyticsCacheVersion` (worker after a
 *   publish or snapshot write, web on Sync Now / channel changes) makes all of
 *   an org's entries unreachable at once; the short TTL bounds everything else.
 * - **Bounded memory.** Redis runs with `noeviction` and BullMQ shares it, so
 *   entries are short-lived and anything over 512 KB is not cached.
 * - **superjson**, so Date / BigInt come back as the same types tRPC sends.
 * - Kill switch: `ANALYTICS_CACHE_ENABLED=false`. Off under vitest unless a
 *   test opts in with `ANALYTICS_CACHE_ENABLED=true`.
 */

export const CACHE_PREFIXES = {
  ANALYTICS: "cache:analytics:",
} as const;

/** Seconds an Insights result is served from cache. */
export const ANALYTICS_CACHE_TTL_S = 120;
/** Serialized results larger than this are not cached. */
export const MAX_CACHE_ENTRY_BYTES = 512 * 1024;

type RedisClient = Pick<IORedis, "get" | "set" | "multi">;

let client: RedisClient | null = null;
let clientOverride: RedisClient | null = null;

/** Tests only: inject a fake Redis (null restores the real one). */
export function __setCacheRedisForTests(fake: RedisClient | null): void {
  clientOverride = fake;
}

export function isAnalyticsCacheEnabled(): boolean {
  const flag = process.env.ANALYTICS_CACHE_ENABLED;
  if (flag === "false") return false;
  if (process.env.VITEST && flag !== "true") return false;
  return true;
}

function getRedis(): RedisClient {
  if (clientOverride) return clientOverride;
  if (!client) {
    const c = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
      commandTimeout: 250,
      connectTimeout: 2_000,
      lazyConnect: true,
    });
    let lastLog = 0;
    c.on("error", (err) => {
      // Throttled: a Redis outage must not flood the web log.
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        console.warn("[cache] redis error:", err.message);
      }
    });
    c.connect().catch(() => {});
    client = c;
  }
  return client;
}

/**
 * Wait (at most `maxMs`) for the connection to be ready. Commands sent while
 * connecting fail at once (no offline queue), so without this the first
 * requests after a restart would always miss — and a version bump sent in that
 * window would be lost. A down Redis costs at most `maxMs` per call.
 */
let lastFailedWaitAt = 0;
async function getReadyRedis(maxMs = 300): Promise<RedisClient> {
  const c = getRedis();
  if (clientOverride || (c as IORedis).status === "ready") return c;
  const real = c as IORedis;
  // Redis just failed to come up: don't make every request wait again — the
  // command fails at once and the query runs normally.
  if (Date.now() - lastFailedWaitAt < 10_000) return c;
  if (real.status === "end" || real.status === "close") {
    real.connect().catch(() => {});
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      real.off("ready", done);
      resolve();
    };
    const timer = setTimeout(() => {
      lastFailedWaitAt = Date.now();
      done();
    }, maxMs);
    real.once("ready", done);
  });
  return c;
}

/** Stable hash of a procedure input (key order does not matter). */
export function hashInput(input: unknown): string {
  const stable = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(stable);
    if (v instanceof Date) return v.toISOString();
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) acc[k] = stable(val);
        return acc;
      }, {});
  };
  return createHash("sha1").update(JSON.stringify(stable(input ?? null)) ?? "null").digest("hex").slice(0, 20);
}

export function analyticsCacheKey(organizationId: string, version: string, path: string, input: unknown): string {
  return `${CACHE_PREFIXES.ANALYTICS}${organizationId}:${version}:${path}:${hashInput(input)}`;
}

export type CacheRead<T> = { key: string | null; hit: true; value: T } | { key: string | null; hit: false };

/** Look an org-scoped result up. Never throws; `key: null` means "don't write back". */
export async function readOrgCache<T>(organizationId: string, path: string, input: unknown): Promise<CacheRead<T>> {
  if (!isAnalyticsCacheEnabled() || !organizationId) return { key: null, hit: false };
  try {
    const redis = await getReadyRedis();
    const version = (await redis.get(analyticsCacheVersionKey(organizationId))) ?? "0";
    const key = analyticsCacheKey(organizationId, version, path, input);
    const raw = await redis.get(key);
    if (raw !== null) return { key, hit: true, value: superjson.parse<T>(raw) };
    return { key, hit: false };
  } catch {
    // Redis unavailable or a bad entry: compute normally, and don't write back.
    return { key: null, hit: false };
  }
}

/** Store a result. Never throws; oversize results are skipped. */
export async function writeOrgCache(key: string | null, value: unknown, ttlSeconds: number = ANALYTICS_CACHE_TTL_S): Promise<void> {
  if (!key) return;
  try {
    const serialized = superjson.stringify(value);
    if (serialized.length > MAX_CACHE_ENTRY_BYTES) return;
    await (await getReadyRedis()).set(key, serialized, "EX", ttlSeconds);
  } catch {
    /* never fail a request on a cache write */
  }
}

/**
 * Cache-aside for one org-scoped query. Any cache failure falls through to
 * `fn()`; a failing `fn()` is never cached.
 */
export async function withOrgCache<T>(
  organizationId: string,
  path: string,
  input: unknown,
  fn: () => Promise<T>,
  ttlSeconds: number = ANALYTICS_CACHE_TTL_S
): Promise<T> {
  const read = await readOrgCache<T>(organizationId, path, input);
  if (read.hit) return read.value;
  const result = await fn();
  await writeOrgCache(read.key, result, ttlSeconds);
  return result;
}

/** Drop every cached Insights result for an org (web-side callers). Never throws, never blocks. */
export function invalidateOrgAnalyticsCache(organizationId: string | null | undefined): void {
  if (!isAnalyticsCacheEnabled() || !organizationId) return;
  getReadyRedis(2_000)
    .then((redis) => bumpAnalyticsCacheVersion(redis as never, organizationId))
    .catch(() => {});
}
