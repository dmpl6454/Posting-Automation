"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";
import { CreditCard, CheckCircle, Zap, Info } from "lucide-react";

function BillingPageInner() {
  const { toast } = useToast();
  const { data: currentPlan, isLoading } = trpc.billing.currentPlan.useQuery();
  const { data: plans } = trpc.billing.plans.useQuery();
  const { data: paymentMethod } = trpc.billing.paymentMethod.useQuery();
  const createCheckout = trpc.billing.createCheckout.useMutation({
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create checkout session", variant: "destructive" });
    },
  });
  const createPortal = trpc.billing.createPortalSession.useMutation({
    onSuccess: (data) => {
      if (data.url) window.location.href = data.url;
    },
  });

  if (isLoading) {
    return (
      <div className="w-full space-y-5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[90px] rounded-[14px]" />
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-64 rounded-[14px]" />)}
        </div>
      </div>
    );
  }

  return (
    /* Design stacks sections on 20px, not 24px. */
    <div className="w-full space-y-5">
      {/* Page header — design pattern (eyebrow, display headline, sub). */}
      <div className="min-w-0">
        <span className="eyebrow">Billing</span>
        <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
          Keep the lights on.
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Manage your subscription and payments
        </p>
      </div>

      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.65] text-muted-foreground">
          {/* The no-customer copy used to promise the button would "appear
              here" once subscribed. It is on screen now (disabled), so that
              sentence would contradict what the reader is looking at. */}
          {currentPlan?.stripeCustomerId
            ? `Your subscription is managed through Stripe. Click "Manage Billing" to update your card, change plans, or download invoices. Plan changes take effect immediately; downgrades are prorated automatically.`
            : `Your subscription is managed through Stripe. Choose a paid plan below to start a subscription — "Manage Billing" unlocks then, for updating your card, changing plans, or downloading invoices.`}
        </p>
      </div>

      {/* Current Plan */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-[14px] border border-border bg-card p-[22px]">
        <div className="flex items-center gap-3.5">
          <div className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[12px] bg-gold/[0.12]">
            <CreditCard className="h-5 w-5 text-gold" />
          </div>
          <div>
            <p className="text-[11.5px] leading-[1.3] text-muted-foreground">Current Plan</p>
            <p className="mt-[3px] text-[20px] font-bold leading-[1.2]">
              {currentPlan?.planConfig?.name || "Free"}
            </p>
          </div>
        </div>
        {/* The design keeps this button in the card at all times, so the row
            never changes shape. It only WORKS once the org has a Stripe
            customer, though — `billing.createPortalSession` opens that
            customer's portal and there is nothing to open before the first
            subscription — so without one it renders disabled with the reason,
            rather than vanishing (the card then looked unfinished) or lying
            about what it can do. */}
        <Button
          variant="outline"
          className="h-9 shrink-0 rounded-[9px] border-border2 px-[15px] text-[12.5px] font-medium hover:bg-hover disabled:opacity-40"
          title={
            currentPlan?.stripeCustomerId
              ? "Update your card, change plan, or download invoices"
              : "Available once you start a subscription below"
          }
          onClick={() => currentPlan?.stripeCustomerId && createPortal.mutate()}
          disabled={!currentPlan?.stripeCustomerId || createPortal.isPending}
        >
          Manage Billing
        </Button>
      </div>

      {/* Fix #93: Payment Method (display only — updates via Stripe portal) */}
      {currentPlan?.stripeCustomerId && (
        <div className="rounded-[14px] border border-border bg-card p-[22px]">
          <h2 className="text-[14.5px] font-semibold leading-[1.2]">Payment Method</h2>
          <p className="mt-[5px] text-[12px] leading-[1.5] text-muted-foreground">
            Card on file with Stripe. Click Manage Billing above to update.
          </p>
          {paymentMethod ? (
            <div className="mt-4 flex items-center gap-3">
              <span className="rounded-[6px] border border-border2 bg-tile px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {paymentMethod.brand}
              </span>
              <p className="text-[12.5px] leading-none">
                •••• {paymentMethod.last4}
                <span className="ml-3 text-muted-foreground">
                  expires {String(paymentMethod.expMonth).padStart(2, "0")}/
                  {paymentMethod.expYear}
                </span>
              </p>
            </div>
          ) : (
            <p className="mt-4 text-[12.5px] leading-[1.5] text-muted-foreground">
              No card on file. Choose a paid plan below to add one at checkout.
            </p>
          )}
        </div>
      )}

      {/* Plans Grid */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {plans?.map((plan) => {
          const isCurrent = currentPlan?.plan === plan.type;
          return (
            <div
              key={plan.type}
              className={`flex flex-col rounded-[14px] border bg-card p-5 ${
                isCurrent ? "border-gold" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[14.5px] font-semibold leading-[1.2]">{plan.name}</h2>
                {isCurrent && (
                  <span className="pa-gold-glow shrink-0 rounded-full bg-gold px-[9px] py-0.5 text-[10px] font-bold leading-[1.6] text-[hsl(var(--gold-foreground))]">
                    Current
                  </span>
                )}
              </div>
              <div className="mt-1.5">
                <span className="text-[26px] font-bold leading-none">${plan.priceMonthly}</span>
                <span className="text-[12px] leading-none text-muted-foreground">/mo</span>
              </div>
              {/* Action sits directly under the price, above the feature list, so
                  the CTA is reachable without reading the whole card. The list
                  below grows to fill, keeping every card the same height and the
                  buttons on one line across the row. */}
              {isCurrent ? (
                <Button
                  variant="outline"
                  className="mt-4 h-[34px] w-full rounded-[8px] border-border2 text-[12.5px] font-semibold text-muted-foreground"
                  disabled
                >
                  Current Plan
                </Button>
              ) : plan.priceMonthly > 0 ? (
                <Button
                  className="pa-cta-gold mt-4 h-[34px] w-full gap-2 rounded-[8px] text-[12.5px] font-semibold"
                  onClick={() => createCheckout.mutate({ planType: plan.type as any })}
                  disabled={createCheckout.isPending}
                >
                  <Zap className="h-3.5 w-3.5" />
                  Upgrade
                </Button>
              ) : (
                // No action for Free while on a paid plan. Reserve the row with
                // a real (hidden) Button rather than a fixed height, so the
                // feature lists stay aligned even if the button size token
                // changes.
                <Button
                  variant="outline"
                  className="invisible mt-4 h-[34px] w-full rounded-[8px]"
                  disabled
                  aria-hidden
                  tabIndex={-1}
                >
                  &nbsp;
                </Button>
              )}
              <ul className="mt-3.5 flex flex-1 flex-col gap-2">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-[7px] text-[12px] leading-[1.5] text-muted-foreground">
                    {/* Literal hex: this project's Tailwind config flattens the
                        green scale onto the palette's success triplet. */}
                    <CheckCircle className="mt-0.5 h-[13px] w-[13px] shrink-0 text-[#5cb85c]" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function BillingPage() {
  return (
    <RequireAppAdmin>
      <BillingPageInner />
    </RequireAppAdmin>
  );
}
