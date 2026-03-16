import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";

export const designTemplateRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        category: z.string().optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      return ctx.prisma.designTemplate.findMany({
        where: {
          OR: [
            { organizationId: ctx.organizationId },
            { isGlobal: true },
          ],
          ...(input?.category && { category: input.category }),
        },
        select: {
          id: true,
          name: true,
          category: true,
          thumbnail: true,
          width: true,
          height: true,
          isGlobal: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
    }),

  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.designTemplate.findFirstOrThrow({
        where: {
          id: input.id,
          OR: [
            { organizationId: ctx.organizationId },
            { isGlobal: true },
          ],
        },
      });
    }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1),
        category: z.string(),
        thumbnail: z.string(),
        canvasJson: z.any(),
        width: z.number(),
        height: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;
      return ctx.prisma.designTemplate.create({
        data: {
          name: input.name,
          category: input.category,
          thumbnail: input.thumbnail,
          canvasJson: input.canvasJson,
          width: input.width,
          height: input.height,
          organizationId: ctx.organizationId,
          createdById: userId,
        },
      });
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        category: z.string().optional(),
        thumbnail: z.string().optional(),
        canvasJson: z.any().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.designTemplate.update({
        where: {
          id: input.id,
          organizationId: ctx.organizationId,
        },
        data: {
          ...(input.name && { name: input.name }),
          ...(input.category && { category: input.category }),
          ...(input.thumbnail && { thumbnail: input.thumbnail }),
          ...(input.canvasJson && { canvasJson: input.canvasJson }),
        },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.designTemplate.delete({
        where: {
          id: input.id,
          organizationId: ctx.organizationId,
          isGlobal: false,
        },
      });
    }),
});
