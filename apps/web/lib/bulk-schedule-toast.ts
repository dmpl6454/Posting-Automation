export type BulkScheduleResult = {
  scheduled: number;
  skippedStories?: number;
  skippedPending?: number;
  skippedTikTok?: number;
};

/**
 * Toast for the Bulk tab's "Schedule". bulk.bulkSchedule skips-and-counts posts
 * it must not arm; every counted skip is named here, or it is a silent skip.
 */
export function bulkScheduleToast(result: BulkScheduleResult): { title: string; description: string } {
  const skippedStories = result.skippedStories ?? 0;
  const skippedPending = result.skippedPending ?? 0;
  const skippedTikTok = result.skippedTikTok ?? 0;

  let description =
    result.scheduled > 0 ? `${result.scheduled} post(s) scheduled successfully.` : "No posts were scheduled.";
  // A story needs exactly one image or video; those are skipped, not
  // silently scheduled to fail.
  if (skippedStories > 0) {
    description += ` ${skippedStories} Instagram stor${skippedStories === 1 ? "y was" : "ies were"} skipped — a story needs exactly one image or video.`;
  }
  // skippedPending covers a caption fan-out still running or held, and a
  // super-text burn still in flight.
  if (skippedPending > 0) {
    description += ` ${skippedPending} post(s) were skipped — unique captions or super text are still being prepared, or need your attention on the post page.`;
  }

  // A TikTok post needs its per-channel privacy chosen and exactly one video
  // (2026-10-28); the server will not arm it otherwise.
  if (skippedTikTok > 0) {
    description += ` ${skippedTikTok} TikTok post(s) were skipped — open them to choose who can see the video (and attach exactly one video).`;
  }

  return { title: result.scheduled > 0 ? "Scheduled" : "Nothing scheduled", description };
}
