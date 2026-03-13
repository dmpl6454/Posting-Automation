import { z } from "zod";
import { createRouter, superAdminProcedure } from "../../trpc";

export const adminAuditRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
        userId: z.string().optional(),
        organizationId: z.string().optional(),
        action: z.string().optional(),
        entityType: z.string().optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, userId, organizationId, action, entityType, startDate, endDate } =
        input;

      const where: any = {};
      if (userId) where.userId = userId;
      if (organizationId) where.organizationId = organizationId;
      if (action) where.action = { contains: action, mode: "insensitive" };
      if (entityType) where.entityType = entityType;
      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) where.createdAt.gte = startDate;
        if (endDate) where.createdAt.lte = endDate;
      }

      const items = await ctx.prisma.auditLog.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          organization: { select: { id: true, name: true } },
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
});
