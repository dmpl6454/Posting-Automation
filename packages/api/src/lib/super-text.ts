import type { SuperTextConfig, SuperTextMap } from "@postautomation/super-text";

/**
 * Super text — shared planning helper for post.create (mirrors planCaptionFanout).
 *
 * Decision: the strip is burned ONCE into a derived video, not per publish target.
 * The post is parked as DRAFT (the publish cron only picks SCHEDULED) while ONE
 * super-text job renders + composites + repoints PostMedia; the worker then flips
 * DRAFT→SCHEDULED. Because the burn produces an ordinary video Media row, the
 * frozen IG/FB publish paths, media-optimize, streaming uploads and the watchdog
 * all keep working unchanged.
 *
 * Pure + exported so the matrix can be locked without a tRPC caller harness.
 */

/**
 * Source-size ceiling for a burn. Matches OPTIMIZE_SIZE_BYTES (950MB) in
 * apps/worker/src/lib/media-optimize.ts: past that the file is already in
 * rendition territory and a full re-encode on the 4-core prod box is not
 * something to kick off behind a "Schedule" click. Enforced at CREATE with an
 * actionable message, and re-checked in the worker.
 */
export const SUPER_TEXT_MAX_SOURCE_BYTES = 950 * 1024 * 1024;

export interface SuperTextPlan {
  /** At least one attached video actually has a burnable config. */
  enabled: boolean;
  /** The post WOULD have been SCHEDULED, so the worker owns the flip. */
  parkedSchedule: boolean;
  /** Only the configs that survived validation (video + attached + in size budget). */
  byMediaId: Record<string, SuperTextConfig>;
  /** Attached videos whose config was dropped for exceeding the size cap. */
  oversized: string[];
}

export function planSuperText(input: {
  superText: SuperTextMap | undefined | null;
  mediaRows: { id: string; fileType: string; fileSize: number }[];
  scheduledAt: string | Date | null | undefined;
}): SuperTextPlan {
  const byMediaId: Record<string, SuperTextConfig> = {};
  const oversized: string[] = [];

  if (input.superText) {
    for (const row of input.mediaRows) {
      const cfg = input.superText[row.id];
      // Ignore configs for media that is not attached to THIS post, and for
      // images (the strip is a video feature — an image already has the media
      // editor). Both are silently skipped, never an error.
      if (!cfg || !row.fileType.startsWith("video/")) continue;
      if (row.fileSize > SUPER_TEXT_MAX_SOURCE_BYTES) {
        oversized.push(row.id);
        continue;
      }
      byMediaId[row.id] = cfg;
    }
  }

  const enabled = Object.keys(byMediaId).length > 0;
  return {
    enabled,
    // A plain draft just gets its strip burned; only a would-be-SCHEDULED post
    // needs the worker's DRAFT→SCHEDULED flip.
    parkedSchedule: enabled && input.scheduledAt != null,
    byMediaId,
    oversized,
  };
}

/**
 * jobId for the single per-post burn job (dedupes re-submits).
 *
 * ⚠️ EXACTLY 3 colon-separated segments. BullMQ >=5.70 throws
 * "Custom Id cannot contain :" for a custom jobId containing colons that does not
 * split into exactly 3 parts — the same trap that broke caption-fanout
 * (`caption-fanout:{postId}`) and the at-age analytics ids. Mirrors the shape of
 * the media-optimize id (`optimize:{mediaId}:v1`).
 */
export function superTextJobId(postId: string): string {
  return `supertext:${postId}:v1`;
}
