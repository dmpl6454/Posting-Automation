import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import { createRouter, adminOrgProcedure } from "../trpc";
import { requirePlan } from "../middleware/plan-limit.middleware";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { webhookUrlSchema } from "../lib/url-safety";

function requireOwnerOrAdmin(role: string | undefined) {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only OWNER or ADMIN members can manage webhooks." });
  }
}

export const webhookRouter = createRouter({
  list: adminOrgProcedure.query(async ({ ctx }) => {
    requireOwnerOrAdmin(ctx.membership.role);
    return ctx.prisma.webhook.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
    });
  }),

  create: adminOrgProcedure
    .input(
      z.object({
        // Fix #88/#90/#91: SSRF guard — must be HTTPS, no private/loopback addresses
        url: webhookUrlSchema,
        events: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireOwnerOrAdmin(ctx.membership.role);
      // ADD-6: server-side plan gate (mirrors apikey.router). Webhooks are a
      // Professional+ integration capability; enforce here so a lower-plan user
      // can't create one via a direct tRPC call. (Superadmins bypass.)
      await requirePlan(ctx.organizationId, "PROFESSIONAL", "Webhooks", ctx.isSuperAdmin);
      const secret = crypto.randomBytes(32).toString("hex");
      const webhook = await ctx.prisma.webhook.create({
        data: {
          organizationId: ctx.organizationId,
          url: input.url,
          secret,
          events: input.events,
        },
      });
      // Fix #78: audit log for webhook creation
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.WEBHOOK_CREATED,
        entityType: "Webhook",
        entityId: webhook.id,
        metadata: { url: input.url, events: input.events },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.WEBHOOK_CREATED });
      });
      return webhook;
    }),

  delete: adminOrgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireOwnerOrAdmin(ctx.membership.role);
      const webhook = await ctx.prisma.webhook.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!webhook) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.webhook.delete({ where: { id: input.id } });
      // Fix #78: audit log for webhook deletion
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.WEBHOOK_DELETED,
        entityType: "Webhook",
        entityId: input.id,
        metadata: { url: webhook.url },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.WEBHOOK_DELETED });
      });
      return { success: true };
    }),
});
