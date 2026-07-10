export type TerminalRunStatus = "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";

/**
 * Derive a PipelineRun terminal status from its settled counts.
 * - all items failed (and at least one failed)  → FAILED
 * - some failed, some generated                  → COMPLETED_WITH_ERRORS
 * - none failed (incl. legit empty 0/0 run)      → COMPLETED
 */
export function deriveRunStatus(counts: { postsGenerated: number; postsFailed: number }): TerminalRunStatus {
  const { postsGenerated, postsFailed } = counts;
  if (postsFailed > 0 && postsGenerated === 0) return "FAILED";
  if (postsFailed > 0) return "COMPLETED_WITH_ERRORS";
  return "COMPLETED";
}
