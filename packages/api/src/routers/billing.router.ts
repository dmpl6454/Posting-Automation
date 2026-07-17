import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure, adminOrgProcedure } from "../trpc";
import {
  PLANS,
  createCheckoutSession,
  createCustomerPortalSession,
  getStripe,
} from "@postautomation/billing";
import { checkUsageLimit, isBillingDisabled } from "../middleware/plan-limit.middleware";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

export const billingRouter = createRouter({
  plans: orgProcedure.query(() => {
    return Object.values(PLANS);
  }),

  currentPlan: orgProcedure.query(async ({ ctx }) => {
    const org = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
      select: { plan: true, planExpiresAt: true, stripeCustomerId: true, stripeSubscriptionId: true },
    });
    // billingDisabled: temporary product switch — when true, all plan/quota gates
    // are bypassed for every org, so the UI should hide plan locks / upgrade nudges.
    return { ...org, planConfig: PLANS[org.plan] || PLANS.FREE, billingDisabled: isBillingDisabled() };
  }),

  createCheckout: adminOrgProcedure
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
      // Fix #78: audit log for checkout start
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.BILLING_CHECKOUT_STARTED,
        entityType: "Organization",
        entityId: ctx.organizationId,
        metadata: { planType: input.planType },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.BILLING_CHECKOUT_STARTED });
      });
      return { url: session.url };
    }),

  createPortalSession: adminOrgProcedure.mutation(async ({ ctx }) => {
    const org = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId },
    });
    if (!org.stripeCustomerId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "No billing account found" });
    }
    const session = await createCustomerPortalSession(org.stripeCustomerId);
    return { url: session.url };
  }),

  /**
   * Fix #93: return default payment method (brand/last4/exp) so the UI can
   * surface it in-app. Returns null if no Stripe customer or no card on file.
   * Updates still go through the Stripe billing portal.
   */
  paymentMethod: orgProcedure.query(async ({ ctx }) => {
    const org = await ctx.prisma.organization.findUnique({
      where: { id: ctx.organizationId },
      select: { stripeCustomerId: true },
    });
    if (!org?.stripeCustomerId) return null;
    if (!process.env.STRIPE_SECRET_KEY) return null;

    try {
      const stripe = getStripe();
      // Prefer the customer's default; fall back to the first card on file.
      const customer = await stripe.customers.retrieve(org.stripeCustomerId);
      let pmId: string | null = null;
      if (customer && !customer.deleted) {
        pmId =
          (customer.invoice_settings?.default_payment_method as string | null) ??
          (customer.default_source as string | null) ??
          null;
      }
      let pm: any = null;
      if (pmId) {
        pm = await stripe.paymentMethods.retrieve(pmId);
      } else {
        const pms = await stripe.paymentMethods.list({
          customer: org.stripeCustomerId,
          type: "card",
          limit: 1,
        });
        pm = pms.data[0] ?? null;
      }
      if (!pm?.card) return null;
      return {
        brand: pm.card.brand as string,
        last4: pm.card.last4 as string,
        expMonth: pm.card.exp_month as number,
        expYear: pm.card.exp_year as number,
      };
    } catch (err) {
      console.error("billing.paymentMethod failed", err);
      return null;
    }
  }),

  /** Returns current usage vs limits for all plan resources */
  usage: orgProcedure.query(async ({ ctx }) => {
    const [channels, postsPerMonth, aiImagesPerMonth, aiVideosPerMonth, teamMembers] =
      await Promise.all([
        checkUsageLimit(ctx.organizationId, "channels", ctx.isSuperAdmin),
        checkUsageLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin),
        checkUsageLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin),
        checkUsageLimit(ctx.organizationId, "aiVideosPerMonth", ctx.isSuperAdmin),
        checkUsageLimit(ctx.organizationId, "teamMembers", ctx.isSuperAdmin),
      ]);
    return { channels, postsPerMonth, aiImagesPerMonth, aiVideosPerMonth, teamMembers };
  }),
});
