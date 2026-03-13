import { createRouter, superAdminProcedure } from "../../trpc";
import { QUEUE_NAMES, createRedisConnection } from "@postautomation/queue";
import { Queue } from "bullmq";

export const adminOverviewRouter = createRouter({
  stats: superAdminProcedure.query(async ({ ctx }) => {
    const [
      userCount,
      orgCount,
      postsByStatus,
      channelCount,
      agentCount,
      recentAuditLogs,
    ] = await Promise.all([
      ctx.prisma.user.count({ where: { deletedAt: null } }),
      ctx.prisma.organization.count(),
      ctx.prisma.post.groupBy({
        by: ["status"],
        _count: { id: true },
      }),
      ctx.prisma.channel.count(),
      ctx.prisma.agent.count(),
      ctx.prisma.auditLog.findMany({
        take: 20,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { id: true, name: true, email: true } },
          organization: { select: { id: true, name: true } },
        },
      }),
    ]);

    // Queue health
    const connection = createRedisConnection();
    const queueHealth: Record<string, any> = {};

    try {
      for (const [key, name] of Object.entries(QUEUE_NAMES)) {
        const queue = new Queue(name, { connection });
        try {
          queueHealth[key] = await queue.getJobCounts();
        } catch {
          queueHealth[key] = { error: "Failed to get job counts" };
        } finally {
          await queue.close();
        }
      }
    } finally {
      await connection.quit();
    }

    return {
      users: userCount,
      organizations: orgCount,
      posts: Object.fromEntries(
        postsByStatus.map((g) => [g.status, g._count.id])
      ),
      channels: channelCount,
      agents: agentCount,
      recentAuditLogs,
      queueHealth,
    };
  }),
});
