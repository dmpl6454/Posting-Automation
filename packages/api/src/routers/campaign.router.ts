import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";

export const campaignRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.campaign.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input?.status ? { status: input.status } : {}),
        },
        include: {
          _count: { select: { campaignPosts: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  byId: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.campaign.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          campaignPosts: {
            include: {
              post: {
                select: {
                  id: true,
                  content: true,
                  status: true,
                  publishedAt: true,
                  targets: {
                    select: {
                      id: true,
                      status: true,
                      publishedUrl: true,
                      channel: { select: { platform: true, name: true, avatar: true } },
                    },
                  },
                  mediaAttachments: {
                    include: { media: { select: { url: true, thumbnailUrl: true } } },
                    take: 1,
                  },
                },
              },
            },
            orderBy: { createdAt: "desc" },
          },
        },
      });
    }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().optional(),
        hashtags: z.array(z.string()).default([]),
        trackingUrls: z.array(z.string()).default([]),
        targetChannels: z.array(z.string()).default([]),
        budget: z.number().optional(),
        currency: z.string().default("USD"),
        goalType: z.string().optional(),
        goalTarget: z.number().optional(),
        startDate: z.string().datetime().optional(),
        endDate: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.campaign.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          description: input.description,
          hashtags: input.hashtags,
          trackingUrls: input.trackingUrls,
          targetChannels: input.targetChannels,
          budget: input.budget,
          currency: input.currency,
          goalType: input.goalType,
          goalTarget: input.goalTarget,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          endDate: input.endDate ? new Date(input.endDate) : undefined,
        },
      });
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional(),
        hashtags: z.array(z.string()).optional(),
        trackingUrls: z.array(z.string()).optional(),
        targetChannels: z.array(z.string()).optional(),
        budget: z.number().optional(),
        goalType: z.string().optional(),
        goalTarget: z.number().optional(),
        startDate: z.string().datetime().optional(),
        endDate: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, startDate, endDate, ...rest } = input;
      return ctx.prisma.campaign.update({
        where: { id, organizationId: ctx.organizationId },
        data: {
          ...rest,
          ...(startDate !== undefined ? { startDate: new Date(startDate) } : {}),
          ...(endDate !== undefined ? { endDate: new Date(endDate) } : {}),
        },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.campaign.delete({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      return { success: true };
    }),

  addPost: orgProcedure
    .input(z.object({ campaignId: z.string(), postId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify both belong to org
      await ctx.prisma.campaign.findFirstOrThrow({
        where: { id: input.campaignId, organizationId: ctx.organizationId },
      });
      await ctx.prisma.post.findFirstOrThrow({
        where: { id: input.postId, organizationId: ctx.organizationId },
      });
      return ctx.prisma.campaignPost.create({
        data: { campaignId: input.campaignId, postId: input.postId },
      });
    }),

  removePost: orgProcedure
    .input(z.object({ campaignId: z.string(), postId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.campaignPost.delete({
        where: {
          campaignId_postId: {
            campaignId: input.campaignId,
            postId: input.postId,
          },
        },
      });
      return { success: true };
    }),

  metrics: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const campaign = await ctx.prisma.campaign.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
      });

      const campaignPosts = await ctx.prisma.campaignPost.findMany({
        where: { campaignId: input.id },
      });

      const totalImpressions = campaignPosts.reduce((s, p) => s + p.impressions, 0);
      const totalClicks = campaignPosts.reduce((s, p) => s + p.clicks, 0);
      const totalEngagements = campaignPosts.reduce((s, p) => s + p.engagements, 0);
      const totalReach = campaignPosts.reduce((s, p) => s + p.reach, 0);
      const totalSpend = campaignPosts.reduce((s, p) => s + p.spend, 0);
      const totalConversions = campaignPosts.reduce((s, p) => s + p.conversions, 0);

      const engagementRate = totalImpressions > 0
        ? (totalEngagements / totalImpressions) * 100
        : 0;

      const ctr = totalImpressions > 0
        ? (totalClicks / totalImpressions) * 100
        : 0;

      const roi = campaign.budget && campaign.budget > 0
        ? ((totalConversions * 10 - totalSpend) / campaign.budget) * 100 // simplified ROI
        : null;

      return {
        totalPosts: campaignPosts.length,
        totalImpressions,
        totalClicks,
        totalEngagements,
        totalReach,
        totalSpend,
        totalConversions,
        engagementRate,
        ctr,
        roi,
        budget: campaign.budget,
        goalType: campaign.goalType,
        goalTarget: campaign.goalTarget,
      };
    }),

  compare: orgProcedure
    .input(z.object({ ids: z.array(z.string()).min(2).max(5) }))
    .query(async ({ ctx, input }) => {
      const campaigns = await ctx.prisma.campaign.findMany({
        where: {
          id: { in: input.ids },
          organizationId: ctx.organizationId,
        },
        include: {
          _count: { select: { campaignPosts: true } },
        },
      });

      return campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        postCount: c._count.campaignPosts,
        totalImpressions: c.totalImpressions,
        totalClicks: c.totalClicks,
        totalEngagements: c.totalEngagements,
        totalReach: c.totalReach,
        totalSpend: c.totalSpend,
        budget: c.budget,
        startDate: c.startDate,
        endDate: c.endDate,
        engagementRate: c.totalImpressions > 0
          ? (c.totalEngagements / c.totalImpressions) * 100
          : 0,
      }));
    }),
});
