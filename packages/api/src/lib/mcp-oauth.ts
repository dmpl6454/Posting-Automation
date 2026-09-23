import crypto from "crypto";

/**
 * OAuth 2.1 authorization-server core for the MCP connector (2026-09-21).
 *
 * WE are the authorization server AND the resource server. An MCP client
 * (Claude Desktop, ChatGPT, Claude Code) obtains a token here and presents it to
 * our MCP endpoint.
 *
 * Everything in this module is PURE — no Prisma, no fetch, no env — so the parts
 * that must not be wrong can be tested exhaustively without infrastructure.
 *
 * ⚠️ Deliberately NOT a new workspace package. packages/api is already a
 * dependency of apps/web, so this adds no entry to docker/Dockerfile.worker —
 * see CLAUDE.md quirk #10, where a package added to only one of the two required
 * lists crash-looped the worker and stopped all queue processing.
 */

// ─────────────────────────── scopes ───────────────────────────

/**
 * The scope vocabulary. Deliberately small: a scope the user cannot reason about
 * is a scope they cannot consent to meaningfully.
 *
 * ⚠️ `mcp:publish` is the irreversible one. It is separate from `mcp:write` even
 * though the owner asked for full access, because the consent screen has to be
 * able to SAY "this app can publish to your channels" as its own line. Granting
 * both by default is a product decision; conflating them removes the ability to
 * describe what was granted.
 */
export const MCP_SCOPES = {
  READ: "mcp:read",
  WRITE: "mcp:write",
  PUBLISH: "mcp:publish",
} as const;

export type McpScope = (typeof MCP_SCOPES)[keyof typeof MCP_SCOPES];

export const ALL_MCP_SCOPES: McpScope[] = [MCP_SCOPES.READ, MCP_SCOPES.WRITE, MCP_SCOPES.PUBLISH];

/** Human-readable consent copy. What the user actually reads before clicking Allow. */
export const SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  [MCP_SCOPES.READ]: "Read your channels, posts, media and analytics",
  [MCP_SCOPES.WRITE]: "Create and edit drafts, and schedule posts",
  [MCP_SCOPES.PUBLISH]: "Publish posts to your connected channels immediately",
};

/**
 * Scope hierarchy: a broader scope implies the narrower ones.
 *
 * The MCP spec requires this explicitly — "Servers MUST account for scope
 * hierarchies, where a broader scope implies narrower ones, when deciding
 * whether a token is sufficient for an operation." Without it a token holding
 * only `mcp:publish` would be refused a read it is plainly entitled to.
 */
const IMPLIES: Record<string, string[]> = {
  [MCP_SCOPES.PUBLISH]: [MCP_SCOPES.WRITE, MCP_SCOPES.READ],
  [MCP_SCOPES.WRITE]: [MCP_SCOPES.READ],
  [MCP_SCOPES.READ]: [],
};

/** Expand granted scopes to everything they imply. */
export function expandScopes(granted: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const s of granted) {
    out.add(s);
    for (const implied of IMPLIES[s] ?? []) out.add(implied);
  }
  return out;
}

/** Does this token satisfy the scope an operation requires? */
export function hasScope(granted: readonly string[], required: string): boolean {
  return expandScopes(granted).has(required);
}

/** Keep only scopes we actually define — an unknown scope is dropped, never granted. */
export function sanitizeScopes(requested: readonly string[] | undefined): McpScope[] {
  if (!requested?.length) return [];
  const known = new Set<string>(ALL_MCP_SCOPES);
  const out: McpScope[] = [];
  for (const s of requested) {
    if (known.has(s) && !out.includes(s as McpScope)) out.push(s as McpScope);
  }
  return out;
}

/** Parse an OAuth space-delimited scope string. */
export function parseScopeParam(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope.split(/\s+/).filter(Boolean);
}

// ─────────────────────────── secrets ───────────────────────────

/**
 * ⚠️ Every credential is stored as sha256 and compared as sha256.
 *
 * A plain hash (rather than bcrypt/argon) is correct HERE and only here: these
 * are 256-bit values WE generate, so there is no password to brute-force and no
 * dictionary to attack. The same reasoning the existing ApiKey model uses.
 */
