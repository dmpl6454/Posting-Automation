import { prisma } from "@postautomation/db";

/**
 * Resolve a real userId to attribute system-generated posts/media to:
 * the oldest OWNER of the given org. Falls back to any member if no OWNER.
 * Throws if the org has no members (caller should skip the job).
 */
export async function resolveOrgAuthor(organizationId: string): Promise<string> {
  const owner = await prisma.organizationMember.findFirst({
    where: { organizationId, role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (owner) return owner.userId;
  const anyMember = await prisma.organizationMember.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (anyMember) return anyMember.userId;
  throw new Error(`No members found for org ${organizationId}`);
}
