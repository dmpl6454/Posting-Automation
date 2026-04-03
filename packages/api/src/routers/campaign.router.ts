import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";

export const campaignRouter = createRouter({
  // ==================== CAMPAIGNS ====================
  list: orgProcedure
    .input(z.object({ status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.campaign.findMany({
        where: { organizationId: ctx.organizationId, ...(input?.status ? { status: input.status } : {}) },
        include: {
          _count: { select: { campaignPosts: true, brandTrackers: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  byId: orgProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return ctx.prisma.campaign.findFirstOrThrow({
      where: { id: input.id, organizationId: ctx.organizationId },
      include: {
        brandTrackers: {
          include: { _count: { select: { contentItems: true } } },
          orderBy: { createdAt: "desc" },
        },
        _count: { select: { campaignPosts: true } },
      },
    });
  }),

  create: orgProcedure
    .input(z.object({
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      hashtags: z.array(z.string()).default([]),
      goalType: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.campaign.create({
        data: { organizationId: ctx.organizationId, ...input, status: "ACTIVE" },
      });
    }),

  update: orgProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().optional(),
      status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional(),
      hashtags: z.array(z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.prisma.campaign.update({ where: { id, organizationId: ctx.organizationId }, data });
    }),

  delete: orgProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.prisma.campaign.delete({ where: { id: input.id, organizationId: ctx.organizationId } });
    return { success: true };
  }),

  // ==================== BRAND TRACKERS ====================
  listBrands: orgProcedure
    .input(z.object({ campaignId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.brandTracker.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input?.campaignId ? { campaignId: input.campaignId } : {}),
        },
        include: { _count: { select: { contentItems: true } } },
        orderBy: { createdAt: "desc" },
      });
    }),

  createBrand: orgProcedure
    .input(z.object({
      brandName: z.string().min(1).max(200),
      description: z.string().optional(),
      campaignId: z.string().optional(),
      twitterHandle: z.string().optional(),
      instagramHandle: z.string().optional(),
      facebookPageId: z.string().optional(),
      linkedinHandle: z.string().optional(),
      tiktokHandle: z.string().optional(),
      youtubeHandle: z.string().optional(),
      websiteUrl: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.brandTracker.create({
        data: { organizationId: ctx.organizationId, ...input },
      });
    }),

  updateBrand: orgProcedure
    .input(z.object({
      id: z.string(),
      brandName: z.string().optional(),
      description: z.string().optional(),
      campaignId: z.string().nullable().optional(),
      twitterHandle: z.string().nullable().optional(),
      instagramHandle: z.string().nullable().optional(),
      facebookPageId: z.string().nullable().optional(),
      linkedinHandle: z.string().nullable().optional(),
      tiktokHandle: z.string().nullable().optional(),
      youtubeHandle: z.string().nullable().optional(),
      websiteUrl: z.string().nullable().optional(),
      isActive: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.prisma.brandTracker.update({
        where: { id, organizationId: ctx.organizationId },
        data,
      });
    }),

  deleteBrand: orgProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.prisma.brandTracker.delete({ where: { id: input.id, organizationId: ctx.organizationId } });
    return { success: true };
  }),

  // Brand content feed
  brandContent: orgProcedure
    .input(z.object({
      brandTrackerId: z.string().optional(),
      campaignId: z.string().optional(),
      limit: z.number().min(1).max(100).default(30),
    }))
    .query(async ({ ctx, input }) => {
      const where: any = {};
      if (input.brandTrackerId) {
        where.brandTrackerId = input.brandTrackerId;
      } else if (input.campaignId) {
        where.brandTracker = { campaignId: input.campaignId, organizationId: ctx.organizationId };
      } else {
        where.brandTracker = { organizationId: ctx.organizationId };
      }
      return ctx.prisma.brandContent.findMany({
        where,
        include: { brandTracker: { select: { brandName: true } } },
        orderBy: { publishedAt: "desc" },
        take: input.limit,
      });
    }),

  // ==================== INFLUENCER DISCOVERY ====================
  listInfluencers: orgProcedure
    .input(z.object({
      status: z.string().optional(),
      platform: z.string().optional(),
      minFollowers: z.number().optional(),
      sortBy: z.enum(["relevanceScore", "followers", "avgEngagement", "createdAt"]).default("relevanceScore"),
    }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.prisma.influencer.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input?.status ? { status: input.status } : {}),
          ...(input?.platform ? { platform: input.platform } : {}),
          ...(input?.minFollowers ? { followers: { gte: input.minFollowers } } : {}),
        },
        orderBy: { [input?.sortBy ?? "relevanceScore"]: "desc" },
        take: 100,
      });
    }),

  createInfluencer: orgProcedure
    .input(z.object({
      name: z.string().min(1),
      platform: z.string(),
      handle: z.string().min(1),
      profileUrl: z.string().optional(),
      bio: z.string().optional(),
      avatarUrl: z.string().optional(),
      followers: z.number().default(0),
      avgEngagement: z.number().default(0),
      niche: z.string().optional(),
      contactEmail: z.string().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.influencer.create({
        data: {
          organizationId: ctx.organizationId,
          ...input,
          discoveredFrom: "manual",
          relevanceScore: 50,
        },
      });
    }),

  updateInfluencer: orgProcedure
    .input(z.object({
      id: z.string(),
      status: z.string().optional(),
      notes: z.string().nullable().optional(),
      contactEmail: z.string().nullable().optional(),
      relevanceScore: z.number().optional(),
      lastContactedAt: z.string().datetime().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { id, lastContactedAt, ...data } = input;
      return ctx.prisma.influencer.update({
        where: { id },
        data: {
          ...data,
          ...(lastContactedAt ? { lastContactedAt: new Date(lastContactedAt) } : {}),
        },
      });
    }),

  deleteInfluencer: orgProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.prisma.influencer.delete({ where: { id: input.id } });
    return { success: true };
  }),

  // Influencer stats summary
  influencerStats: orgProcedure.query(async ({ ctx }) => {
    const [total, shortlisted, contacted, responded] = await Promise.all([
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId } }),
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId, status: "shortlisted" } }),
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId, status: "contacted" } }),
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId, status: { in: ["responded", "engaged"] } } }),
    ]);
    return { total, shortlisted, contacted, responded };
  }),
});
