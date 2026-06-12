import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { rssSyncQueue } from "@postautomation/queue";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

// SECURITY: every mutation/query is org-scoped via `orgProcedure`. Each
// lookup adds `organizationId: ctx.organizationId` so a user from org A
// cannot read/modify org B's RSS feeds (previously this was vulnerable —
// `findUnique({ where: { id } })` without org scope = IDOR).

export const rssRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    const feeds = await ctx.prisma.rssFeed.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        _count: { select: { entries: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return feeds;
  }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        url: z.string().url(),
        checkInterval: z.number().min(5).max(1440).default(60),
        autoPost: z.boolean().default(false),
        targetChannels: z.array(z.string()).default([]),
        promptTemplate: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Fix #42/#43: validate that the URL actually returns an RSS/Atom feed
      try {
        const res = await fetch(input.url, {
          method: "GET",
          signal: AbortSignal.timeout(5000),
          redirect: "follow",
          headers: { "User-Agent": "PostAutomation-RSS-Validator/1.0" },
        });
        if (!res.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Feed URL responded with HTTP ${res.status}. Please check the URL.`,
          });
        }
        const text = await res.text();
        if (!/<(rss|feed|channel)\b/i.test(text)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "URL does not appear to be a valid RSS or Atom feed.",
          });
        }
      } catch (err: any) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not reach the feed URL. Please check it is publicly accessible.",
        });
      }

      // Validate every target channel belongs to the caller's org (worker writes
      // these straight into PostTarget.channelId with no re-check).
      if (input.targetChannels.length > 0) {
        const owned = await ctx.prisma.channel.findMany({
          where: { id: { in: input.targetChannels }, organizationId: ctx.organizationId },
          select: { id: true },
        });
        if (owned.length !== new Set(input.targetChannels).size) {
          const ownedSet = new Set(owned.map((c) => c.id));
          const invalid = input.targetChannels.filter((id) => !ownedSet.has(id));
          throw new TRPCError({ code: "FORBIDDEN", message: `Channels not in this organization: ${invalid.join(", ")}` });
        }
      }

      const feed = await ctx.prisma.rssFeed.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          url: input.url,
          checkInterval: input.checkInterval,
          autoPost: input.autoPost,
          targetChannels: input.targetChannels,
          promptTemplate: input.promptTemplate,
        },
      });

      // Kick off an initial sync so the feed isn't empty until the next cron tick.
      await rssSyncQueue.add(
        `rss-sync-${feed.id}`,
        { feedId: feed.id, organizationId: ctx.organizationId },
        { jobId: `rss-sync-initial-${feed.id}`, removeOnComplete: true, removeOnFail: 100 }
      );

      // Fix #78: audit log for RSS feed creation
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.RSS_FEED_CREATED,
        entityType: "RssFeed",
        entityId: feed.id,
        metadata: { name: input.name, url: input.url },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.RSS_FEED_CREATED });
      });
      return feed;
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(255).optional(),
        url: z.string().url().optional(),
        checkInterval: z.number().min(5).max(1440).optional(),
        autoPost: z.boolean().optional(),
        isActive: z.boolean().optional(),
        targetChannels: z.array(z.string()).optional(),
        promptTemplate: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      // Org-scoped existence check
      const existing = await ctx.prisma.rssFeed.findFirst({
        where: { id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      if (data.targetChannels && data.targetChannels.length > 0) {
        const owned = await ctx.prisma.channel.findMany({
          where: { id: { in: data.targetChannels }, organizationId: ctx.organizationId },
          select: { id: true },
        });
        if (owned.length !== new Set(data.targetChannels).size) {
          const ownedSet = new Set(owned.map((c) => c.id));
          const invalid = data.targetChannels.filter((id) => !ownedSet.has(id));
          throw new TRPCError({ code: "FORBIDDEN", message: `Channels not in this organization: ${invalid.join(", ")}` });
        }
      }
      const feed = await ctx.prisma.rssFeed.update({
        where: { id },
        data,
      });
      // Fix #78: audit log for RSS feed update
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.RSS_FEED_UPDATED,
        entityType: "RssFeed",
        entityId: id,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.RSS_FEED_UPDATED });
      });
      return feed;
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.rssFeed.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      await ctx.prisma.rssFeed.delete({ where: { id: input.id } });
      // Fix #78: audit log for RSS feed deletion
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.RSS_FEED_DELETED,
        entityType: "RssFeed",
        entityId: input.id,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.RSS_FEED_DELETED });
      });
      return { success: true };
    }),

  getEntries: orgProcedure
    .input(
      z.object({
        feedId: z.string(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify feed belongs to caller's org before returning entries.
      const feed = await ctx.prisma.rssFeed.findFirst({
        where: { id: input.feedId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      const entries = await ctx.prisma.rssFeedEntry.findMany({
        where: { feedId: input.feedId },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (entries.length > input.limit) {
        const lastItem = entries.pop();
        nextCursor = lastItem?.id;
      }

      return { entries, nextCursor };
    }),

  checkNow: orgProcedure
    .input(
      z.object({
        feedId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // SECURITY: derive organizationId from session, NOT from input —
      // previously the client could pass an arbitrary organizationId here
      // and trigger sync jobs against another tenant.
      const feed = await ctx.prisma.rssFeed.findFirst({
        where: { id: input.feedId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      await rssSyncQueue.add(
        `rss-sync-${input.feedId}`,
        { feedId: input.feedId, organizationId: ctx.organizationId },
        { jobId: `rss-sync-manual-${input.feedId}`, removeOnComplete: true, removeOnFail: 100 }
      );
      return { success: true, message: "RSS sync job enqueued" };
    }),
});
