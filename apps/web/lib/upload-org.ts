interface MembershipLookup {
  organizationMember: {
    findUnique(args: {
      where: { userId_organizationId: { userId: string; organizationId: string } };
      select: { organizationId: true };
    }): Promise<{ organizationId: string } | null>;
    findFirst(args: {
      where: { userId: string };
      orderBy: Array<{ role: "asc" } | { createdAt: "asc" }>;
      select: { organizationId: true };
    }): Promise<{ organizationId: string } | null>;
  };
}

/**
 * Org a /api/upload Media row is filed under. The client's x-organization-id is
 * honoured only after a real membership check; otherwise fall back to the same
 * default org orgProcedure picks (OWNER first, then oldest membership) — an
 * unordered findFirst could land the file in a workspace tRPC never resolves to.
 */
export async function resolveUploadOrganizationId(
  prisma: MembershipLookup,
  userId: string,
  headerOrgId: string | null | undefined,
): Promise<string | null> {
  if (headerOrgId) {
    const membership = await prisma.organizationMember.findUnique({
      where: { userId_organizationId: { userId, organizationId: headerOrgId } },
      select: { organizationId: true },
    });
    if (membership) return membership.organizationId;
  }
  const fallback = await prisma.organizationMember.findFirst({
    where: { userId },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { organizationId: true },
  });
  return fallback?.organizationId ?? null;
}
