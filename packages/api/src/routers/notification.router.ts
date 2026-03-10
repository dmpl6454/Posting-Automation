import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";

export const notificationRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;
      const orgId = ctx.organizationId;

      const notifications = await ctx.prisma.notification.findMany({
        where: {
          userId,
          ...(orgId ? { organizationId: orgId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (notifications.length > input.limit) {
        const lastItem = notifications.pop();
        nextCursor = lastItem?.id;
      }

      return { notifications, nextCursor };
    }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id as string;
    const orgId = ctx.organizationId;

    const count = await ctx.prisma.notification.count({
      where: {
        userId,
        isRead: false,
        ...(orgId ? { organizationId: orgId } : {}),
      },
    });

    return { count };
  }),

  markRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;

      await ctx.prisma.notification.updateMany({
        where: {
          id: input.id,
          userId,
        },
        data: { isRead: true },
      });

      return { success: true };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id as string;
    const orgId = ctx.organizationId;

    await ctx.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
        ...(orgId ? { organizationId: orgId } : {}),
      },
      data: { isRead: true },
    });

    return { success: true };
  }),

  create: protectedProcedure
    .input(
      z.object({
        userId: z.string(),
        organizationId: z.string(),
        type: z.string(),
        title: z.string(),
        body: z.string(),
        link: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const notification = await ctx.prisma.notification.create({
        data: {
          userId: input.userId,
          organizationId: input.organizationId,
          type: input.type,
          title: input.title,
          body: input.body,
          link: input.link,
          metadata: input.metadata ? (input.metadata as Record<string, string>) : undefined,
        },
      });

      return notification;
    }),
});
