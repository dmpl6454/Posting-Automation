/**
 * Fail-closed check before verifying a Stripe webhook signature (security
 * audit 2026-09-28) — see the header of stripe-webhook-config.test.ts for why.
 *
 * Mirrors the pattern already established for the Meta webhook verifier in
 * this codebase: an empty secret is a valid, attacker-computable HMAC key, so
 * a missing credential must be a hard refusal, never a silently-accepted
 * empty-string comparison.
 */
export function isStripeWebhookConfigured(
  secretKey: string | null | undefined,
  webhookSecret: string | null | undefined
): boolean {
  return !!secretKey?.trim() && !!webhookSecret?.trim();
}
