import { z } from "zod";
import { createRouter, protectedProcedure, adminProtectedProcedure } from "../trpc";

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

  // 🔒 REMOVED (security audit 2026-09-28). This wrote a notification for any
  // userId + organizationId pair with NO check that the target user is a member
  // of that org, and `link` was never validated — any app-ADMIN (35 users are
  // grandfathered to ADMIN, or every user under RBAC_DISABLED) could plant a
  // notification in a stranger's feed in any workspace, with a link that ran
  // whatever `window.location.href`/`router.push` would do with it. Nothing in
  // the UI ever called it: every real producer (approval.router, post-publish,
  // caption-fanout, publish-recovery) writes through Prisma directly. Do not
  // re-add a client-facing create without an org-membership check on userId
  // AND link validation via isSafeInAppLink's same rule.
});
