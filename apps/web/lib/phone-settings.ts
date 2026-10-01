/**
 * What the Settings → Mobile Number card offers. Replacing a verified phone
 * with a different number requires the current password (user.addPhone
 * step-up), so an account without a password can only remove its number.
 */
export type PhoneCardMode = "add" | "change" | "remove-only";

export function phoneCardMode(
  user: { phone?: string | null; hasPassword?: boolean } | null | undefined
): PhoneCardMode {
  if (!user?.phone) return "add";
  return user.hasPassword ? "change" : "remove-only";
}
