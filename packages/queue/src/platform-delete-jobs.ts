/**
 * Job ids for "delete from platform" (2026-11-05). Exactly THREE colon
 * segments (BullMQ rejects other counts). Each request gets its own id so a
 * re-request after a failure is never swallowed by BullMQ's dedupe — the
 * database claim on PostTarget.metadata.platformDelete is what prevents two
 * runs for one target.
 */
export function platformDeleteJobId(postTargetId: string, requestedAtMs: number): string {
  return `pdelete:${postTargetId}:${Math.floor(requestedAtMs)}`;
}

/** Gap between consecutive deletes of one request — spreads them across the Meta app quota. */
export const PLATFORM_DELETE_SPACING_MS = 1_500;
