import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import { createRouter, orgProcedure } from "../trpc";
import { apiRateLimiter } from "../middleware/rate-limit";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

const apiRateLimited = orgProcedure.use(createRateLimitMiddleware(apiRateLimiter));

export const apikeyRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    const keys = await ctx.prisma.apiKey.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    return keys.map((key: any) => ({
      ...key,
      keyPrefix: "pa_****",
    }));
  }),

  create: apiRateLimited
    .input(
      z.object({
        name: z.string().min(1),
        expiresAt: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const plainKey = `pa_${crypto.randomBytes(32).toString("hex")}`;
      const keyHash = crypto.createHash("sha256").update(plainKey).digest("hex");

      const apiKey = await ctx.prisma.apiKey.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          keyHash,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.API_KEY_CREATED,
        entityType: "ApiKey",
        entityId: apiKey.id,
        metadata: { name: input.name },
      }).catch(() => {});

      return {
        id: apiKey.id,
        name: apiKey.name,
        key: plainKey,
        createdAt: apiKey.createdAt,
        expiresAt: apiKey.expiresAt,
      };
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const apiKey = await ctx.prisma.apiKey.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!apiKey) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.apiKey.delete({ where: { id: input.id } });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.API_KEY_DELETED,
        entityType: "ApiKey",
        entityId: input.id,
      }).catch(() => {});

      return { success: true };
    }),
});
