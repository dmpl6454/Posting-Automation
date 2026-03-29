import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { postPublishQueue } from "@postautomation/queue";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

export const postRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"]).optional(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const posts = await ctx.prisma.post.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.status && { status: input.status }),
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (posts.length > input.limit) {
        const lastItem = posts.pop();
        nextCursor = lastItem?.id;
      }

      return { posts, nextCursor };
    }),

  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true }, orderBy: { order: "asc" } },
          tags: true,
        },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });
      return post;
    }),

  create: orgProcedure
    .input(
      z.object({
        content: z.string().min(1),
        contentVariants: z.record(z.string()).optional(),
        channelIds: z.array(z.string()).min(1),
        scheduledAt: z.string().datetime().optional(),
        mediaIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        aiGenerated: z.boolean().default(false),
        aiProvider: z.string().optional(),
        aiPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const status = input.scheduledAt ? "SCHEDULED" : "DRAFT";

      const post = await ctx.prisma.post.create({
        data: {
          organizationId: ctx.organizationId,
          createdById: (ctx.session.user as any).id,
          content: input.content,
          contentVariants: input.contentVariants || undefined,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          status,
          aiGenerated: input.aiGenerated,
          aiProvider: input.aiProvider,
          aiPrompt: input.aiPrompt,
          targets: {
            create: input.channelIds.map((channelId) => ({
              channelId,
              status,
            })),
          },
          ...(input.mediaIds?.length && {
            mediaAttachments: {
              create: input.mediaIds.map((mediaId, index) => ({
                mediaId,
                order: index,
              })),
            },
          }),
          ...(input.tags?.length && {
            tags: {
              create: input.tags.map((tag) => ({ tag })),
            },
          }),
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
      });

      // If scheduled, enqueue publish jobs
      if (status === "SCHEDULED" && input.scheduledAt) {
        const delay = new Date(input.scheduledAt).getTime() - Date.now();
        for (const target of post.targets) {
          await postPublishQueue.add(
            `publish-${target.id}`,
            {
              postId: post.id,
              postTargetId: target.id,
              channelId: target.channelId,
              platform: target.channel.platform,
              organizationId: ctx.organizationId,
            },
            { delay: Math.max(delay, 0), attempts: 3, backoff: { type: "exponential", delay: 30000 } }
          );
        }
      }

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.POST_CREATED,
        entityType: "Post",
        entityId: post.id,
      }).catch(() => {});

      return post;
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        content: z.string().min(1).optional(),
        contentVariants: z.record(z.string()).optional(),
        scheduledAt: z.string().datetime().nullable().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.status === "PUBLISHED" || existing.status === "PUBLISHING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit published posts" });
      }

      const { id, tags, ...data } = input;
      const updatedPost = await ctx.prisma.post.update({
        where: { id },
        data: {
          ...data,
          scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : data.scheduledAt === null ? null : undefined,
          ...(tags && {
            tags: {
              deleteMany: {},
              create: tags.map((tag) => ({ tag })),
            },
          }),
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
      });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.POST_UPDATED,
        entityType: "Post",
        entityId: id,
      }).catch(() => {});

      return updatedPost;
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.post.delete({ where: { id: input.id } });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.POST_DELETED,
        entityType: "Post",
        entityId: input.id,
      }).catch(() => {});

      return { success: true };
    }),

  publishNow: orgProcedure
    .input(z.object({ id: z.string(), targetIds: z.array(z.string()).optional() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: { targets: { include: { channel: true } } },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });

      // If specific targetIds provided, use those; otherwise use all FAILED/DRAFT/SCHEDULED targets
      let targetsToPublish = input.targetIds?.length
        ? post.targets.filter((t) => input.targetIds!.includes(t.id) && t.status !== "PUBLISHED")
        : post.targets.filter((t) => t.status === "FAILED" || t.status === "DRAFT" || t.status === "SCHEDULED");

      if (targetsToPublish.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No eligible channels to publish." });
      }

      await ctx.prisma.post.update({
        where: { id: input.id },
        data: { status: "SCHEDULED", scheduledAt: new Date() },
      });

      await ctx.prisma.postTarget.updateMany({
        where: { id: { in: targetsToPublish.map((t) => t.id) } },
        data: { status: "SCHEDULED", errorMessage: null },
      });

      for (const target of targetsToPublish) {
        await postPublishQueue.add(
          `publish-now-${target.id}-${Date.now()}`,
          {
            postId: post.id,
            postTargetId: target.id,
            channelId: target.channelId,
            platform: target.channel.platform,
            organizationId: ctx.organizationId,
          },
          { delay: 0, attempts: 3, backoff: { type: "exponential", delay: 30000 } }
        );
      }

      return { success: true };
    }),

  /** Recent post target activity for the activity feed */
  recentActivity: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const targets = await ctx.prisma.postTarget.findMany({
        where: {
          post: { organizationId: ctx.organizationId },
        },
        include: {
          channel: { select: { name: true, platform: true } },
          post: { select: { content: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
      });

      return targets.map((t) => ({
        id: t.id,
        postId: t.postId,
        status: t.status,
        platform: t.channel.platform,
        channelName: t.channel.name,
        content: t.post.content?.slice(0, 100),
        errorMessage: t.errorMessage,
        publishedAt: t.publishedAt,
        updatedAt: t.updatedAt,
      }));
    }),
});
