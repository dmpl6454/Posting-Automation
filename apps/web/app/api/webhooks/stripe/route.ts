import { NextResponse } from "next/server";
import Stripe from "stripe";
import { handleStripeWebhook } from "@postautomation/billing";
import { isStripeWebhookConfigured } from "~/lib/stripe-webhook-config";

export const dynamic = "force-dynamic";

// Lazy-initialize Stripe to avoid build-time errors when env vars are missing
function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2025-02-24.acacia" as any,
  });
}

export async function POST(req: Request) {
  // 🔒 Fail closed (security audit 2026-09-28). Node's HMAC accepts an empty
  // key, so an unset STRIPE_WEBHOOK_SECRET — which docker-compose.prod.yml's
  // `${VAR}` substitution turns into a literal "" when the key is absent from
  // .env.prod, and Stripe credentials are one of the sets documented as
  // intentionally left blank in this deployment — would otherwise let anyone
  // who can compute HMAC-SHA256 with an empty key forge an accepted event.
  if (!isStripeWebhookConfigured(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error("Stripe webhook received but STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const body = await req.text();
  const signature = req.headers.get("stripe-signature") as string;

  let event: Stripe.Event;

  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Webhook signature verification failed" },
      { status: 400 }
    );
  }

  try {
    await handleStripeWebhook(event);
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}
