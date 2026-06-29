import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { requirePlan } from "../middleware/plan-limit.middleware";

// Campaigns (incl. brand trackers + influencer discovery) are a PROFESSIONAL+
// feature. M23 fix: previously only `list` gated this — every sibling query and
// mutation was reachable directly, so a FREE org could bypass the gate. Every
// data-touching procedure now calls this on its first line. Dormant under
// BILLING_DISABLED (requirePlan returns early), exactly like the other gates.
function gateCampaigns(ctx: { organizationId: string; isSuperAdmin: boolean }) {
  return requirePlan(ctx.organizationId, "PROFESSIONAL", "Campaigns", ctx.isSuperAdmin);
}

export const campaignRouter = createRouter({
  // ==================== CAMPAIGNS ====================
  list: orgProcedure
    .input(z.object({ status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      await gateCampaigns(ctx);
      const campaigns = await ctx.prisma.campaign.findMany({
        where: { organizationId: ctx.organizationId, ...(input?.status ? { status: input.status } : {}) },
        include: {
          // brandTrackers selected (id + isActive only) so the UI can derive the
          // campaign-level "Monitoring" toggle: ON when ANY tracker is active.
          // This is the HONEST replacement for the old ACTIVE/PAUSED status —
          // a tracker's isActive is what the brand-content-sync cron actually
          // reads, so the toggle reflects real background work (not a fake state).
          brandTrackers: { select: { id: true, isActive: true } },
          _count: { select: { campaignPosts: true, brandTrackers: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      // Derive monitoring counts per campaign (active vs total trackers).
      return campaigns.map((c) => {
        const totalTrackers = c.brandTrackers.length;
        const activeTrackers = c.brandTrackers.filter((t) => t.isActive).length;
        const { brandTrackers, ...rest } = c;
        return { ...rest, totalTrackers, activeTrackers, monitoring: activeTrackers > 0 };
      });
    }),

  byId: orgProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
      const { id, ...data } = input;
      return ctx.prisma.campaign.update({ where: { id, organizationId: ctx.organizationId }, data });
    }),

  // Toggle monitoring for a campaign. HONEST replacement for the old fake
  // ACTIVE/PAUSED play-pause: this flips isActive on EVERY brand tracker in the
  // campaign, which is exactly what the brand-content-sync cron reads
  // (`brandTracker.findMany({ where: { isActive: true } })`). ON = the campaign's
  // brands are fetched for new content every ~6h; OFF = paused. Org-scoped via
  // the campaignId+organizationId filter on updateMany (IDOR-safe).
  setMonitoring: orgProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await gateCampaigns(ctx);
      // Confirm the campaign belongs to the acting org (throws if not) before any write.
      await ctx.prisma.campaign.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      const result = await ctx.prisma.brandTracker.updateMany({
        where: { campaignId: input.id, organizationId: ctx.organizationId },
        data: { isActive: input.enabled },
      });
      return { count: result.count, enabled: input.enabled };
    }),

  delete: orgProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await gateCampaigns(ctx);
    await ctx.prisma.campaign.delete({ where: { id: input.id, organizationId: ctx.organizationId } });
    return { success: true };
  }),

  // ==================== BRAND TRACKERS ====================
  listBrands: orgProcedure
    .input(z.object({ campaignId: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
      const { id, ...data } = input;
      return ctx.prisma.brandTracker.update({
        where: { id, organizationId: ctx.organizationId },
        data,
      });
    }),

  deleteBrand: orgProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
      const where: any = {};
      if (input.brandTrackerId) {
        // IDOR fix (audit 2026-06-19 / M22): scope the supplied brandTrackerId to
        // a tracker owned by the acting org (the campaignId/default branches
        // already scope via brandTracker.organizationId).
        where.brandTrackerId = input.brandTrackerId;
        where.brandTracker = { organizationId: ctx.organizationId };
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
      await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
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
      await gateCampaigns(ctx);
      const { id, lastContactedAt, ...data } = input;
      const result = await ctx.prisma.influencer.updateMany({
        where: { id, organizationId: ctx.organizationId },
        data: {
          ...data,
          ...(lastContactedAt ? { lastContactedAt: new Date(lastContactedAt) } : {}),
        },
      });
      if (result.count === 0) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.prisma.influencer.findFirstOrThrow({ where: { id, organizationId: ctx.organizationId } });
    }),

  deleteInfluencer: orgProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await gateCampaigns(ctx);
    const result = await ctx.prisma.influencer.deleteMany({ where: { id: input.id, organizationId: ctx.organizationId } });
    if (result.count === 0) throw new TRPCError({ code: "NOT_FOUND" });
    return { success: true };
  }),

  // Influencer stats summary
  influencerStats: orgProcedure.query(async ({ ctx }) => {
    await gateCampaigns(ctx);
    const [total, shortlisted, contacted, responded] = await Promise.all([
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId } }),
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId, status: "shortlisted" } }),
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId, status: "contacted" } }),
      ctx.prisma.influencer.count({ where: { organizationId: ctx.organizationId, status: { in: ["responded", "engaged"] } } }),
    ]);
    return { total, shortlisted, contacted, responded };
  }),
});
