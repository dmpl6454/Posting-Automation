import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { QUEUE_NAMES, createRedisConnection } from "@postautomation/queue";
import { Queue } from "bullmq";

export const adminQueuesRouter = createRouter({
  stats: superAdminProcedure.query(async () => {
    const connection = createRedisConnection();
    const results: Record<string, any> = {};

    try {
      for (const [key, name] of Object.entries(QUEUE_NAMES)) {
        const queue = new Queue(name, { connection });
        try {
          results[key] = await queue.getJobCounts();
        } catch {
          results[key] = { error: "Failed to get job counts" };
        } finally {
          await queue.close();
        }
      }
    } finally {
      await connection.quit();
    }

    return results;
  }),

  failedJobs: superAdminProcedure
    .input(
      z.object({
        queueName: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input }) => {
      const connection = createRedisConnection();
      const failed: any[] = [];

      try {
        const queuesToCheck = input.queueName
          ? [[input.queueName, input.queueName] as const]
          : Object.entries(QUEUE_NAMES);

        for (const [key, name] of queuesToCheck) {
          const queue = new Queue(name, { connection });
          try {
            const jobs = await queue.getFailed(0, input.limit);
            for (const job of jobs) {
              failed.push({
                id: job.id,
                queue: key,
                queueName: name,
                data: job.data,
                failedReason: job.failedReason,
                attemptsMade: job.attemptsMade,
                timestamp: job.timestamp,
                finishedOn: job.finishedOn,
                processedOn: job.processedOn,
              });
            }
          } finally {
            await queue.close();
          }
        }
      } finally {
        await connection.quit();
      }

      return failed;
    }),

  retryJob: superAdminProcedure
    .input(z.object({ queueName: z.string(), jobId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const connection = createRedisConnection();
      const queue = new Queue(input.queueName, { connection });

      try {
        const job = await queue.getJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
        await job.retry();
      } finally {
        await queue.close();
        await connection.quit();
      }

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_QUEUE_JOB_RETRIED,
        entityType: "QueueJob",
        entityId: input.jobId,
        metadata: { queueName: input.queueName },
      }).catch(() => {});

      return { success: true };
    }),

  deleteJob: superAdminProcedure
    .input(z.object({ queueName: z.string(), jobId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const connection = createRedisConnection();
      const queue = new Queue(input.queueName, { connection });

      try {
        const job = await queue.getJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Job not found" });
        await job.remove();
      } finally {
        await queue.close();
        await connection.quit();
      }

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_QUEUE_JOB_DELETED,
        entityType: "QueueJob",
        entityId: input.jobId,
        metadata: { queueName: input.queueName },
      }).catch(() => {});

      return { success: true };
    }),
});
