/**
 * /api/auth/register used to return a distinguishable response for an email
 * that already has an account — a different HTTP status (409 vs 200) and,
 * for an OAuth-only email, the exact provider name in the message body — a
 * direct, unauthenticated existence (and provider-fingerprinting) oracle
 * (security audit 2026-09-28, account enumeration).
 *
 * This mirrors requestPasswordReset's existing invariant (packages/api/src/
 * routers/auth.router.ts): never leak account existence via the API
 * response; if a real owner needs to know something, tell them over email
 * instead. Pure decision logic, extracted so it's testable — the route
 * itself sits under apps/web/app/**, which the repo's vitest config
 * deliberately excludes (see CLAUDE.md).
 */

export interface ExistingAccountForRegister {
  password: string | null;
  accounts: { provider: string }[];
}

export type RegisterDecision =
  | { action: "create" }
  | { action: "notify-existing"; oauthProviders: string[] };

/**
 * Decide what /api/auth/register should DO for a given email, given whatever
 * account (if any) already exists for it. The caller must send the SAME
 * {status: 200, body: {success: true}} response for either outcome — that
 * invariant is what actually closes the enumeration gap, and is asserted by
 * a source-lock test on the route file rather than here (this function only
 * decides the internal action, never touches the HTTP layer).
 */
export function decideRegisterAction(existing: ExistingAccountForRegister | null): RegisterDecision {
  if (!existing) return { action: "create" };
  return { action: "notify-existing", oauthProviders: existing.accounts.map((a) => a.provider) };
}
