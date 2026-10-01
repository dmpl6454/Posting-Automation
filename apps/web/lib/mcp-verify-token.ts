import { prisma } from "@postautomation/db";
import {
  hashSecret,
  audienceMatches,
  hasScope,
  buildUnauthorizedChallenge,
  buildInsufficientScopeChallenge,
} from "@postautomation/api/src/lib/mcp-oauth";
import { mcpResourceUri, resourceMetadataUrl } from "./mcp-urls";

/**
 * Resource-server token verification for the MCP endpoint (2026-09-21).
 *
 * The MCP spec's requirements on the resource server are short and absolute:
 *   - validate the token,
 *   - "validate that access tokens were issued specifically for them as the
 *     intended audience",
 *   - "MUST only accept tokens that are valid for use with their own resources",
 *   - "MUST NOT accept or transit any other tokens",
 *   - invalid or expired ⇒ 401.
 *
 * This is the whole of that, in one place.
 */

export type McpAuthContext = {
  userId: string;
  organizationId: string;
  scopes: string[];
  clientId: string;
  tokenId: string;
  /**
   * Carried so the synthesized session can hand `protectedProcedure` the REAL
   * value rather than omitting the field. Verification already refuses a banned
   * user, so this is defence in depth — but `undefined` is falsy, so an omitted
   * field would silently pass that gate if this check were ever removed.
   */
  isBanned: boolean;
};

export type McpAuthFailure = {
  status: 401 | 403;
  error: string;
  description: string;
  challenge: string;
};

export type McpAuthResult =
  | { ok: true; ctx: McpAuthContext }
  | { ok: false; failure: McpAuthFailure };

function unauthorized(description: string): McpAuthResult {
  return {
    ok: false,
    failure: {
      status: 401,
      error: "invalid_token",
      description,
      // Points the client at Protected Resource Metadata — the spec's discovery
      // entry point, and the reason an unauthenticated 401 is useful rather than
      // a dead end.
      challenge: buildUnauthorizedChallenge(resourceMetadataUrl()),
    },
  };
}

/**
 * Extract and verify a bearer token.
 *
 * ⚠️ The header is the ONLY accepted location. The spec: "Access tokens MUST NOT
 * be included in the URI query string" — a token in a query string lands in
 * access logs, proxy logs and Referer headers.
 */
export async function verifyMcpToken(req: Request): Promise<McpAuthResult> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return unauthorized("Missing bearer token.");

  const presented = m[1]!.trim();
  if (!presented) return unauthorized("Missing bearer token.");

  const token = await prisma.mcpAccessToken.findUnique({
    where: { tokenHash: hashSecret(presented) },
  });
  // An unknown token and a revoked one get the SAME answer — distinguishing them
  // would confirm to an attacker that a value was once valid.
  if (!token) return unauthorized("Invalid or expired token.");
  if (token.revokedAt) return unauthorized("Invalid or expired token.");
  if (token.expiresAt.getTime() <= Date.now()) return unauthorized("Invalid or expired token.");

  /**
   * 🔴 THE AUDIENCE CHECK — the requirement that makes this server refuse to be
   * a confused deputy. A token minted for any other resource, including one this
   * same deployment issued for a different canonical URI, is rejected here.
   */
  if (!audienceMatches(token.resource, mcpResourceUri())) {
    console.warn(
      `[mcp] token audience mismatch: token=${token.resource} server=${mcpResourceUri()} client=${token.clientId}`
    );
    return unauthorized("This token was not issued for this server.");
  }

  /**
   * 🔴 RE-CHECK THE PRINCIPAL ON EVERY REQUEST, exactly as the NextAuth jwt
   * callback re-reads the User row on every auth(). A bearer token is a snapshot
   * of a consent that happened up to an hour ago (30 days, via refresh) — without
   * this, banning a user, deleting them, resetting their password or revoking the
   * client would all leave the AI connector working.
   *
   * ⚠️ `passwordChangedAt` matters MOST here. The web session already invalidates
   * on it, and CLAUDE.md records that invariant ("forces re-login everywhere after
   * a reset"). A password reset is what someone does when they believe they were
   * compromised, so a connector that survives it defeats the one action the user
   * took to lock the attacker out.
   */
  const [user, client] = await Promise.all([
    prisma.user.findUnique({
      where: { id: token.userId },
      select: { isBanned: true, deletedAt: true, passwordChangedAt: true },
    }),
    prisma.mcpOAuthClient.findUnique({
      where: { clientId: token.clientId },
      select: { revokedAt: true },
    }),
  ]);

  if (!user || user.deletedAt || user.isBanned) {
    return unauthorized("Invalid or expired token.");
  }
  if (!client || client.revokedAt) {
    return unauthorized("Invalid or expired token.");
  }
  if (user.passwordChangedAt && user.passwordChangedAt.getTime() > token.createdAt.getTime()) {
    // Retire the whole grant, not just this token — the refresh token would
    // otherwise mint a replacement seconds later.
    await prisma.mcpAccessToken
      .updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});
    return unauthorized("Invalid or expired token.");
  }

  // Best-effort: never let bookkeeping fail a valid request.
  prisma.mcpAccessToken
    .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    ok: true,
    ctx: {
      userId: token.userId,
      organizationId: token.organizationId,
      scopes: token.scopes,
      clientId: token.clientId,
      tokenId: token.id,
      isBanned: user.isBanned,
    },
  };
}

/**
 * Scope gate for an individual tool call.
 *
 * Returns a 403 `insufficient_scope` challenge naming every scope the operation
 * needs, which is what lets a client step up its authorization rather than
 * simply failing. The spec asks for all required scopes in ONE challenge —
 * dripping them out one at a time forces repeated trips through consent.
 */
export function requireScope(ctx: McpAuthContext, required: string): McpAuthFailure | null {
  if (hasScope(ctx.scopes, required)) return null;
  return {
    status: 403,
    error: "insufficient_scope",
    description: `This action requires the ${required} scope.`,
    challenge: buildInsufficientScopeChallenge(resourceMetadataUrl(), [required]),
  };
}

/** Render a failure as the HTTP response the spec prescribes. */
export function authFailureResponse(f: McpAuthFailure): Response {
  return new Response(JSON.stringify({ error: f.error, error_description: f.description }), {
    status: f.status,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": f.challenge,
      "Cache-Control": "no-store",
    },
  });
}
