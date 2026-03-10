import { createRedisConnection } from "@postautomation/queue";

/** Prefix constants for cache key namespacing */
export const CACHE_PREFIXES = {
  ANALYTICS: "cache:analytics:",
  CHANNELS: "cache:channels:",
  TEAM: "cache:team:",
  POSTS: "cache:posts:",
} as const;

/** Default TTL in seconds (5 minutes) */
const DEFAULT_TTL = 300;

/** Redis client type inferred from the queue connection factory */
type RedisClient = ReturnType<typeof createRedisConnection>;

/** Singleton Redis client for caching — lazily initialized */
let redisClient: RedisClient | null = null;

function getRedis(): RedisClient {
  if (!redisClient) {
    redisClient = createRedisConnection();
  }
  return redisClient;
}

/**
 * Retrieve a cached value by key. Returns null on miss or error.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    if (raw === null) {
      return null;
    }
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn("[cache] GET failed for key:", key, error);
    return null;
  }
}

/**
 * Store a value in the cache with an optional TTL.
 *
 * @param key - Cache key
 * @param value - Value to serialize and store
 * @param ttlSeconds - Time-to-live in seconds (default: 300)
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number = DEFAULT_TTL,
): Promise<void> {
  try {
    const serialized = JSON.stringify(value);
    await getRedis().set(key, serialized, "EX", ttlSeconds);
  } catch (error) {
    console.warn("[cache] SET failed for key:", key, error);
  }
}

/**
 * Delete a single cache entry by key.
 */
export async function cacheDelete(key: string): Promise<void> {
  try {
    await getRedis().del(key);
  } catch (error) {
    console.warn("[cache] DEL failed for key:", key, error);
  }
}

/**
 * Clear all cache entries matching a glob pattern using SCAN + DEL.
 * This avoids blocking the Redis server (unlike KEYS).
 *
 * @param pattern - A Redis glob pattern, e.g. "cache:analytics:*"
 */
export async function cacheClear(pattern: string): Promise<void> {
  try {
    const redis = getRedis();
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } catch (error) {
    console.warn("[cache] CLEAR failed for pattern:", pattern, error);
  }
}

/**
 * Cache-aside helper. Returns cached data if available, otherwise calls the
 * provided function, caches the result, and returns it.
 *
 * Cache failures are transparent — the function always falls through to `fn()`
 * when the cache is unavailable.
 *
 * @param key - Cache key
 * @param fn - Async function that produces the value (e.g. a DB query)
 * @param ttlSeconds - Time-to-live in seconds (default: 300)
 */
export async function withCache<T>(
  key: string,
  fn: () => Promise<T>,
  ttlSeconds: number = DEFAULT_TTL,
): Promise<T> {
  const cached = await cacheGet<T>(key);
  if (cached !== null) {
    return cached;
  }

  const result = await fn();
  await cacheSet(key, result, ttlSeconds);
  return result;
}
