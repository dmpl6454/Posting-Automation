import { analyticsSyncQueue } from "@postautomation/queue";
import { prisma } from "@postautomation/db";

/**
 * Best-effort enqueue of an analytics-sync job triggered by a Facebook Page
 * `feed` webhook event. Processed by analytics-sync.worker.ts.
 *
 * NEVER throws — the primary caller is the /api/webhooks/facebook route,
 * where a queue/Redis hiccup must never turn a valid delivery into a
 * non-200 response (Meta retries non-2xx and eventually disables the
 * subscription).
 *
 * NOTE for web callers: apps/web has no direct dependency on
 * `@postautomation/queue` — import this via
 * `@postautomation/api/src/lib/fb-webhook-analytics` (the api package is a
 * declared, transpiled web dependency and bridges the queue import).
 *
 * Guards: only enqueues if we can match the `<pageId>_<postId>` to a
 * PostTarget we actually published. Reactions on posts we didn't publish
 * are none of our business, and matching keeps webhook traffic proportional
 * to real work.
 */
export async function enqueueFacebookFeedAnalytics(params: {
  pageId: string;
  fbPostId: string;
  item?: string;
  verb?: string;
}): Promise<{ queued: boolean; reason?: string }> {
  const { pageId, fbPostId } = params;
  try {
    const target = await prisma.postTarget.findFirst({
      where: {
        publishedId: fbPostId,
        channel: {
          platform: "FACEBOOK",
          platformId: pageId,
        },
      },
      select: { id: true, channelId: true, publishedId: true },
    });

    if (!target?.publishedId) {
      return { queued: false, reason: "not_our_post" };
    }

    // ⚠️ jobId format: EXACTLY three colon-separated segments — BullMQ >=5.70
    // rejects other counts. Bucketing by hour so bursty events on the same
    // post collapse into one sync per hour (idempotency + politeness).
    const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));

    await analyticsSyncQueue.add(
      `analytics-fb-webhook-${target.id}`,
      {
        postTargetId: target.id,
        platform: "FACEBOOK",
        channelId: target.channelId,
        platformPostId: target.publishedId,
      },
      {
        jobId: `fbwebhook:${target.id}:${hourBucket}`,
        // Small delay so FB's counters settle before we re-fetch — reactions/
        // comments propagate to insights over several seconds after the event.
        delay: 5_000,
        removeOnComplete: true,
        removeOnFail: 50,
      }
    );

    return { queued: true };
  } catch (err: any) {
    console.warn(`[fb-webhook] enqueue failed for ${fbPostId}: ${err?.message}`);
    return { queued: false, reason: "enqueue_failed" };
  }
}
