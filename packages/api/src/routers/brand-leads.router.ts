import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, adminOrgProcedure } from "../trpc";
import { requirePlan } from "../middleware/plan-limit.middleware";

export const brandLeadsRouter = createRouter({
  stats: adminOrgProcedure.query(async ({ ctx }) => {
    // Brand Outreach is a PROFESSIONAL+ feature
    await requirePlan(ctx.organizationId, "PROFESSIONAL", "Brand Outreach", ctx.isSuperAdmin);
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

  list: adminOrgProcedure
    .input(z.object({
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "SENT", "FAILED", "REPLIED", "INTERESTED", "NOT_INTERESTED", "CLOSED"]).optional(),
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

  messages: adminOrgProcedure
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

  approve: adminOrgProcedure
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

  reject: adminOrgProcedure
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

  approveAll: adminOrgProcedure
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

  // Gap #3 (2026-06-22): manual reply / outcome tracking. There is NO automated
  // inbox integration — replies land in the operator's own inbox, and they log
  // the outcome here by hand. Restricted to the post-send MANUAL states so this
  // control can't shove a lead back into the auto-pipeline states
  // (PENDING/APPROVED/SENT/FAILED are owned by the workers).
  setStatus: adminOrgProcedure
    .input(z.object({
      leadId: z.string(),
      status: z.enum(["REPLIED", "INTERESTED", "NOT_INTERESTED", "CLOSED"]),
    }))
    .mutation(async ({ ctx, input }) => {
      // Brand Outreach is PROFESSIONAL+ — gate the mutation explicitly (M23 lesson).
      await requirePlan(ctx.organizationId, "PROFESSIONAL", "Brand Outreach", ctx.isSuperAdmin);
      // IDOR guard: the lead must belong to the acting org (via its signal).
      const lead = await ctx.prisma.outreachLead.findFirstOrThrow({
        where: { id: input.leadId, signal: { organizationId: ctx.organizationId } },
      });
      // BO-04: a manual outcome (reply/interested/etc.) is semantically a
      // POST-SEND fact — you can't have a "reply" before anything was sent.
      // ⚠️ Gate on whether a message EVER reached SENT (an append-only historical
      // fact), NOT on the lead's CURRENT `status`. BO-03 legitimately overwrites
      // `lead.status` to the just-logged outcome (e.g. "REPLIED") on every
      // successful setStatus call — if this gate re-read `lead.status !== "SENT"`
      // after that, it would read true FOREVER and permanently lock out every
      // subsequent outcome change for that lead. `OutreachMessage.status` is the
      // same authoritative signal the outreach-send worker uses
      // (reconcileLeadStatus: at least one channel delivered) and is never
      // un-set once SENT, so it stays true forever once true.
      const hasEverSent = await ctx.prisma.outreachMessage.count({
        where: { leadId: input.leadId, status: "SENT" },
      });
      if (hasEverSent === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot log an outcome before outreach has been sent.",
        });
      }
      return ctx.prisma.outreachLead.update({
        where: { id: lead.id },
        data: { status: input.status },
      });
    }),
});
