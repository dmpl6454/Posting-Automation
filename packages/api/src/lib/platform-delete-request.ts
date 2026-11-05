import {
  claimTargetsForPlatformDelete,
  isPlatformDeleteInFlight,
  platformDeleteJobId,
  platformDeleteQueue,
  readPlatformDeleteRecord,
  updatePlatformDeleteRecord,
  PLATFORM_DELETE_SPACING_MS,
} from "@postautomation/queue";
import { createAuditLog, AUDIT_ACTIONS } from "./audit";

/**
 * Queues "delete this post from Facebook / Instagram" for the PUBLISHED targets
 * of the given posts (2026-11-05). Shared by post.deleteFromPlatforms (one post,
 * optionally some channels) and bulk.deleteFromPlatforms (many posts).
 *
 * Only posts PostAutomation published, in the caller's organization, on Facebook
 * or Instagram. Nothing is deleted here: each claimed target gets one job, spaced
 * PLATFORM_DELETE_SPACING_MS apart, and the worker does the Graph call.
 */

/** Hard cap per request — one request can otherwise be thousands of Graph calls. */
export const PLATFORM_DELETE_MAX_TARGETS = 1000;

const SUPPORTED = new Set(["FACEBOOK", "INSTAGRAM"]);

export interface PlatformDeleteRequestSummary {
  queued: number;
  /** Not published (draft, failed, scheduled…) — there is nothing on the platform. */
  notPublished: number;
  /** A platform we can't delete on (X, YouTube, TikTok…). */
  unsupported: number;
  alreadyDeleted: number;
  inProgress: number;
  /** Over PLATFORM_DELETE_MAX_TARGETS — ask again to continue. */
  overLimit: number;
}

type TargetRow = {
  id: string;
  status: string;
  publishedId: string | null;
  platformDeletedAt: Date | null;
  metadata: unknown;
  channel: { platform: string };
};

export function planPlatformDeleteRequest(
  targets: TargetRow[],
  now: Date
): { eligible: string[]; summary: PlatformDeleteRequestSummary } {
  const summary: PlatformDeleteRequestSummary = {
    queued: 0,
    notPublished: 0,
    unsupported: 0,
    alreadyDeleted: 0,
    inProgress: 0,
    overLimit: 0,
  };
  const eligible: string[] = [];
  for (const t of targets) {
    if (!SUPPORTED.has(t.channel.platform)) summary.unsupported++;
    else if (t.status !== "PUBLISHED" || !t.publishedId) summary.notPublished++;
    else if (t.platformDeletedAt) summary.alreadyDeleted++;
    else if (isPlatformDeleteInFlight(readPlatformDeleteRecord(t.metadata), now)) summary.inProgress++;
    else if (eligible.length >= PLATFORM_DELETE_MAX_TARGETS) summary.overLimit++;
    else eligible.push(t.id);
  }
  return { eligible, summary };
}

export async function requestPlatformDeletion(
  prisma: any,
  input: { organizationId: string; userId: string | null; postIds: string[]; targetIds?: string[] },
  deps: { now?: () => Date; queue?: { add: (...args: any[]) => Promise<unknown> } } = {}
): Promise<PlatformDeleteRequestSummary> {
  const now = deps.now?.() ?? new Date();
  const queue = deps.queue ?? platformDeleteQueue;

  const targets: TargetRow[] = await prisma.postTarget.findMany({
    where: {
      // 🔒 Org scope comes from the PARENT post — the only thing that proves ownership.
      post: { id: { in: input.postIds }, organizationId: input.organizationId },
      ...(input.targetIds ? { id: { in: input.targetIds } } : {}),
    },
    select: {
      id: true,
      status: true,
      publishedId: true,
      platformDeletedAt: true,
      metadata: true,
      channel: { select: { platform: true } },
    },
    orderBy: { publishedAt: "asc" },
  });

  const { eligible, summary } = planPlatformDeleteRequest(targets, now);

  // The claim is the real guard: two simultaneous requests queue a target once.
  const claimed = await claimTargetsForPlatformDelete(prisma, eligible, {
    requestedAt: now,
    requestedBy: input.userId,
  });
  summary.inProgress += eligible.length - claimed.length;

  let queued = 0;
  for (let i = 0; i < claimed.length; i++) {
    const id = claimed[i]!;
    try {
      await queue.add(
        "platform-delete",
        { postTargetId: id },
        { jobId: platformDeleteJobId(id, now.getTime()), delay: i * PLATFORM_DELETE_SPACING_MS }
      );
      queued++;
    } catch (err: any) {
      console.error(`[PlatformDelete] could not queue ${id}:`, err?.message ?? err);
      await updatePlatformDeleteRecord(
        prisma,
        id,
        { status: "failed", message: "Couldn't start the delete. Try again.", finishedAt: new Date().toISOString() },
        { onlyIfStatus: ["queued"] }
      ).catch(() => {});
    }
  }
  summary.queued = queued;

  if (queued > 0) {
    createAuditLog({
      organizationId: input.organizationId,
      userId: input.userId ?? undefined,
      action: AUDIT_ACTIONS.POST_PLATFORM_DELETE_REQUESTED,
      entityType: "Post",
      entityId: input.postIds.length === 1 ? input.postIds[0]! : "bulk",
      metadata: { postIds: input.postIds.slice(0, 100), targets: queued },
    }).catch(() => {});
  }

  return summary;
}
