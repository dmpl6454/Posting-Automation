"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
      <div className="mx-auto max-w-4xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 rounded-xl" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-muted-foreground">Manage your subscription and billing</p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>How Billing works</AlertTitle>
        <AlertDescription>
          {currentPlan?.stripeCustomerId
            ? `Your subscription is managed through Stripe. Click "Manage Billing" to update your card, change plans, or download invoices. Plan changes take effect immediately; downgrades are prorated automatically.`
            : `Your subscription is managed through Stripe. Choose a paid plan below to start a subscription. Once subscribed, a "Manage Billing" button will appear here to update your card, change plans, or download invoices.`}
        </AlertDescription>
      </Alert>

      {/* Current Plan */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="rounded-lg bg-primary/10 p-3">
                <CreditCard className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Current Plan</p>
                <p className="text-2xl font-bold">{currentPlan?.planConfig?.name || "Free"}</p>
              </div>
            </div>
            {currentPlan?.stripeCustomerId && (
              <Button
                variant="outline"
                onClick={() => createPortal.mutate()}
                disabled={createPortal.isPending}
              >
                Manage Billing
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Fix #93: Payment Method (display only — updates via Stripe portal) */}
      {currentPlan?.stripeCustomerId && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Payment Method</CardTitle>
            <CardDescription>
              Card on file with Stripe. Click Manage Billing above to update.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {paymentMethod ? (
              <div className="flex items-center gap-3">
                <div className="rounded-md border bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
                  {paymentMethod.brand}
                </div>
                <p className="text-sm">
                  •••• {paymentMethod.last4}
                  <span className="ml-3 text-muted-foreground">
                    expires {String(paymentMethod.expMonth).padStart(2, "0")}/
                    {paymentMethod.expYear}
                  </span>
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No card on file. Choose a paid plan below to add one at checkout.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Plans Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans?.map((plan) => {
          const isCurrent = currentPlan?.plan === plan.type;
          return (
            <Card
              key={plan.type}
              className={isCurrent ? "border-primary ring-1 ring-primary" : ""}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{plan.name}</CardTitle>
                  {isCurrent && <Badge>Current</Badge>}
                </div>
                <div className="mt-1">
                  <span className="text-3xl font-bold">${plan.priceMonthly}</span>
                  <span className="text-sm text-muted-foreground">/mo</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-2">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                {isCurrent ? (
                  <Button variant="outline" className="w-full" disabled>
                    Current Plan
                  </Button>
                ) : plan.priceMonthly > 0 ? (
                  <Button
                    className="w-full gap-2"
                    onClick={() => createCheckout.mutate({ planType: plan.type as any })}
                    disabled={createCheckout.isPending}
                  >
                    <Zap className="h-4 w-4" />
                    Upgrade
                  </Button>
                ) : null}
              </CardContent>
            </Card>
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
