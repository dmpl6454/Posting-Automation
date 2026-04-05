/**
 * Redis-based progress tracker for long-running operations.
 * Backend pushes steps → SSE endpoint streams them to the frontend.
 *
 * Uses a Redis list + pub/sub for real-time delivery.
 * Key format: progress:{jobId}
 * Channel format: progress-notify:{jobId}
 *
 * All functions are safe to call even if Redis is unavailable — they silently no-op.
 */

export type StepStatus = "running" | "done" | "error" | "skipped";

export interface ProgressStep {
  step: string;
  status: StepStatus;
  detail?: string;
  ts: number;
}

const TTL = 300; // 5 min — auto-cleanup

let pubClient: any = null;

async function getPubClient() {
  if (!pubClient) {
    try {
      const IORedis = (await import("ioredis")).default;
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
      pubClient = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
    } catch {
      return null;
    }
  }
  return pubClient;
}

/**
 * Push a progress step for a job.
 * Called from the backend (router / worker).
 */
export async function pushProgress(jobId: string, step: string, status: StepStatus, detail?: string) {
  try {
    const redis = await getPubClient();
    if (!redis) return;
    const key = `progress:${jobId}`;
    const entry: ProgressStep = { step, status, detail, ts: Date.now() };
    const payload = JSON.stringify(entry);

    await redis.rpush(key, payload);
    await redis.expire(key, TTL);
    await redis.publish(`progress-notify:${jobId}`, payload);
  } catch {
    // Never let progress tracking break the main flow
  }
}

/**
 * Get all progress steps for a job.
 */
export async function getProgress(jobId: string): Promise<ProgressStep[]> {
  try {
    const redis = await getPubClient();
    if (!redis) return [];
    const raw = await redis.lrange(`progress:${jobId}`, 0, -1);
    return raw.map((r: string) => JSON.parse(r));
  } catch {
    return [];
  }
}

/**
 * Mark a job as finished (final step).
 */
export async function finishProgress(jobId: string, status: "done" | "error", detail?: string) {
  await pushProgress(jobId, "__finished__", status, detail);
}
