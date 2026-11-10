import { mediaProcessQueue } from "./queues";

/**
 * Media-grid WebP thumbnails (2026-11-10). ONE job id per media row, so the
 * immediate enqueue at upload and the worker's sweep dedupe in BullMQ.
 * Exactly 3 colon segments — BullMQ rejects other counts.
 */
export function mediaThumbnailJobId(mediaId: string): string {
  return `thumb:${mediaId}:v1`;
}

export const MEDIA_THUMBNAIL_JOB_OPTS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 2000 },
};

/**
 * Best-effort: a queue error never fails the upload that called it — the
 * worker's sweep picks the row up later.
 */
export async function enqueueMediaThumbnail(mediaId: string, organizationId: string): Promise<void> {
  try {
    await mediaProcessQueue.add(
      `media-thumbnail-${mediaId}`,
      { mediaId, organizationId, operation: "thumbnail" },
      { ...MEDIA_THUMBNAIL_JOB_OPTS, jobId: mediaThumbnailJobId(mediaId) }
    );
  } catch (err) {
    console.warn(`[thumbnail] enqueue failed for ${mediaId}:`, (err as Error).message);
  }
}
