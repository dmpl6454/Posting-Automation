/**
 * Analytics scheduling rules for Instagram STORIES (2026-09-15).
 *
 * An Instagram story disappears 24 hours after it is published, and Meta stops
 * serving its insights at the same moment. Every metric read after that is
 * wasted Graph quota at best; at worst it manufactures a failure that looks
 * like a broken channel.
 *
 * ── Why this lives in `packages/queue` ───────────────────────────────────────
 * The worker's cron passes AND the web container's `analytics.triggerSync`
 * ("Sync Now") both select published targets to measure. If only the crons knew
 * about story expiry, one click would re-enqueue every expired story in the org.
 * `insights-population.ts` and `external-post-floor.ts` live here for exactly the
 * same reason: a rule that both containers must agree on belongs in the package
 * they share.
 */

/** How long an Instagram story — and its insights — remain available. */
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * When the story's single at-age checkpoint fires.
 *
 * ⚠️ 23h, NOT 24h. The delay is measured from the moment the publish worker
 * enqueues the job, which is already seconds-to-minutes after Meta's own
 * creation timestamp — so a 24h delay lands strictly AFTER expiry, every time.
 * The capture would then fail, and because at-age jobs rethrow (they are
 * one-shot), it would burn all three BullMQ attempts and still never produce a
 * `windowTag` snapshot. An hour early is a real reading; an hour late is none.
 *
 * It keeps the `24h` TAG so Reports' "at publish-age" window selector, the
 * checkpoint-reconciliation bookkeeping and the stored `metadata.windowTag` all
 * keep their existing vocabulary.
 */
export const STORY_CHECKPOINT_DELAY_MS = 23 * 60 * 60 * 1000;

/** The at-age checkpoints, in enqueue order: [windowTag, delay from publish]. */
export const AT_AGE_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ["24h", 86_400_000],
  ["7d", 604_800_000],
  ["15d", 1_296_000_000],
  ["30d", 2_592_000_000],
];

export function isStoryTargetFormat(format: string | null | undefined): boolean {
  return String(format ?? "").toUpperCase() === "STORY";
}

/**
 * Which at-age checkpoints a target gets, and when.
 *
 * A story gets exactly one, an hour before it expires. Every other format keeps
 * the four it has always had, with byte-identical delays.
 */
export function atAgeWindowsForFormat(format: string | null | undefined): Array<[string, number]> {
  if (isStoryTargetFormat(format)) return [["24h", STORY_CHECKPOINT_DELAY_MS]];
  return AT_AGE_WINDOWS.map(([tag, ms]) => [tag, ms] as [string, number]);
}

/**
 * May the daily sweep re-enqueue MISSING at-age checkpoints for this target?
 *
 * Never for a story: that sweep only fires once a checkpoint is overdue by more
 * than the grace period, which for a story is always after it has expired. It
 * would re-enqueue a guaranteed-failing job every day until the 45-day floor.
 */
export function shouldReconcileCheckpoints(format: string | null | undefined): boolean {
  return !isStoryTargetFormat(format);
}

/**
 * Prisma `where` fragment: keep every target EXCEPT a story whose 24 hours are up.
 *
 * ⚠️ The obvious `NOT: { format: "STORY", publishedAt: { lt: cutoff } }` is a NULL
 * TRAP. `PostTarget.format` is nullable and virtually every existing row has
 * `format IS NULL` (post.create writes `?? null`), and in SQL a NOT over a
 * comparison with NULL yields NULL — which excludes the row. That single
 * predicate would silently drop EVERY legacy target out of both analytics
 * passes, with no error, and tsc cannot see it (same class as the
 * `metaAppId IN (NULL, 'a')` and `where: { id: undefined }` traps).
 *
 * So the NULL case is stated explicitly, as its own OR branch.
 */
export function excludeExpiredStoriesWhere(now: Date): {
  OR: Array<Record<string, unknown>>;
} {
  const cutoff = new Date(now.getTime() - STORY_LIFETIME_MS);
  return {
    OR: [
      // Legacy / ordinary targets: no format recorded at all.
      { format: null },
      // Any non-story format.
      { format: { not: "STORY" } },
      // A story still inside its 24h life.
      { format: "STORY", publishedAt: { gte: cutoff } },
    ],
  };
}
