import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

/** Validate an optional logo media id belongs to the org (IDOR guard). */
export async function assertLogoMediaOwned(
  prisma: any,
  organizationId: string,
  logoMediaId: string | undefined
): Promise<void> {
  if (!logoMediaId) return;
  const found = await prisma.media.findFirst({
    where: { id: logoMediaId, organizationId },
    select: { id: true },
  });
  if (!found) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Logo media not found in this organization." });
  }
}

const STYLE = z.enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"]);
const POSITION = z.enum(["top-left", "top-right"]);

export const creativeTemplateRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.creativeTemplate.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      include: { logoMedia: { select: { url: true } } },
    });
  }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(80),
        style: STYLE,
        logoMediaId: z.string().optional(),
        logoPosition: POSITION.default("top-right"),
        brandColor: z.string().optional(),
        channelId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
      return ctx.prisma.creativeTemplate.create({
        data: {
          organizationId: ctx.organizationId,
          createdById: (ctx.session.user as any).id,
          name: input.name,
          style: input.style,
          logoMediaId: input.logoMediaId,
          logoPosition: input.logoPosition,
          brandColor: input.brandColor,
          channelId: input.channelId,
        },
      });
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        style: STYLE.optional(),
        logoMediaId: z.string().nullable().optional(),
        logoPosition: POSITION.optional(),
        brandColor: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.logoMediaId) {
        await assertLogoMediaOwned(ctx.prisma, ctx.organizationId, input.logoMediaId);
      }
      return ctx.prisma.creativeTemplate.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.style !== undefined && { style: input.style }),
          ...(input.logoMediaId !== undefined && { logoMediaId: input.logoMediaId }),
          ...(input.logoPosition !== undefined && { logoPosition: input.logoPosition }),
          ...(input.brandColor !== undefined && { brandColor: input.brandColor }),
        },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.creativeTemplate.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.creativeTemplate.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
