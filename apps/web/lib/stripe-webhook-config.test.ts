/**
 * The Stripe webhook route MUST refuse to verify anything with an empty
 * secret (security audit 2026-09-28) — the same class of bug this codebase
 * already fixed once for the Meta webhook verifier: `crypto.createHmac(
 * "sha256", "")` is a VALID, attacker-computable HMAC. docker-compose.prod.yml
 * plumbs STRIPE_WEBHOOK_SECRET via an explicit `${VAR}` substitution, and
 * Stripe credentials are documented as one of the sets intentionally left
 * blank in this deployment — so a missing key in .env.prod does not fail to
 * start the container, it arrives inside it as the literal empty string.
 * With Stripe's SDK, that means `stripe.webhooks.constructEvent(body, sig, "")`
 * would accept a signature anyone can compute, letting a forged event
 * (upgrade a plan, mark an invoice paid) reach handleStripeWebhook.
 */
import { describe, it, expect } from "vitest";
import { isStripeWebhookConfigured } from "./stripe-webhook-config";

describe("isStripeWebhookConfigured", () => {
  it("is configured only when BOTH the secret key and webhook secret are real values", () => {
    expect(isStripeWebhookConfigured("sk_live_x", "whsec_x")).toBe(true);
  });

  it("fails closed on an empty webhook secret — the exact compose-substitution shape", () => {
    expect(isStripeWebhookConfigured("sk_live_x", "")).toBe(false);
  });

  it("fails closed on an empty secret key", () => {
    expect(isStripeWebhookConfigured("", "whsec_x")).toBe(false);
  });

  it("fails closed on undefined (unset) values, not just empty strings", () => {
    expect(isStripeWebhookConfigured(undefined, "whsec_x")).toBe(false);
    expect(isStripeWebhookConfigured("sk_live_x", undefined)).toBe(false);
    expect(isStripeWebhookConfigured(undefined, undefined)).toBe(false);
  });

  it("fails closed on whitespace-only values — a stray blank line in .env.prod must not count as configured", () => {
    expect(isStripeWebhookConfigured("sk_live_x", "   ")).toBe(false);
    expect(isStripeWebhookConfigured("   ", "whsec_x")).toBe(false);
  });
});
