/**
 * Send each publish report once (2026-10-01).
 *
 * sendPublishReportEmail runs from every job that finds all of a post's
 * targets in a final state — and nothing remembered a report had already gone
 * out. When several jobs exist for one target (left behind by a retry loop),
 * each one re-sent the same report: measured on prod, one 240-channel post
 * reported four times in 30 minutes.
 *
 * A report is identified by (post, round, outcome):
 *   - round   = Post.scheduledAt. Retry (publishNow), bulk schedule and
 *               reschedule all move it, so a new user-initiated round always
 *               gets its own report, even with an identical outcome. Leftover
 *               worker jobs never touch it.
 *   - outcome = every target's status + published link + "may already be
 *               live" flag. A channel that was reported failed and publishes
 *               later changes this, so a corrected report still goes out.
 *
 * ⚠️ The marker lives in Redis, NOT in Post.metadata: Post.metadata is spread
 * into every provider's publish payload (post-publish.worker.ts
 * providerMetadata), so a bookkeeping key there would reach Facebook,
 * Instagram & co. on the next retry.
 */
import { createHash } from "node:crypto";

export interface ReportTargetState {
  id: string;
  status: string;
  publishedUrl: string | null;
  ambiguousAt: Date | null;
}

export function publishReportFingerprint(input: {
  postId: string;
  scheduledAt: Date | null;
  targets: ReportTargetState[];
}): string {
  const targets = [...input.targets]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => [t.id, t.status, t.publishedUrl ?? null, t.ambiguousAt != null]);
  const canonical = JSON.stringify({
    post: input.postId,
    round: input.scheduledAt ? new Date(input.scheduledAt).toISOString() : null,
    targets,
  });
  return createHash("sha1").update(canonical).digest("hex");
}

/** Long enough to outlast any leftover retry (Facebook backoff tops out at 6h). */
export const PUBLISH_REPORT_DEDUPE_TTL_SECONDS = 14 * 24 * 60 * 60;

export function publishReportKey(postId: string, fingerprint: string): string {
  return `publish-report:${postId}:${fingerprint}`;
}

/**
 * Atomically claim the right to send this exact report. True = send it.
 *
 * Fails OPEN: if Redis errors, send anyway. A duplicate report is cheap; a
 * lost one is the incident (2026-09-29) this area exists to prevent.
 */
export async function claimPublishReport(
  redis: { set: (...args: any[]) => Promise<unknown> },
  postId: string,
  fingerprint: string
): Promise<boolean> {
  try {
    const res = await redis.set(publishReportKey(postId, fingerprint), "1", "EX", PUBLISH_REPORT_DEDUPE_TTL_SECONDS, "NX");
    return res === "OK";
  } catch (err: any) {
    console.warn(`[PostPublish] publish-report dedupe unavailable (sending anyway): ${err?.message}`);
    return true;
  }
}
