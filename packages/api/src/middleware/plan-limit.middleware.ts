import { TRPCError } from "@trpc/server";
import { prisma } from "@postautomation/db";
import { getPlanConfig } from "@postautomation/billing";
import type { PlanType } from "@postautomation/db";

// Ordered from least to most privileged — used for "at least X" comparisons.
const PLAN_ORDER: PlanType[] = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"];

/**
 * Throw FORBIDDEN if the org's current plan is below `minimumPlan`.
 * Pass `isSuperAdmin: true` to bypass the check entirely (e.g. for tabish@dashmani.com).
 *
 * Usage in a router:
 *   await requirePlan(ctx.organizationId, "STARTER", "Autopilot", ctx.isSuperAdmin);
 */
export async function requirePlan(
  organizationId: string,
  minimumPlan: PlanType,
  featureName: string,
  isSuperAdmin?: boolean
): Promise<void> {
  // Super admins bypass all plan gates — they have access to everything.
  if (isSuperAdmin) return;

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { plan: true },
  });

  const orgPlanIndex = PLAN_ORDER.indexOf(org.plan as PlanType);
  const minPlanIndex = PLAN_ORDER.indexOf(minimumPlan);

  if (orgPlanIndex < minPlanIndex) {
    const planConfig = getPlanConfig(minimumPlan);
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `${featureName} is available on ${planConfig.name} and higher plans. Upgrade at /dashboard/settings/billing.`,
    });
  }
}

type LimitResource = "channels" | "postsPerMonth" | "aiImagesPerMonth" | "aiVideosPerMonth" | "teamMembers";

/**
 * Check if an organization has exceeded a plan limit.
 * Returns { allowed, current, limit, planName }.
 * Pass `isSuperAdmin: true` to always return allowed=true (unlimited access).
 */
export async function checkUsageLimit(
  organizationId: string,
  resource: LimitResource,
  isSuperAdmin?: boolean
): Promise<{ allowed: boolean; current: number; limit: number; planName: string }> {
  // Super admins are never limited.
  if (isSuperAdmin) {
    return { allowed: true, current: 0, limit: -1, planName: "Enterprise" };
  }
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
 * Pass `isSuperAdmin: true` to bypass entirely.
 */
export async function enforcePlanLimit(
  organizationId: string,
  resource: LimitResource,
  isSuperAdmin?: boolean
): Promise<void> {
  const { allowed, current, limit, planName } = await checkUsageLimit(organizationId, resource, isSuperAdmin);
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
