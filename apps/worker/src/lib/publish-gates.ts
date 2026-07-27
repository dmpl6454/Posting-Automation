/**
 * Publish gates — features that park a post as DRAFT while async work runs
 * before it may publish:
 *   • captionFanout  — per-channel AI captions (PostTarget.contentOverride)
 *   • superText      — burning the text strip into the video
 *
 * Each worker clears ITS OWN flag and then calls flipParkedPostIfReady, which
 * flips DRAFT→SCHEDULED only when NO gate remains. Both sides re-check from a
 * FRESH read after their own write, so two gates finishing simultaneously can
 * never strand the post in DRAFT; a duplicate flip is idempotent (it converges on
 * the same state, and the guard makes the second call a no-op).
 */

export function pendingPublishGates(meta: Record<string, any> | null | undefined): string[] {
  const gates: string[] = [];
  if (meta?.captionFanout?.pendingSchedule === true) gates.push("captionFanout");
  if (meta?.superText?.pendingBurn === true) gates.push("superText");
  return gates;
}

/**
 * Did ANY gate park this post's schedule? Guards against flipping a post that was
 * always meant to stay a plain draft (no scheduledAt, user saved it for later).
 */
export function wasParkedForSchedule(meta: Record<string, any> | null | undefined): boolean {
  return meta?.captionFanout?.requested === true || meta?.superText?.parkedSchedule === true;
}

type GateFlipPrisma = {
  post: { findFirst: (args: any) => Promise<any>; update: (args: any) => Promise<any> };
  postTarget: { updateMany: (args: any) => Promise<any> };
};

/**
 * Flip a parked post DRAFT→SCHEDULED when every gate is clear. Org-scoped.
 * Returns true only when THIS call performed the flip.
 */
export async function flipParkedPostIfReady(
  prisma: GateFlipPrisma,
  postId: string,
  organizationId: string
): Promise<boolean> {
  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, status: true, scheduledAt: true, metadata: true },
  });
  if (!post || post.status !== "DRAFT" || !post.scheduledAt) return false;

  const meta = (post.metadata ?? {}) as Record<string, any>;
  if (pendingPublishGates(meta).length > 0) return false;
  if (!wasParkedForSchedule(meta)) return false;

  // Targets first, then the post — same order as caption-fanout's original flip,
  // so the publish cron never sees a SCHEDULED post with DRAFT targets (which
  // would enqueue zero jobs; exactly the bulkSchedule bug class).
  await prisma.postTarget.updateMany({
    where: { postId, status: "DRAFT" },
    data: { status: "SCHEDULED" },
  });
  await prisma.post.update({ where: { id: postId }, data: { status: "SCHEDULED" } });
  return true;
}
