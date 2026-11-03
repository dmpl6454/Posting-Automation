import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, createRedisConnection, type FirstCommentJobData } from "@postautomation/queue";
import { postScheduledFirstComment, abandonScheduledFirstComment } from "../lib/first-comment";
import { postCommentViaProvider, channelPageId } from "../lib/first-comment-poster";
import { buildPublishTokens } from "../lib/publish-tokens";

/**
 * Posts the automatic first comments of one published target once its delay
 * has passed (2026-11-03). The publish worker wrote `firstComment.status =
 * "scheduled"` and queued this job with the delay; this run claims
 * `scheduled → posting` atomically, so a duplicate job (a cron re-queue, a
 * restart) can never post twice. Single attempt — see firstCommentQueue.
 */
export async function runFirstCommentJob(postTargetId: string): Promise<void> {
  const target = await prisma.postTarget.findUnique({
    where: { id: postTargetId },
    select: {
      id: true,
      status: true,
      format: true,
      publishedId: true,
      channelId: true,
      post: { select: { metadata: true } },
    },
  });
  if (!target) return;
  if (target.status !== "PUBLISHED" || !target.publishedId) {
    await abandonScheduledFirstComment(prisma, target.id, "The post is no longer published, so the first comments weren't posted.");
    return;
  }

  // A DIRECT channel read — it is what decrypts the stored token.
  const channel = await prisma.channel.findUnique({ where: { id: target.channelId } });
  if (!channel || !channel.isActive || channel.disconnectedAt) {
    await abandonScheduledFirstComment(
      prisma,
      target.id,
      "The channel was paused or disconnected before the delay ended, so the first comments weren't posted."
    );
    return;
  }

  await postScheduledFirstComment(
    { prisma, comment: postCommentViaProvider },
    {
      platform: channel.platform,
      isStoryTarget: target.format === "STORY",
      postMetadata: target.post.metadata,
      targetId: target.id,
      targetMetadata: null,
      mediaId: target.publishedId,
      tokens: buildPublishTokens(channel.platform, channel.accessToken, channel.refreshToken ?? undefined, channel.metadata),
      pageId: channelPageId(channel),
    }
  );
}

export function createFirstCommentWorker() {
  const worker = new Worker<FirstCommentJobData>(
    QUEUE_NAMES.FIRST_COMMENT,
    async (job: Job<FirstCommentJobData>) => {
      await runFirstCommentJob(job.data.postTargetId);
    },
    { connection: createRedisConnection(), concurrency: 3 }
  );
  worker.on("failed", (job, err) => {
    console.error(`[FirstComment] job ${job?.id} failed:`, err?.message ?? err);
  });
  return worker;
}
