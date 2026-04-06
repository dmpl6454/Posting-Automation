import { TRPCError } from "@trpc/server";
import { prisma } from "@postautomation/db";
import { getPlanConfig } from "@postautomation/billing";
import type { PlanType } from "@postautomation/db";

type LimitResource = "channels" | "postsPerMonth" | "aiImagesPerMonth" | "aiVideosPerMonth" | "teamMembers";

/**
 * Check if an organization has exceeded a plan limit.
 * Returns { allowed, current, limit, planName }.
 */
export async function checkUsageLimit(
  organizationId: string,
  resource: LimitResource
): Promise<{ allowed: boolean; current: number; limit: number; planName: string }> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { plan: true },
  });

  const plan = getPlanConfig(org.plan as PlanType);
  const limit = plan.limits[resource];

  // -1 means unlimited
  if (limit === -1) {
    return { allowed: true, current: 0, limit: -1, planName: plan.name };
  }

  let current = 0;

  switch (resource) {
    case "channels": {
      current = await prisma.channel.count({
        where: { organizationId, isActive: true },
      });
      break;
    }
    case "postsPerMonth": {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      current = await prisma.post.count({
        where: { organizationId, createdAt: { gte: startOfMonth } },
      });
      break;
    }
    case "aiImagesPerMonth": {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      current = await prisma.media.count({
        where: {
          organizationId,
          createdAt: { gte: startOfMonth },
          fileName: { startsWith: "ai-" },
        },
      });
      break;
    }
    case "aiVideosPerMonth": {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      current = await prisma.media.count({
        where: {
          organizationId,
          createdAt: { gte: startOfMonth },
          fileType: { startsWith: "video/" },
          fileName: { contains: "video" },
        },
      });
      break;
    }
    case "teamMembers": {
      current = await prisma.organizationMember.count({
        where: { organizationId },
      });
      break;
    }
  }

  return { allowed: current < limit, current, limit, planName: plan.name };
}

/**
 * Enforce a plan limit — throws TRPCError if limit exceeded.
 */
export async function enforcePlanLimit(
  organizationId: string,
  resource: LimitResource
): Promise<void> {
  const { allowed, current, limit, planName } = await checkUsageLimit(organizationId, resource);
  if (!allowed) {
    const resourceLabels: Record<LimitResource, string> = {
      channels: "connected channels",
      postsPerMonth: "posts this month",
      aiImagesPerMonth: "AI images this month",
      aiVideosPerMonth: "AI videos this month",
      teamMembers: "team members",
    };
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Plan limit reached: ${planName} plan allows ${limit} ${resourceLabels[resource]} (currently ${current}). Upgrade your plan for more.`,
    });
  }
}
