/**
 * The canonical URLs the MCP OAuth surface advertises (2026-09-21).
 *
 * ⚠️ ONE source of truth. These strings appear in Protected Resource Metadata,
 * in Authorization Server Metadata, in the `iss` of every authorization
 * response, and in the audience recorded on every token — and the audience check
 * is an exact comparison. If two of them disagree, every token this server
 * issues is rejected by this same server.
 */

/**
 * The deployment's own origin.
 *
 * ⚠️ Derived from env, never from the request's Host header. Trusting Host would
 * let an attacker with a spoofed header make us advertise metadata — and mint
 * `iss` values — for a domain we do not control.
 *
 * CLAUDE.md records that docker-compose.prod.yml uses an EXPLICIT environment
 * allowlist, so a key present in .env.prod but absent from compose arrives as an
 * empty string. Hence the `.trim()` and the explicit fallback chain rather than
 * `??`, which would happily accept "".
 */
export function appOrigin(): string {
  const candidates = [process.env.APP_URL, process.env.NEXTAUTH_URL, process.env.AUTH_URL];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v) return v.replace(/\/+$/, "");
  }
  // Local development only — production always has APP_URL/NEXTAUTH_URL set.
  return "http://127.0.0.1:3000";
}

/**
 * The MCP endpoint's canonical URI — the RFC 8707 `resource` value and the
 * audience every token is bound to.
 *
 * ⚠️ No trailing slash. The spec asks implementations to prefer that form, and
 * canonicalizeResource() normalises to it, so the two agree by construction.
 */
export function mcpResourceUri(): string {
  return `${appOrigin()}/api/mcp`;
}

/** RFC 9728 document location, named in every WWW-Authenticate challenge. */
export function resourceMetadataUrl(): string {
  return `${appOrigin()}/.well-known/oauth-protected-resource`;
}

/**
 * The authorization server's issuer identifier.
 *
 * ⚠️ Clients compare the `iss` we return against this, byte for byte, with no
 * normalisation permitted on their side — the spec explicitly forbids case
 * folding, default-port elision and trailing-slash normalisation before
 * comparison. So this must be emitted identically everywhere.
 */
export function issuer(): string {
  return appOrigin();
}

export const OAUTH_PATHS = {
  authorize: "/oauth/authorize",
  token: "/api/mcp/oauth/token",
  register: "/api/mcp/oauth/register",
} as const;
