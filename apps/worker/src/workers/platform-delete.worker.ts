import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, createRedisConnection, type PlatformDeleteJobData } from "@postautomation/queue";
import { getSocialProvider } from "@postautomation/social";
import { runPlatformDelete } from "../lib/platform-delete";

/**
 * Deletes a published post from Facebook / Instagram (2026-11-05). One job per
 * channel; see lib/platform-delete.ts. Concurrency 2: deletes count against the
 * same Meta app quota as publishing, and nothing here is urgent.
 */
export function createPlatformDeleteWorker() {
  const worker = new Worker<PlatformDeleteJobData>(
    QUEUE_NAMES.PLATFORM_DELETE,
    async (job: Job<PlatformDeleteJobData>) => {
      const attempts = job.opts.attempts ?? 1;
      const status = await runPlatformDelete(
        {
          prisma,
          deleteOnPlatform: (platform, tokens, platformPostId) =>
            (getSocialProvider(platform) as any).deletePublishedPost(tokens, platformPostId),
        },
        job.data.postTargetId,
        { finalAttempt: job.attemptsMade + 1 >= attempts }
      );
      console.log(`[PlatformDelete] target ${job.data.postTargetId} → ${status}`);
      return { status };
    },
    { connection: createRedisConnection(), concurrency: 2 }
  );
  worker.on("failed", (job, err) => {
    console.warn(`[PlatformDelete] job ${job?.id} attempt ${job?.attemptsMade} failed:`, err?.message ?? err);
  });
  return worker;
}
