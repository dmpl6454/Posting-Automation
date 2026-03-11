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
    .input(z.object({ name: z.string().min(1), slug: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      // Auto-generate a clean slug from name if not provided or invalid
      const rawSlug = (input.slug?.trim() || input.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const slug = rawSlug || `org-${Date.now()}`;
      const org = await ctx.prisma.organization.create({
        data: {
          name: input.name,
          slug,
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
