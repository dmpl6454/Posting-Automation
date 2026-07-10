/**
 * Decide the lead's terminal status from its message outcomes.
 * - still-pending messages (DRAFT/QUEUED/PENDING_MANUAL) → null (leave as-is)
 * - at least one real SENT → "SENT" (even if another channel failed)
 * - no pending, no real send, and a failure occurred → "FAILED"
 */
export function reconcileLeadStatus(x: {
  hasFailed: boolean;
  pendingCount: number;
  sentCount: number;
}): "SENT" | "FAILED" | null {
  if (x.pendingCount > 0) return null;
  if (x.sentCount > 0) return "SENT";
  if (x.hasFailed) return "FAILED";
  return null;
}
