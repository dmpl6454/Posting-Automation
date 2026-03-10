import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";

export const userRouter = createRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUnique({
      where: { id: (ctx.session.user as any).id },
      include: {
        memberships: {
          include: { organization: true },
        },
      },
    });
    return user;
  }),

  updateProfile: protectedProcedure
    .input(z.object({ name: z.string().min(1).optional(), image: z.string().url().optional() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.user.update({
        where: { id: (ctx.session.user as any).id },
        data: input,
      });
    }),

  createOrganization: protectedProcedure
    .input(z.object({ name: z.string().min(1), slug: z.string().min(1).regex(/^[a-z0-9-]+$/) }))
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.prisma.organization.create({
        data: {
          name: input.name,
          slug: input.slug,
          members: {
            create: {
              userId: (ctx.session.user as any).id,
              role: "OWNER",
            },
          },
        },
      });
      return org;
    }),
});
