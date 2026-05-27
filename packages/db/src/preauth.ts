/**
 * Pre-authorised accounts
 * ─────────────────────────────────────────────────────────────────────────────
 * Emails listed here are granted ENTERPRISE plan automatically when they first
 * sign up (OAuth or credentials). `planExpiresAt` is set so the plan auto-reverts
 * to FREE after the specified number of days — enforced by orgProcedure's
 * planExpiresAt guard without any cron job.
 *
 * tabish@dashmani.com is NOT listed here — his access is permanent via
 * User.isSuperAdmin which bypasses all plan limits regardless of org plan.
 *
 * To add/remove access: edit this file + redeploy. No DB migration needed.
 */

export interface PreauthEntry {
  /** Days from first sign-up until plan auto-reverts to FREE. */
  trialDays: number;
}

/** Keyed by lowercase email. */
export const PREAUTH_EMAILS: Record<string, PreauthEntry> = {
  "aditi@dashmani.com":            { trialDays: 30 },
  "ameya.kulkarni25@ies.edu":      { trialDays: 30 },
};

/**
 * Returns the org creation overrides for a pre-authorised email,
 * or null if the email is not pre-authorised.
 */
export function getPreauthOrgData(email: string): {
  plan: "ENTERPRISE";
  planExpiresAt: Date;
} | null {
  const entry = PREAUTH_EMAILS[email.toLowerCase()];
  if (!entry) return null;

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + entry.trialDays);

  return { plan: "ENTERPRISE", planExpiresAt: expiresAt };
}
