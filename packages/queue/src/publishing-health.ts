/**
 * Publishing health (2026-11-12).
 *
 * On 2026-11-10 the worker crash-looped for ~33 hours (`Cannot find module
 * '@langchain/core/output_parsers'`, 1,848 restarts) and NOTHING published —
 * while the deploy workflow was green and the website answered normally. No
 * signal anywhere said "posts are not going out". This module is that signal.
 *
 * Two independent facts, both readable from the WEB container (which stays up
 * when the worker dies):
 *
 *  1. **Heartbeat** — the worker's scheduled-post scan writes
 *     `PUBLISH_HEARTBEAT_KEY` (epoch ms) every time it completes (every 30s).
 *     A stale heartbeat means the scan is not running: the worker is down,
 *     crash-looping, or cannot reach the database.
 *  2. **Overdue posts** — a post still SCHEDULED well past its time means the
 *     scan never picked it up, whatever the heartbeat says.
 *
 * Lives in packages/queue because the worker WRITES it and web READS it.
 */

/** Redis key holding the epoch ms of the last completed scheduled-post scan. */
export const PUBLISH_HEARTBEAT_KEY = "health:publish-scan";
/** The key outlives any plausible outage so "missing" really means "no scan for an hour". */
export const PUBLISH_HEARTBEAT_TTL_S = 60 * 60;

/** The scan runs every 30s; three missed runs plus slack = something is wrong. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;
/** A SCHEDULED post this far past its time was never picked up by the scan. */
export const OVERDUE_GRACE_MS = 10 * 60 * 1000;

interface RedisWriter {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

/** Record a completed scan. Never throws: health bookkeeping must not break publishing. */
export function recordPublishHeartbeat(redis: RedisWriter, now: number = Date.now()): void {
  try {
    redis.set(PUBLISH_HEARTBEAT_KEY, String(now), "EX", PUBLISH_HEARTBEAT_TTL_S).catch(() => {});
  } catch {
    /* never affect the scan */
  }
}

export function parseHeartbeat(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type PublishingHealthStatus = "ok" | "delayed" | "down" | "unknown";

export interface PublishingHealthInput {
  now: number;
  /** Epoch ms of the last scan; null = no heartbeat in the last hour. `undefined` = Redis could not be read. */
  heartbeatAt: number | null | undefined;
  /** SCHEDULED posts more than OVERDUE_GRACE_MS past their time; `undefined` = DB could not be read. */
  overduePosts: number | undefined;
  /** scheduledAt of the oldest such post. */
  oldestOverdueAt?: number | null;
}

export interface PublishingHealth {
  status: PublishingHealthStatus;
  /** Seconds since the last scan, null when unknown. */
  heartbeatAgeSec: number | null;
  overduePosts: number | null;
  /** Minutes the oldest overdue post is late, null when none / unknown. */
  oldestOverdueMinutes: number | null;
  /** One plain sentence for the operator. Never contains user content. */
  reason: string;
}

/**
 * Pure verdict.
 * - `down`: the scan has not run recently (worker not publishing at all).
 * - `delayed`: the scan runs but posts are still sitting past their time.
 * - `unknown`: we could not read Redis AND the database — say so, never guess.
 * - `ok`: otherwise.
 */
export function evaluatePublishingHealth(input: PublishingHealthInput): PublishingHealth {
  const { now, heartbeatAt, overduePosts, oldestOverdueAt } = input;
  const heartbeatAgeSec =
    typeof heartbeatAt === "number" ? Math.max(0, Math.round((now - heartbeatAt) / 1000)) : null;
  const oldestOverdueMinutes =
    typeof oldestOverdueAt === "number" && (overduePosts ?? 0) > 0
      ? Math.max(0, Math.round((now - oldestOverdueAt) / 60000))
      : null;
  const base = {
    heartbeatAgeSec,
    overduePosts: overduePosts ?? null,
    oldestOverdueMinutes,
  };

  if (heartbeatAt === undefined && overduePosts === undefined) {
    return { ...base, status: "unknown", reason: "Could not read the queue or the database." };
  }
  if (heartbeatAt === undefined) {
    // Publishing runs entirely through this Redis: unreadable queue = nothing goes out.
    return { ...base, status: "down", reason: "The publishing queue (Redis) could not be reached." };
  }
  if (heartbeatAt === null) {
    return { ...base, status: "down", reason: "The publishing worker has not run in the last hour." };
  }
  if (typeof heartbeatAt === "number" && now - heartbeatAt > HEARTBEAT_STALE_MS) {
    return {
      ...base,
      status: "down",
      reason: `The publishing worker last ran ${Math.round((now - heartbeatAt) / 60000)} min ago.`,
    };
  }
  if ((overduePosts ?? 0) > 0) {
    return {
      ...base,
      status: "delayed",
      reason: `${overduePosts} scheduled post(s) are past their time and not yet picked up.`,
    };
  }
  return { ...base, status: "ok", reason: "Publishing is running." };
}
