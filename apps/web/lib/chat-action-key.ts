/**
 * A1 idempotency: stable key used for BOTH the client-side executedActionIds
 * lock AND the clientActionId sent to the server (isActionAlreadyExecuted dedupes
 * on threadId+clientActionId for publish_now/schedule_post/bulk_schedule).
 *
 * Prefers the server-stamped idempotencyKey (stable across getThread refetches)
 * over the ephemeral message id (changes between optimistic/persisted states).
 *
 * Exported from this pure module (no React deps) so tests can import it directly,
 * and re-exported from ~/hooks/use-chat-stream for convenience.
 */
export function actionKey(msgId: string, idempotencyKey?: string): string {
  return idempotencyKey ?? msgId;
}
