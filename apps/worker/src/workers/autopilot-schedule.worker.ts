import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  postPublishQueue,
  type AutopilotScheduleJobData,
  createRedisConnection,
} from "@postautomation/queue";

// ---------------------------------------------------------------------------
// Schedule slot presets by postsPerDay
// ---------------------------------------------------------------------------

const SLOT_MAP: Record<number, number[]> = {
  1: [10],
  2: [9, 17],
  3: [9, 13, 18],
  4: [8, 11, 15, 19],
  5: [8, 10, 13, 16, 19],
};

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createAutopilotScheduleWorker() {
  const worker = new Worker<AutopilotScheduleJobData>(
    QUEUE_NAMES.AUTOPILOT_SCHEDULE,
    async (job: Job<AutopilotScheduleJobData>) => {
      const { autopilotPostId, organizationId, pipelineRunId } = job.data;
      console.log(
        `[AutopilotSchedule] Processing job ${job.id} for autopilotPost ${autopilotPostId}`,
      );

      try {
        // 1. Fetch AutopilotPost with agent (include accountGroup), post (include targets with channel)
        const autopilotPost = await prisma.autopilotPost.findUnique({
          where: { id: autopilotPostId },
          include: {
            agent: { include: { accountGroup: true } },
            post: { include: { targets: { include: { channel: true } } } },
          },
        });

        // 2. Skip if not found, no post, or status !== "APPROVED"
        if (!autopilotPost) {
          console.log(
            `[AutopilotSchedule] AutopilotPost ${autopilotPostId} not found, skipping`,
          );
          return { skipped: true, reason: "not_found" };
        }

        if (!autopilotPost.post) {
          console.log(
            `[AutopilotSchedule] AutopilotPost ${autopilotPostId} has no post, skipping`,
          );
          return { skipped: true, reason: "no_post" };
        }

        if (autopilotPost.status !== "APPROVED") {
          console.log(
            `[AutopilotSchedule] AutopilotPost ${autopilotPostId} status is ${autopilotPost.status}, skipping`,
          );
          return { skipped: true, reason: "not_approved" };
        }

        const { agent, post } = autopilotPost;

        // 3. Get postsPerDay and timezone from accountGroup (or agent defaults)
        const postsPerDay = agent.accountGroup?.postsPerDay ?? agent.postsPerDay ?? 3;
        const timezone = agent.accountGroup?.timezone ?? "UTC";

        // 4. Find today's already scheduled posts for this agent's channels
        const now = new Date();
        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(now);
        todayEnd.setHours(23, 59, 59, 999);

        const alreadyScheduled = await prisma.post.findMany({
          where: {
            status: "SCHEDULED",
            scheduledAt: {
              gte: todayStart,
              lte: todayEnd,
            },
            targets: {
              some: {
                channelId: { in: agent.channelIds },
              },
            },
          },
          select: { scheduledAt: true },
        });

        const usedHours = new Set(
          alreadyScheduled
            .filter((p) => p.scheduledAt)
            .map((p) => p.scheduledAt!.getHours()),
        );

        // 5. Calculate schedule slots based on postsPerDay
        const slots = SLOT_MAP[postsPerDay] ?? SLOT_MAP[3]!;
        const currentHour = now.getHours();

        // 6. Pick next available slot (not used, after current hour)
        let scheduledAt: Date;
        const availableSlot = slots.find(
          (hour) => hour > currentHour && !usedHours.has(hour),
        );

        if (availableSlot !== undefined) {
          // Schedule for today at available slot
          scheduledAt = new Date(now);
          scheduledAt.setHours(availableSlot, 0, 0, 0);
        } else {
          // All today's slots used — schedule for tomorrow's first slot
          scheduledAt = new Date(now);
          scheduledAt.setDate(scheduledAt.getDate() + 1);
          scheduledAt.setHours(slots[0]!, 0, 0, 0);
        }

        // Add random 0-30 minute offset for staggering
        const randomOffset = Math.floor(Math.random() * 31);
        scheduledAt.setMinutes(randomOffset);

        // 7. Update Post to SCHEDULED with scheduledAt
        await prisma.post.update({
          where: { id: post.id },
          data: {
            status: "SCHEDULED",
            scheduledAt,
          },
        });

        // 8. Update PostTargets to SCHEDULED
        await prisma.postTarget.updateMany({
          where: { postId: post.id },
          data: { status: "SCHEDULED" },
        });

        // 9. Queue POST_PUBLISH jobs for each target with delay = scheduledAt - now
        const delayMs = Math.max(scheduledAt.getTime() - Date.now(), 0);

        for (const target of post.targets) {
          if (!target.channel) continue;

          await postPublishQueue.add(
            `publish-${target.id}`,
            {
              postId: post.id,
              postTargetId: target.id,
              channelId: target.channelId,
              platform: target.channel.platform,
              organizationId,
            },
            {
              delay: delayMs,
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );
        }

        // 10. Update AutopilotPost status to SCHEDULED
        await prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: { status: "SCHEDULED" },
        });

        // 11. Update PipelineRun postsScheduled counter
        await prisma.pipelineRun.update({
          where: { id: pipelineRunId },
          data: {
            postsScheduled: { increment: 1 },
          },
        });

        console.log(
          `[AutopilotSchedule] Done. Post ${post.id} scheduled at ${scheduledAt.toISOString()} for autopilotPost ${autopilotPostId}`,
        );

        return {
          postId: post.id,
          autopilotPostId,
          scheduledAt: scheduledAt.toISOString(),
          targetCount: post.targets.length,
        };
      } catch (error: any) {
        console.error(
          `[AutopilotSchedule] Job ${job.id} processing error:`,
          error.message,
        );

        try {
          await prisma.autopilotPost.update({
            where: { id: autopilotPostId },
            data: {
              status: "FAILED",
              errorMessage:
                error.message?.slice(0, 2000) || "Unknown scheduling error",
            },
          });
        } catch (updateErr) {
          console.error(
            `[AutopilotSchedule] Failed to update error status:`,
            updateErr,
          );
        }

        throw error;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[AutopilotSchedule] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[AutopilotSchedule] Job ${job.id} completed`);
  });

  return worker;
}