export function hashSecret(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

/** A 256-bit URL-safe random secret. */
export function generateSecret(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

/**
 * Constant-time compare for two hex digests.
 *
 * ⚠️ Length is checked in BYTES after decoding, not on the JS string.
 * `timingSafeEqual` throws on a length mismatch, and CLAUDE.md records a real
 * incident where comparing `.length` on a UTF-16 string and then calling
 * `timingSafeEqual` on bytes let a crafted header throw out of a route.
 */
export function safeCompareHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ─────────────────────────── PKCE ───────────────────────────

/**
 * Verify an RFC 7636 PKCE challenge.
 *
 * ⚠️ `plain` is REFUSED outright. OAuth 2.1 removes it, these are public clients,
 * and accepting it would let anyone who intercepts an authorization code redeem
 * it. Only S256.
 */
export function verifyPkce(
  codeVerifier: string,
  storedChallenge: string,
  method: string
): boolean {
  if (method !== "S256") return false;
  // RFC 7636: verifier is 43-128 chars from an unreserved alphabet.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) return false;
  const computed = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  // Both are base64url of a 32-byte digest — compare as bytes, constant time.
  const a = Buffer.from(computed, "base64url");
  const b = Buffer.from(storedChallenge, "base64url");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─────────────────────── resource / audience ───────────────────────

/**
 * Canonicalise an RFC 8707 resource indicator so a stored audience and a
 * presented one compare reliably.
 *
 * Per the MCP spec: lowercase scheme and host, no fragment, and prefer no
 * trailing slash. An uppercase scheme/host is ACCEPTED for robustness (the spec
 * says SHOULD accept) but normalised here so both sides agree.
 *
 * Returns null for anything that is not a usable absolute URI — a missing
 * scheme or a fragment are both explicitly invalid in the spec.
 */
export function canonicalizeResource(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // A fragment makes it invalid per the spec's own examples.
  if (u.hash) return null;
  const scheme = u.protocol.toLowerCase();
  const host = u.host.toLowerCase();
  let path = u.pathname;
  if (path === "/") path = "";
  // Query is not part of a resource identifier.
  return `${scheme}//${host}${path}`;
}

/**
 * 🔴 THE AUDIENCE CHECK. The MCP spec is unambiguous: "MCP servers MUST validate
 * that access tokens were issued specifically for them as the intended
 * audience", "MUST only accept tokens that are valid for use with their own
 * resources", and "MUST NOT accept or transit any other tokens."
 *
 * Without this, a token minted for any other resource — including a token this
 * same server issued for a different deployment — would be honoured, which is
 * precisely the confused-deputy attack the requirement exists to stop.
 */
export function audienceMatches(tokenResource: string, serverResource: string): boolean {
  const a = canonicalizeResource(tokenResource);
  const b = canonicalizeResource(serverResource);
  return !!a && !!b && a === b;
}

// ─────────────────────── redirect URI validation ───────────────────────

/**
 * Is this redirect URI acceptable to register / to redirect to?
 *
 * ⚠️ Open redirection is one of the named attacks in the MCP security
 * requirements. The rules:
 *   - https is always fine.
 *   - http is allowed ONLY for loopback (127.0.0.1 / ::1), which is how every
 *     desktop MCP client receives its callback. NOT for "localhost" by name,
 *     which can be repointed by DNS.
 *   - Custom schemes (e.g. claude://) are allowed: native apps use them and they
 *     cannot be intercepted over the network.
 *   - No fragment, ever (RFC 6749 §3.1.2).
 */
export function isValidRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") {
    return u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  }
  // A custom scheme must actually be a scheme, not "javascript:" and friends.
  if (u.protocol === "javascript:" || u.protocol === "data:" || u.protocol === "file:") return false;
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/**
 * Exact-match the redirect URI presented at /authorize against the registered
 * set.
 *
 * ⚠️ EXACT string comparison, never prefix or origin matching. OAuth 2.1
 * requires it: a prefix match on `https://app.example/cb` happily accepts
 * `https://app.example/cb.evil.com/x` and hands over the authorization code.
 */
export function redirectUriAllowed(presented: string, registered: readonly string[]): boolean {
  return registered.includes(presented);
}

// ─────────────────────── WWW-Authenticate ───────────────────────

/**
 * The 401 challenge. The MCP spec requires the resource server to point clients
 * at its Protected Resource Metadata here — it is how a client discovers which
 * authorization server to use at all.
 */
export function buildUnauthorizedChallenge(resourceMetadataUrl: string, scope?: string): string {
  const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
  if (scope) parts.push(`scope="${scope}"`);
  return parts.join(", ");
}

/**
 * The 403 challenge for a token that is valid but under-scoped. Per the spec
 * this carries `error="insufficient_scope"` and names every scope the operation
 * needs — "servers SHOULD include all scopes required for the current operation
 * in a single challenge", because challenging one at a time forces repeated
 * round-trips through consent.
 */
export function buildInsufficientScopeChallenge(
  resourceMetadataUrl: string,
  requiredScopes: readonly string[],
  description?: string
): string {
  const parts = [
    `Bearer error="insufficient_scope"`,
    `scope="${requiredScopes.join(" ")}"`,
    `resource_metadata="${resourceMetadataUrl}"`,
  ];
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}

// ─────────────────────── lifetimes ───────────────────────

/**
 * Short access tokens, longer refresh. A leaked access token stops working in an
 * hour; a refresh token is single-use and rotates (handled at the token
 * endpoint), so a stolen one is detectable by reuse.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
/** Deliberately brief — a code is exchanged within seconds of the redirect. */
export const AUTH_CODE_TTL_SECONDS = 60;

export function expiresAt(seconds: number, now: Date): Date {
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * Narrow a requested scope set to what the client is registered to receive.
 *
 * 🔴 The consent screen and the consent ACTION must agree exactly, or the screen
 * describes one grant and the server mints another. Sharing one function is what
 * makes that structural rather than a convention two files happen to follow.
 *
 * Both inputs are untrusted: `requested` arrives in a query string and then in a
 * hidden form field, `allowed` is whatever the client sent to dynamic
 * registration. An empty `allowed` means the client registered no ceiling, which
 * is the spec's "all supported scopes" default — NOT "no scopes", which would
 * make every default registration unusable.
 */
export function narrowToClientScopes(requested: string[], allowed: string[]): McpScope[] {
  const ceiling = sanitizeScopes(allowed.length ? allowed : [...ALL_MCP_SCOPES]);
  const asked = sanitizeScopes(requested);
  // An absent request means "everything you offer", bounded by the ceiling.
  const effective = asked.length ? asked : ceiling;
  return effective.filter((s) => ceiling.includes(s));
}
