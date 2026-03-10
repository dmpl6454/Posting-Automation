import { getStripe } from "./stripe";
import { prisma } from "@postautomation/db";
import type Stripe from "stripe";

export async function handleStripeWebhook(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.organizationId) {
        await prisma.organization.update({
          where: { id: session.metadata.organizationId },
          data: {
            stripeCustomerId: session.customer as string,
            stripeSubscriptionId: session.subscription as string,
            plan: (session.metadata.plan as any) || "STARTER",
          },
        });
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const org = await prisma.organization.findFirst({
        where: { stripeSubscriptionId: subscription.id },
      });
      if (org) {
        await prisma.organization.update({
          where: { id: org.id },
          data: {
            planExpiresAt: new Date(subscription.current_period_end * 1000),
          },
        });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const org = await prisma.organization.findFirst({
        where: { stripeSubscriptionId: subscription.id },
      });
      if (org) {
        await prisma.organization.update({
          where: { id: org.id },
          data: {
            plan: "FREE",
            stripeSubscriptionId: null,
            planExpiresAt: null,
          },
        });
      }
      break;
    }
  }
}

export async function createCheckoutSession(
  organizationId: string,
  priceId: string,
  planType: string
) {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
  });

  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/settings/billing?success=true`,
    cancel_url: `${process.env.APP_URL}/settings/billing?canceled=true`,
    customer: org.stripeCustomerId || undefined,
    metadata: {
      organizationId,
      plan: planType,
    },
  });

  return session;
}

export async function createCustomerPortalSession(customerId: string) {
  return getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${process.env.APP_URL}/settings/billing`,
  });
}
