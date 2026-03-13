import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { QUEUE_NAMES, createRedisConnection } from "@postautomation/queue";
import { Queue } from "bullmq";

export const adminPostsRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
        status: z
          .enum([
            "DRAFT",
            "SCHEDULED",
            "PUBLISHING",
            "PUBLISHED",
            "FAILED",
            "CANCELLED",
          ])
          .optional(),
        platform: z.string().optional(),
        organizationId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, status, platform, organizationId } = input;

      const where: any = {};
      if (status) where.status = status;
      if (organizationId) where.organizationId = organizationId;
      if (platform) {
        where.targets = {
          some: { channel: { platform } },
        };
      }

      const items = await ctx.prisma.post.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        include: {
          organization: { select: { id: true, name: true } },
          targets: {
            include: {
              channel: {
                select: { id: true, name: true, platform: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        const next = items.pop()!;
        nextCursor = next.id;
      }

      return { items, nextCursor };
    }),

  getById: superAdminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findUnique({
        where: { id: input.id },
        include: {
          organization: { select: { id: true, name: true } },
          targets: {
            include: {
              channel: {
                select: { id: true, name: true, platform: true },
              },
            },
          },
          mediaAttachments: {
            include: { media: true },
          },
        },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });
      return post;
    }),

  retryFailed: superAdminProcedure
    .input(z.object({ postTargetId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const postTarget = await ctx.prisma.postTarget.findUnique({
        where: { id: input.postTargetId },
        include: { post: true },
      });
      if (!postTarget) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.prisma.postTarget.update({
        where: { id: input.postTargetId },
        data: { status: "QUEUED" as any },
      });

      const connection = createRedisConnection();
      const queue = new Queue(QUEUE_NAMES.POST_PUBLISH, { connection });
      try {
        await queue.add(
          "post-publish",
          {
            postId: postTarget.postId,
            postTargetId: postTarget.id,
            channelId: postTarget.channelId,
          },
          {
            attempts: 3,
            backoff: { type: "exponential", delay: 30000 },
          }
        );
      } finally {
        await queue.close();
        await connection.quit();
      }

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_POST_RETRIED,
        entityType: "PostTarget",
        entityId: input.postTargetId,
        metadata: { postId: postTarget.postId },
      }).catch(() => {});

      return { success: true };
    }),
});
