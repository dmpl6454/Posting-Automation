import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import {
  autopilotScheduleQueue,
  trendDiscoverQueue,
  createRedisConnection,
} from "@postautomation/queue";

export const autopilotRouter = createRouter({
  // Dashboard stats
  overview: orgProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [trendingCount, pendingReview, postsToday, latestRun] =
      await Promise.all([
        ctx.prisma.trendingItem.count({
          where: {
            organizationId: ctx.organizationId,
            status: { in: ["NEW", "SCORED"] },
            expiresAt: { gt: now },
          },
        }),
        ctx.prisma.autopilotPost.count({
          where: {
            organizationId: ctx.organizationId,
            status: "REVIEWING",
          },
        }),
        ctx.prisma.autopilotPost.count({
          where: {
            organizationId: ctx.organizationId,
            createdAt: { gte: todayMidnight },
          },
        }),
        ctx.prisma.pipelineRun.findFirst({
          where: { organizationId: ctx.organizationId },
          orderBy: { startedAt: "desc" },
        }),
      ]);

    return { trendingCount, pendingReview, postsToday, latestRun };
  }),

  // Paginated trending feed
  trendingItems: orgProcedure
    .input(
      z.object({
        status: z
          .enum([
            "NEW",
            "SCORED",
            "GENERATING",
            "GENERATED",
            "POSTED",
            "EXPIRED",
            "REJECTED",
          ])
          .optional(),
        topic: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = { organizationId: ctx.organizationId };
      if (input.status) where.status = input.status;
      if (input.topic) where.topics = { has: input.topic };

      const items = await ctx.prisma.trendingItem.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const next = items.pop();
        nextCursor = next?.id;
      }

      return { items, nextCursor };
    }),

  // Posts pending human review
  reviewQueue: orgProcedure
    .input(
      z.object({
        sensitivity: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = {
        organizationId: ctx.organizationId,
        status: "REVIEWING",
      };
      if (input.sensitivity) where.sensitivity = input.sensitivity;

      return ctx.prisma.autopilotPost.findMany({
        where,
        include: {
          trendingItem: true,
          agent: true,
          post: {
            include: { targets: true },
          },
        },
        orderBy: [{ sensitivity: "desc" }, { trendScore: "desc" }],
        take: input.limit,
      });
    }),

  // Approve a single post
  approvePost: orgProcedure
    .input(z.object({ autopilotPostId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.autopilotPost.findFirst({
        where: {
          id: input.autopilotPostId,
          organizationId: ctx.organizationId,
        },
      });
      if (!post) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Autopilot post not found",
        });
      }
      if (post.status !== "REVIEWING") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Post is not in REVIEWING status (current: ${post.status})`,
        });
      }

      const updated = await ctx.prisma.autopilotPost.update({
        where: { id: input.autopilotPostId },
        data: { status: "APPROVED" },
      });

      await autopilotScheduleQueue.add(
        `autopilot-schedule-${input.autopilotPostId}`,
        {
          autopilotPostId: input.autopilotPostId,
          organizationId: ctx.organizationId,
          pipelineRunId: "",
        }
      );

      return updated;
    }),

  // Reject a post with quota decrement
  rejectPost: orgProcedure
    .input(z.object({ autopilotPostId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.autopilotPost.findFirst({
        where: {
          id: input.autopilotPostId,
          organizationId: ctx.organizationId,
        },
      });
      if (!post) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Autopilot post not found",
        });
      }

      const updated = await ctx.prisma.autopilotPost.update({
        where: { id: input.autopilotPostId },
        data: { status: "REJECTED" },
      });

      // Decrement Redis quota counter
      const redis = createRedisConnection();
      const dateKey = new Date().toISOString().slice(0, 10);
      await redis.decr(`autopilot:quota:${post.agentId}:${dateKey}`);
      await redis.disconnect();

      return updated;
    }),

  // Bulk approve
  bulkApprove: orgProcedure
    .input(z.object({ autopilotPostIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      let approvedCount = 0;

      for (const autopilotPostId of input.autopilotPostIds) {
        const post = await ctx.prisma.autopilotPost.findFirst({
          where: {
            id: autopilotPostId,
            organizationId: ctx.organizationId,
            status: "REVIEWING",
          },
        });
        if (!post) continue;

        await ctx.prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: { status: "APPROVED" },
        });

        await autopilotScheduleQueue.add(
          `autopilot-schedule-${autopilotPostId}`,
          {
            autopilotPostId,
            organizationId: ctx.organizationId,
            pipelineRunId: "",
          }
        );

        approvedCount++;
      }

      return { approvedCount };
    }),

  // Bulk reject
  bulkReject: orgProcedure
    .input(z.object({ autopilotPostIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.prisma.autopilotPost.updateMany({
        where: {
          id: { in: input.autopilotPostIds },
          organizationId: ctx.organizationId,
        },
        data: { status: "REJECTED" },
      });

      return { rejectedCount: result.count };
    }),

  // Recent pipeline runs
  pipelineRuns: orgProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.pipelineRun.findMany({
        where: { organizationId: ctx.organizationId },
        orderBy: { startedAt: "desc" },
        take: input.limit,
      });
    }),

  // Autopilot-generated posts with performance stats
  posts: orgProcedure
    .input(
      z.object({
        status: z.string().optional(),
        skip: z.number().default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.post.findMany({
        where: {
          organizationId: ctx.organizationId,
          aiGenerated: true,
          ...(input.status
            ? { targets: { some: { status: input.status as any } } }
            : {}),
        },
        include: {
          targets: {
            include: {
              channel: { select: { id: true, platform: true, name: true } },
            },
          },
          autopilotPost: {
            include: {
              trendingItem: { select: { title: true, sourceUrl: true } },
              agent: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        skip: input.skip,
      });
    }),

  // Manual trigger
  triggerPipeline: orgProcedure.mutation(async ({ ctx }) => {
    const pipelineRun = await ctx.prisma.pipelineRun.create({
      data: {
        organizationId: ctx.organizationId,
        status: "RUNNING",
      },
    });

    await trendDiscoverQueue.add(`trend-discover-${pipelineRun.id}`, {
      organizationId: ctx.organizationId,
      pipelineRunId: pipelineRun.id,
    });

    return pipelineRun;
  }),
});
