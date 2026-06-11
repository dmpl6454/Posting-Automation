# Temporarily Disable Billing — Give All Users Free Rein

**Date:** 2026-06-11
**Status:** Approved (design)
**Branch:** (current) `fix/ig-threads-media-ready` → will land on a dedicated branch

## Goal

Temporarily remove every plan/quota/billing limitation so that **all users — new and
old, every org regardless of plan** — have full access to all functionality. Keep every
line of billing/plan code intact so the restrictions can be re-activated later with **zero
code change**. Sign-up, sign-in, and all existing features must keep working exactly as-is.

This is a **deliberate, reversible product decision**, not a security relaxation: the
membership gate, org isolation, IDOR guards, role checks, and auth are all untouched.

## Non-Goals

- Removing or deleting any billing code, plan definitions, Stripe integration, or the
  billing settings page.
- Changing roles (`OWNER/ADMIN/MEMBER`), org membership, superadmin, or any auth flow.
- Changing default-FREE-on-signup, Stripe webhooks, or plan storage.

## Single global switch: `BILLING_DISABLED`

A new env var `BILLING_DISABLED`:

- `BILLING_DISABLED=true` → all plan/quota gates are bypassed for everyone.
- unset / any other value → **default**, billing enforced exactly as today.

Default-off means the flag can never accidentally ship "on" — production must opt in by
setting it. Re-locking = set `BILLING_DISABLED=false` (or remove it) and redeploy. No PR,
no code edit.

### Helper

`packages/api/src/middleware/plan-limit.middleware.ts` gains an exported helper:

```ts
/** When true, ALL plan/quota gates are bypassed for every org (temporary product
 *  decision to give all users free rein). Toggle via env; default = billing enforced. */
export function isBillingDisabled(): boolean {
  return process.env.BILLING_DISABLED === "true";
}
```

Read at call time (not module load) so it works inside Docker where env is injected at
container start — same pattern as `packages/billing/src/plans.ts` PLANS Proxy.

## Architecture — two chokepoints, four insertion points

The codebase funnels ALL enforcement through two predicates. We add a flag check that
mirrors the **existing `isSuperAdmin` bypass** (proven, side-effect-free) at each.

### Backend chokepoint: `plan-limit.middleware.ts`

Every backend gate (≈20 call sites across apikey/billing/newsgrid/brand-leads/chat/
listening/image/repurpose/team/channel/webhook/campaign/post/agent routers) calls one of
these three functions. We do NOT touch the call sites — they keep their
`requirePlan(...)` / `enforcePlanLimit(...)` lines and their `ctx.isSuperAdmin` argument,
ready to re-arm.

1. **`requirePlan`** — add `if (isBillingDisabled()) return;` directly above the existing
   `if (isSuperAdmin) return;`. No feature gate fires.

2. **`checkUsageLimit`** — when disabled, return
   `{ allowed: true, current: 0, limit: -1, planName: "Unlimited" }` (same shape as the
   superadmin branch). This makes `enforcePlanLimit` pass and the billing usage UI render
   "unlimited" without breaking.

`enforcePlanLimit` needs no change — it delegates to `checkUsageLimit`, so it inherits the
bypass.

### Middleware: `packages/api/src/trpc.ts` — `planExpiresAt` auto-revert

The `orgProcedure` middleware silently writes `plan: "FREE"` to any org whose paid plan has
lapsed. With billing disabled this is harmless (FREE has free rein too), but it mutates org
rows we want to preserve for when billing re-activates. So:

3. Gate the revert block: skip it when `isBillingDisabled()` is true (in addition to the
   existing `!isSuperAdmin` guard). No DB writes while disabled.

### UI chokepoint: `apps/web/components/layout/sidebar.tsx` — `planAllowed()`

All `minPlan`-tagged nav items (Super Agent, NewsGrid, Autopilot, Listening, Campaigns,
Brand Outreach) funnel through one predicate that decides lock icon + billing redirect.

4. `planAllowed()` returns `true` when billing is disabled → no lock icons, no
   billing-redirect on nav, every feature reachable.

The flag reaches the client via the **existing** `billing.currentPlan` tRPC query: add a
`billingDisabled: boolean` field to its response (server reads `isBillingDisabled()`), and
`sidebar.tsx` reads `planData?.billingDisabled`. No new client-side env plumbing, no new
query, no `NEXT_PUBLIC_*` var.

## What explicitly does NOT change

- All ≈20 backend gate call sites — unchanged (lines + `isSuperAdmin` arg intact).
- Plan definitions (`packages/billing/src/plans.ts`), Stripe (`stripe.ts`, `webhooks.ts`).
- Billing settings page — stays fully functional; usage counters read "unlimited".
- Default-FREE on signup (`ensure-personal-org.ts`, auth `events.createUser`, register
  route, `org.router.ts`).
- Roles, org membership, superadmin, impersonation, auth, sign-up/sign-in.

## Activation (now)

The flag is inert until set on the server. After the code merges (default `false` — no
change to live behavior on its own), activate the unlock by adding `BILLING_DISABLED=true`
to the server's `.env.prod` and redeploying (`bash scripts/deploy.sh deploy`). Verify by
checking that a FREE org can reach a plan-gated feature (e.g. Campaigns) without a lock
icon or "upgrade" error.

## Re-arming (later)

Set `BILLING_DISABLED=false` (or delete the line) in `.env.prod` and redeploy. All gates
return to enforcing exactly as they do today. **Zero code change.**

## Testing

- Unit test in `packages/api`: with `BILLING_DISABLED=true`, `requirePlan` resolves for a
  FREE org against a PROFESSIONAL feature; `checkUsageLimit`/`enforcePlanLimit` return
  allowed/unlimited even when usage exceeds the FREE cap. With the flag unset, the existing
  enforcement behavior is unchanged (regression guard).
- Existing security-regression suites stay green (no auth/IDOR/SSRF/XSS code touched).
- `pnpm --filter @postautomation/api exec tsc --noEmit` + `pnpm --filter @postautomation/api test`.

## Files touched

| File | Change |
|------|--------|
| `packages/api/src/middleware/plan-limit.middleware.ts` | add `isBillingDisabled()`; early-return in `requirePlan` + `checkUsageLimit` |
| `packages/api/src/trpc.ts` | skip `planExpiresAt` revert when disabled |
| `packages/api/src/routers/billing.router.ts` | `currentPlan` returns `billingDisabled` |
| `apps/web/components/layout/sidebar.tsx` | `planAllowed()` true when disabled |
| `.env.example`, `.env.production.example` | document `BILLING_DISABLED` (default false) |
| `packages/api/src/__tests__/billing-disabled.test.ts` | new regression test |
| `CLAUDE.md` | document the temporary unlock + how to re-arm |
| auto-memory | record the decision |
