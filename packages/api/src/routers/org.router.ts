import { ensurePersonalOrg } from "@postautomation/db";
import { createRouter, protectedProcedure } from "../trpc";

export const orgRouter = createRouter({
  // Get the current user's active organization.
  //
  // Honors the x-organization-id header (ctx.organizationId) ONLY when the user
  // is an actual MEMBER of that org. This makes a deliberate org switch (which
  // the switcher only offers among the user's memberships) authoritative,
  // instead of always snapping back to the first membership and fighting the
  // switcher.
  //
  // We intentionally do NOT add a superadmin bypass here: a superadmin's *home*
  // context must default to their own membership org. Otherwise a stale
  // localStorage value (e.g. an org left over from a stopped impersonation
  // session) would be honored and the superadmin would get silently stuck in
  // that org and never self-heal, publishing to the wrong org. Hard isolation
  // is now in effect: orgProcedure no longer bypasses the membership check for
  // superadmins, so a superadmin reaches another org ONLY via impersonation
  // (the deliberate, banner-flagged path that swaps the acting session user) —
  // not via an orgProcedure bypass and not via stale headers.
  //
  // On any miss (no header, non-member org, deleted org) we degrade to the first
  // membership and never throw, so OrgInit always converges without a reload
  // loop. Authorization is unchanged: this is display/canonical-org state only —
  // orgProcedure + the createPost channel-ownership check remain the IDOR gates.
  current: protectedProcedure.query(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id;
    const headerOrgId = ctx.organizationId;

    if (headerOrgId) {
      const headerMembership = await ctx.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId: headerOrgId } },
        include: { organization: true },
      });
      if (headerMembership) {
        return {
          id: headerMembership.organization.id,
          name: headerMembership.organization.name,
          slug: headerMembership.organization.slug,
          role: headerMembership.role,
        };
      }
      // header org is not one the user belongs to → fall through to first membership
    }

    const membership = await ctx.prisma.organizationMember.findFirst({
      where: { userId },
      // S1: deterministic fallback org, identical to trpc.ts (orgProcedure) and
      // user.router (me). MemberRole is a Postgres enum, so role asc sorts by
      // declaration order (OWNER < ADMIN < MEMBER), preferring the owned org;
      // createdAt asc breaks ties to the oldest membership. Keeps the canonical
      // "current" org in agreement with the OrgSwitcher default (memberships[0]).
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
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

    // S2: idempotent single-org provisioning. Reuses an existing personal org
    // (same userId) instead of creating a duplicate, so OAuth signup +
    // credentials register for the same person never diverge into two orgs.
    const userEmail = (ctx.session.user as any).email || "user";
    const org = await ensurePersonalOrg(ctx.prisma, userId, userEmail);

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      role: "OWNER" as const,
    };
  }),
});
