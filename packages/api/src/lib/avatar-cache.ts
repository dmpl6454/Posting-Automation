import { avatarCacheQueue } from "@postautomation/queue";

/**
 * Best-effort enqueue of avatar-cache jobs (processed by the worker's
 * avatar-cache.worker.ts, which re-caches platform profile pictures to
 * durable S3 storage).
 *
 * NEVER throws — the primary caller is the OAuth connect callback
 * (apps/web/app/api/oauth/callback/[provider]/route.ts), where a queue/Redis
 * hiccup must never break the connect flow. Callers should additionally
 * fire-and-forget (do not await): the shared Redis connection is configured
 * with `maxRetriesPerRequest: null`, so an add against a down Redis would
 * otherwise block indefinitely.
 *
 * NOTE for web callers: apps/web has no direct dependency on
 * `@postautomation/queue` — import this via
 * `@postautomation/api/src/lib/avatar-cache` (the api package is a declared,
 * transpiled web dependency and bridges the queue import).
 *
 * @param reason short dedupe label (no ':' — BullMQ custom jobIds allow ':'
 *   only with EXACTLY three colon-separated segments).
 */
export async function enqueueAvatarCacheJobs(channelIds: string[], reason: string): Promise<void> {
  for (const channelId of channelIds) {
    try {
      await avatarCacheQueue.add(
        `avatar-${channelId}`,
        { channelId },
        {
          jobId: `avatar:${channelId}:${reason}-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: 100,
        }
      );
    } catch (err: any) {
      console.warn(`[avatar-cache] Failed to enqueue avatar job for channel ${channelId}: ${err?.message ?? err}`);
    }
  }
}
