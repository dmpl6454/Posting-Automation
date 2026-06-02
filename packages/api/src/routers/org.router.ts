import { createRouter, protectedProcedure } from "../trpc";

export const orgRouter = createRouter({
  // Get the current user's active organization.
  //
  // Honors the x-organization-id header (ctx.organizationId) when the user can
  // actually access that org — a member, or a superadmin. This makes OrgInit
  // reconcile to the user's SELECTED org rather than always snapping back to the
  // first membership (which previously fought the org switcher and let a stale
  // org — e.g. left over from impersonation — silently win). On any miss
  // (no header, header points at an org the user can't access, or a deleted
  // org) we degrade to the first membership; we never throw, so OrgInit can
  // always converge without a reload loop. Authorization is unchanged: this is
  // display/canonical-org state only — orgProcedure + the createPost
  // channel-ownership check remain the real IDOR gates.
  current: protectedProcedure.query(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id;
    const isSuperAdmin = (ctx.session.user as any)?.isSuperAdmin === true;
    const headerOrgId = ctx.organizationId;

    if (headerOrgId) {
      const canAccess = isSuperAdmin
        ? true
        : (await ctx.prisma.organizationMember.findUnique({
            where: { userId_organizationId: { userId, organizationId: headerOrgId } },
            select: { organizationId: true },
          })) !== null;

      if (canAccess) {
        const org = await ctx.prisma.organization.findUnique({
          where: { id: headerOrgId },
        });
        if (org) {
          // role from membership if any (superadmin without membership → OWNER)
          const m = await ctx.prisma.organizationMember.findUnique({
            where: { userId_organizationId: { userId, organizationId: headerOrgId } },
            select: { role: true },
          });
          return {
            id: org.id,
            name: org.name,
            slug: org.slug,
            role: m?.role ?? ("OWNER" as const),
          };
        }
      }
      // header org not accessible or missing → fall through to first membership
    }

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
