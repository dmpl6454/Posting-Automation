import { createRouter, protectedProcedure } from "../trpc";

export const orgRouter = createRouter({
  // Get the current user's organization (first one they belong to)
  current: protectedProcedure.query(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id;

    const membership = await ctx.prisma.organizationMember.findFirst({
      where: { userId },
      include: { organization: true },
    });

    if (membership) {
      return {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        role: membership.role,
      };
    }

    // Auto-create a default organization
    const userEmail = (ctx.session.user as any).email || "user";
    const orgName = `${userEmail.split("@")[0]}'s Workspace`;
    const org = await ctx.prisma.organization.create({
      data: {
        name: orgName,
        slug: `org-${userId.slice(0, 8)}-${Date.now()}`,
        members: {
          create: {
            userId,
            role: "OWNER",
          },
        },
      },
    });

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: "OWNER" as const,
    };
  }),
});
