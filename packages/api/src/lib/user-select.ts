/**
 * The User fields a procedure may return to a browser.
 *
 * ⚠️ Never the password hash, the impersonation revocation marker
 * (activeImpersonationJti) or passwordChangedAt. A bare
 * `prisma.user.update(...)` / `findUnique({ include })` returns the WHOLE row,
 * and four procedures did exactly that: user.updateProfile handed the caller
 * their own hash, and admin.users.getById / toggleSuperAdmin / toggleBan handed
 * a super admin's browser other users' hashes (found 2026-10-02). Select this
 * instead; an explicit allow-list also keeps any column added later private
 * until someone decides otherwise.
 */
export const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  emailVerified: true,
  image: true,
  isSuperAdmin: true,
  appRole: true,
  isBanned: true,
  phone: true,
  phoneVerified: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
