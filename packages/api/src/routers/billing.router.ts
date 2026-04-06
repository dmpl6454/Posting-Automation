import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { PLANS, createCheckoutSession, createCustomerPortalSession } from "@postautomation/billing";
import { checkUsageLimit } from "../middleware/plan-limit.middleware";

export const billingRouter = createRouter({
  plans: orgProcedure.query(() => {
    return Object.values(PLANS);
  }),

  currentPlan: orgProcedure.query(async ({ ctx }) => {
    const org = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { plan: true, planExpiresAt: true, stripeCustomerId: true, stripeSubscriptionId: true },
    });
    return { ...org, planConfig: PLANS[org.plan] || PLANS.FREE };
  }),

  createCheckout: orgProcedure
    .input(z.object({ planType: z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can manage billing" });
      }
      const plan = PLANS[input.planType];
      if (!plan?.stripePriceId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid plan" });
      }
      const session = await createCheckoutSession(ctx.organizationId, plan.stripePriceId, input.planType);
      return { url: session.url };
    }),

  createPortalSession: orgProcedure.mutation(async ({ ctx }) => {
    const org = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
    });
    if (!org.stripeCustomerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No billing account found" });
    }
    const session = await createCustomerPortalSession(org.stripeCustomerId);
    return { url: session.url };
  }),

  /** Returns current usage vs limits for all plan resources */
  usage: orgProcedure.query(async ({ ctx }) => {
    const [channels, postsPerMonth, aiImagesPerMonth, aiVideosPerMonth, teamMembers] =
      await Promise.all([
        checkUsageLimit(ctx.organizationId, "channels"),
        checkUsageLimit(ctx.organizationId, "postsPerMonth"),
        checkUsageLimit(ctx.organizationId, "aiImagesPerMonth"),
        checkUsageLimit(ctx.organizationId, "aiVideosPerMonth"),
        checkUsageLimit(ctx.organizationId, "teamMembers"),
      ]);
    return { channels, postsPerMonth, aiImagesPerMonth, aiVideosPerMonth, teamMembers };
  }),
});
