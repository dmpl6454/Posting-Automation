interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: Date;
}

interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export function createRateLimiter(options: RateLimiterOptions) {
  const { windowMs, max } = options;
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries every 60 seconds
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (now - entry.windowStart >= windowMs) {
        store.delete(key);
      }
    }
  }, 60_000);

  // Allow garbage collection if the process is shutting down
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return function checkRateLimit(key: string): RateLimitResult {
    const now = Date.now();
    const entry = store.get(key);

    // If no entry or the window has expired, start a new window
    if (!entry || now - entry.windowStart >= windowMs) {
      store.set(key, { count: 1, windowStart: now });
      return {
        success: true,
        remaining: max - 1,
        resetAt: new Date(now + windowMs),
      };
    }

    // Sliding window: increment the count within the current window
    entry.count += 1;

    const resetAt = new Date(entry.windowStart + windowMs);
    const remaining = Math.max(0, max - entry.count);

    if (entry.count > max) {
      return {
        success: false,
        remaining: 0,
        resetAt,
      };
    }

    return {
      success: true,
      remaining,
      resetAt,
    };
  };
}

// Preset rate limiters
/** 100 requests per minute */
export const apiRateLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

/** 10 requests per minute */
export const authRateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

/** 20 requests per minute */
export const aiRateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });
