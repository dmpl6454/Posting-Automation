import IORedis from "ioredis";

const MAX_FAILURES = 3;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const KEY_TTL_SECONDS = 3600; // 1 hour

interface CircuitState {
  failures: number;
  openedAt: number;
}

function getRedis() {
  // Lazy singleton so the connection isn't created at import time in tests
  if (!_redis) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    _redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return _redis;
}
let _redis: IORedis | null = null;

function key(source: string): string {
  return `circuit:${source}`;
}

/**
 * Returns true if the source circuit is closed (i.e. the source is healthy
 * enough to call). A source is considered "open" (unhealthy) when it has
 * accumulated >= MAX_FAILURES and the cooldown period has not yet elapsed.
 */
export async function isSourceOpen(source: string): Promise<boolean> {
  const redis = getRedis();
  const raw = await redis.get(key(source));
  if (!raw) return true; // no record → healthy

  try {
    const state: CircuitState = JSON.parse(raw);

    if (state.failures >= MAX_FAILURES) {
      const elapsed = Date.now() - state.openedAt;
      if (elapsed < COOLDOWN_MS) {
        return false; // circuit is open → source is NOT available
      }
      // Cooldown elapsed – allow a retry (half-open)
      return true;
    }

    return true; // below threshold
  } catch {
    return true; // corrupted data → treat as healthy
  }
}

/**
 * Records a failure for the given source, incrementing the failure counter
 * and (if the threshold is reached) recording the time the circuit opened.
 */
export async function recordSourceFailure(source: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(key(source));

  let state: CircuitState = { failures: 0, openedAt: 0 };
  if (raw) {
    try {
      state = JSON.parse(raw);
    } catch {
      // reset on corrupted data
    }
  }

  state.failures += 1;

  if (state.failures >= MAX_FAILURES && state.openedAt === 0) {
    state.openedAt = Date.now();
  }

  await redis.set(key(source), JSON.stringify(state), "EX", KEY_TTL_SECONDS);
}

/**
 * Records a success for the given source, resetting the circuit breaker.
 */
export async function recordSourceSuccess(source: string): Promise<void> {
  const redis = getRedis();
  await redis.del(key(source));
}
