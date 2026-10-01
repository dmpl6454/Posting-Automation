/**
 * Client-side state of an admin impersonation session. The token cookie is
 * written from JS (admin/users page), so it is not HttpOnly and survives a
 * NextAuth sign-out unless something deletes it explicitly.
 */
export const IMPERSONATION_COOKIE = "admin-impersonate";

const EXPIRED_COOKIE = `${IMPERSONATION_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;

export function hasImpersonationCookie(cookieHeader: string): boolean {
  return cookieHeader
    .split(";")
    .some((c) => c.trim().startsWith(`${IMPERSONATION_COOKIE}=`));
}

export function clearImpersonationCookie(doc: { cookie: string } = document): void {
  doc.cookie = EXPIRED_COOKIE;
}

/**
 * Cookie + the impersonated user's org, which OrgInit stored as currentOrgId.
 * Left behind, the admin's own requests keep sending that org as
 * x-organization-id and mismatch the admin's real channels.
 */
export function clearImpersonationClientState(
  doc: { cookie: string } = document,
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  clearImpersonationCookie(doc);
  try {
    storage.removeItem("currentOrgId");
  } catch {
    // Storage can throw (blocked site data); the cookie is what matters.
  }
}
