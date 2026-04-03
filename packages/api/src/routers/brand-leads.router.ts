import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";

export const brandLeadsRouter = createRouter({
  stats: orgProcedure.query(async ({ ctx }) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [total, pending, approved, sent, failed, todayCount] = await Promise.all([
      ctx.prisma.outreachLead.count({ where: { signal: { organizationId: ctx.organizationId } } }),
      ctx.prisma.outreachLead.count({ where: { signal: { organizationId: ctx.organizationId }, status: "PENDING" } }),
      ctx.prisma.outreachLead.count({ where: { signal: { organizationId: ctx.organizationId }, status: "APPROVED" } }),
      ctx.prisma.outreachLead.count({ where: { signal: { organizationId: ctx.organizationId }, status: "SENT" } }),
      ctx.prisma.outreachLead.count({ where: { signal: { organizationId: ctx.organizationId }, status: "FAILED" } }),
      ctx.prisma.outreachLead.count({ where: { signal: { organizationId: ctx.organizationId }, createdAt: { gte: today } } }),
    ]);

    return { total, pending, approved, sent, failed, todayCount };
  }),

  list: orgProcedure
    .input(z.object({
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "SENT", "FAILED"]).optional(),
      signalType: z.enum(["AD_LIBRARY", "SOCIAL_MEDIA", "PR_NEWS", "JOB_POSTING"]).optional(),
      days: z.number().min(1).max(90).default(30),
    }).optional())
    .query(async ({ ctx, input }) => {
      const since = new Date();
      since.setDate(since.getDate() - (input?.days ?? 30));

      return ctx.prisma.outreachLead.findMany({
        where: {
          signal: {
            organizationId: ctx.organizationId,
            ...(input?.signalType ? { signalType: input.signalType } : {}),
          },
          createdAt: { gte: since },
          ...(input?.status ? { status: input.status } : {}),
        },
        include: {
          signal: true,
          messages: { orderBy: { createdAt: "asc" } },
        },
        orderBy: [
          { signal: { score: "desc" } },
          { createdAt: "desc" },
        ],
        take: 100,
      });
    }),

  messages: orgProcedure
    .input(z.object({ leadId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.outreachMessage.findMany({
        where: {
          leadId: input.leadId,
          lead: { signal: { organizationId: ctx.organizationId } },
        },
        include: { deliveryLogs: { orderBy: { attemptedAt: "desc" }, take: 3 } },
        orderBy: { createdAt: "asc" },
      });
    }),

  approve: orgProcedure
    .input(z.object({ leadId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const lead = await ctx.prisma.outreachLead.findFirstOrThrow({
        where: { id: input.leadId, signal: { organizationId: ctx.organizationId } },
      });
      return ctx.prisma.outreachLead.update({
        where: { id: lead.id },
        data: { status: "APPROVED" },
      });
    }),

  reject: orgProcedure
    .input(z.object({ leadId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const lead = await ctx.prisma.outreachLead.findFirstOrThrow({
        where: { id: input.leadId, signal: { organizationId: ctx.organizationId } },
      });
      return ctx.prisma.outreachLead.update({
        where: { id: lead.id },
        data: { status: "REJECTED" },
      });
    }),

  approveAll: orgProcedure
    .mutation(async ({ ctx }) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return ctx.prisma.outreachLead.updateMany({
        where: {
          signal: { organizationId: ctx.organizationId },
          status: "PENDING",
          createdAt: { gte: today },
        },
        data: { status: "APPROVED" },
      });
    }),
});
