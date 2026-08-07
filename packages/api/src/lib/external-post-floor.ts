/**
 * The product floor for external-post ingestion: posts made directly on a connected
 * platform are collected from this instant onward, never earlier.
 *
 * Lives in ONE place because three call sites must agree or the UI lies:
 *   - the cron (`scheduleExternalPostSync`) that enqueues the periodic sweep,
 *   - `analytics.triggerSync` ("Sync Now"), which enqueues the same work on demand,
 *   - the Insights partial-coverage notice, which tells the user where coverage begins.
 *
 * If Sync Now used a different floor from the cron, a manual sync could pull in posts the
 * scheduled sweep never would (or vice versa), and the "included from 1 Aug 2026" copy
 * would stop being true.
 */
export const EXTERNAL_POST_FLOOR = new Date("2026-08-01T00:00:00.000Z");

/** Human-readable form of the floor, for UI copy. Keep in step with the constant. */
export const EXTERNAL_POST_FLOOR_LABEL = "1 Aug 2026";
