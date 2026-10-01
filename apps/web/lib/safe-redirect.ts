/**
 * A post-login destination that can only ever be a path on THIS site
 * (security audit 2026-09-28).
 *
 * Parsed with the URL parser against a placeholder origin rather than checked
 * with a prefix test: browsers strip tabs and newlines and treat "\" as "/" in
 * special-scheme URLs, so "/\t/evil.example" or "/\evil.example" pass a
 * "starts with a single slash" check and still leave the site. If the parsed
 * origin is not the placeholder, the input named another origin (or a scheme
 * such as javascript:, whose origin is "null") and is refused.
 *
 * Returns only path + query + hash, so the result is navigation-safe as-is.
 */
const PLACEHOLDER_ORIGIN = "https://callback.invalid";

export function safeCallbackPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return fallback;
  const candidate = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  // ⚠️ Re-resolve the OUTPUT too. Parsing normalises dot-segments, so
  // "/..//evil.example" yields the path "//evil.example" — same origin as a
  // parsed URL, but a protocol-relative link to another site once navigated to.
  // Checking the result against the invariant itself closes that whole class.
  let again: URL;
  try {
    again = new URL(candidate, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  return again.origin === PLACEHOLDER_ORIGIN && !candidate.startsWith("//") ? candidate : fallback;
}

/**
 * A boolean gate for "is this link safe to navigate to", used where the caller
 * should do NOTHING on a bad link rather than silently substitute a fallback
 * destination (notification click handlers — security audit 2026-09-28).
 * notification.create was reachable by any app-role ADMIN with no org-membership
 * check on the target, so `link` was attacker-influenced data, not our own.
 */
export function isSafeInAppLink(link: string | null | undefined): boolean {
  if (!link) return false;
  return safeCallbackPath(link, "") === link;
}
