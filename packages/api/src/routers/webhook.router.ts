import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import { createRouter, orgProcedure } from "../trpc";

export const webhookRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.webhook.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
    });
  }),

  create: orgProcedure
    .input(
      z.object({
        url: z.string().url(),
        events: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const secret = crypto.randomBytes(32).toString("hex");
      return ctx.prisma.webhook.create({
        data: {
          organizationId: ctx.organizationId,
          url: input.url,
          secret,
          events: input.events,
        },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const webhook = await ctx.prisma.webhook.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!webhook) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.webhook.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
