import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@postautomation/db";
import {
  hashSecret,
  safeCompareHex,
  verifyPkce,
  canonicalizeResource,
  audienceMatches,
  generateSecret,
  expiresAt,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from "@postautomation/api/src/lib/mcp-oauth";
import { mcpResourceUri } from "~/lib/mcp-urls";

/**
 * OAuth 2.1 token endpoint for the MCP connector.
 *
 * Handles `authorization_code` (with mandatory PKCE) and `refresh_token` (with
 * rotation). This is where an intercepted code or a stolen refresh token would
 * be cashed in, so every check here is load-bearing.
 */
export const dynamic = "force-dynamic";

function oauthError(error: string, description: string, status = 400) {
  // RFC 6749 §5.2 error shape. `no-store` is required for token responses.
  return NextResponse.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}

/** Accepts form-encoded (the spec's requirement) and tolerates JSON. */
async function readParams(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({}));
    return Object.fromEntries(
      Object.entries(j ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")])
    );
  }
  const form = await req.formData().catch(() => null);
  if (!form) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === "string" ? v : "";
  return out;
}

export async function POST(req: NextRequest) {
  const p = await readParams(req);
  const grantType = p.grant_type;

  if (grantType === "authorization_code") return handleAuthCode(p);
  if (grantType === "refresh_token") return handleRefresh(p);
  return oauthError("unsupported_grant_type", "Supported grants: authorization_code, refresh_token.");
}

async function handleAuthCode(p: Record<string, string>) {
  const { code, client_id: clientId, redirect_uri: redirectUri, code_verifier: codeVerifier } = p;

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError(
      "invalid_request",
      "code, client_id, redirect_uri and code_verifier are all required."
    );
  }

  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
  if (!client || client.revokedAt) return oauthError("invalid_client", "Unknown client.", 401);

  // A confidential client must prove itself; a public client must NOT send a
  // secret. PKCE is what protects the public case.
  if (client.clientSecretHash) {
    const presented = p.client_secret;
    if (!presented || !safeCompareHex(hashSecret(presented), client.clientSecretHash)) {
      return oauthError("invalid_client", "Client authentication failed.", 401);
    }
  }

  const authCode = await prisma.mcpAuthCode.findUnique({ where: { codeHash: hashSecret(code) } });
  if (!authCode) return oauthError("invalid_grant", "Unknown or expired authorization code.");

  /**
   * 🔴 REPLAY HANDLING. OAuth 2.1: if an authorization code is used more than
   * once, the server SHOULD revoke every token already issued from it. A second
   * presentation means either the client is buggy or the code leaked — and if it
   * leaked, the tokens minted from it are in someone else's hands.
   *
   * Done BEFORE any other check so a replay is contained even if the request is
   * otherwise malformed.
   */
  if (authCode.usedAt) {
    await prisma.mcpAccessToken.updateMany({
      where: {
        clientId: authCode.clientId,
        userId: authCode.userId,
        revokedAt: null,
        createdAt: { gte: authCode.usedAt },
      },
      data: { revokedAt: new Date() },
    });
    console.warn(
      `[mcp-oauth] authorization code REPLAY for client=${authCode.clientId} user=${authCode.userId} — issued tokens revoked`
    );
    return oauthError("invalid_grant", "This authorization code has already been used.");
  }

  if (authCode.expiresAt.getTime() <= Date.now()) {
    return oauthError("invalid_grant", "Authorization code has expired.");
  }
  if (authCode.clientId !== clientId) {
    return oauthError("invalid_grant", "This code was not issued to this client.");
  }
  // Exact match — the code is bound to the exact URI the user was redirected to.
  if (authCode.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (!verifyPkce(codeVerifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
    return oauthError("invalid_grant", "PKCE verification failed.");
  }

  /**
   * RFC 8707: if the client names a resource here it must be the one the code
   * was issued for. Silently re-binding the audience would defeat the audience
   * check the resource server performs.
   */
  if (p.resource) {
    const requested = canonicalizeResource(p.resource);
    if (!requested || !audienceMatches(authCode.resource, requested)) {
      return oauthError("invalid_target", "resource does not match the authorization request.");
    }
  }

  // Burn the code first. A race that redeems it twice must lose here, not after
  // a second token has been minted.
  const burned = await prisma.mcpAuthCode.updateMany({
    where: { id: authCode.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (burned.count === 0) {
    return oauthError("invalid_grant", "This authorization code has already been used.");
  }

  return issueTokens({
    clientId,
    userId: authCode.userId,
    organizationId: authCode.organizationId,
    scopes: authCode.scopes,
    resource: authCode.resource,
    withRefresh: client.grantTypes.includes("refresh_token"),
  });
}

async function handleRefresh(p: Record<string, string>) {
  const { refresh_token: refreshToken, client_id: clientId } = p;
  if (!refreshToken || !clientId) {
    return oauthError("invalid_request", "refresh_token and client_id are required.");
  }

  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
  if (!client || client.revokedAt) return oauthError("invalid_client", "Unknown client.", 401);
  if (client.clientSecretHash) {
    const presented = p.client_secret;
    if (!presented || !safeCompareHex(hashSecret(presented), client.clientSecretHash)) {
      return oauthError("invalid_client", "Client authentication failed.", 401);
    }
  }

  const existing = await prisma.mcpAccessToken.findUnique({
    where: { refreshTokenHash: hashSecret(refreshToken) },
  });
  if (!existing) return oauthError("invalid_grant", "Unknown refresh token.");
  if (existing.clientId !== clientId) {
    return oauthError("invalid_grant", "This refresh token was not issued to this client.");
  }

  /**
   * 🔴 ROTATION + REUSE DETECTION. Refresh tokens are single-use. Presenting one
   * that is already revoked means the token leaked and someone is racing the
   * legitimate client — so every live token for this (client, user) pair is
   * revoked, forcing a fresh consent rather than letting the attacker continue.
   */
  if (existing.revokedAt) {
    await prisma.mcpAccessToken.updateMany({
      where: { clientId: existing.clientId, userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.warn(
      `[mcp-oauth] refresh token REUSE for client=${existing.clientId} user=${existing.userId} — all tokens revoked`
    );
    return oauthError("invalid_grant", "Refresh token has already been used.");
  }

  if (existing.refreshExpiresAt && existing.refreshExpiresAt.getTime() <= Date.now()) {
    return oauthError("invalid_grant", "Refresh token has expired.");
  }

  // Retire the old row, then mint a new pair carrying the SAME audience and
  // scopes — a refresh must never broaden either.
  await prisma.mcpAccessToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  return issueTokens({
    clientId,
    userId: existing.userId,
    organizationId: existing.organizationId,
    scopes: existing.scopes,
    resource: existing.resource,
    withRefresh: true,
  });
}

async function issueTokens(args: {
  clientId: string;
  userId: string;
  organizationId: string;
  scopes: string[];
  resource: string;
  withRefresh: boolean;
}) {
  const now = new Date();
  const accessToken = generateSecret("mcp_at");
  const refreshToken = args.withRefresh ? generateSecret("mcp_rt") : null;

  await prisma.mcpAccessToken.create({
    data: {
      tokenHash: hashSecret(accessToken),
      refreshTokenHash: refreshToken ? hashSecret(refreshToken) : null,
      clientId: args.clientId,
      userId: args.userId,
      organizationId: args.organizationId,
      scopes: args.scopes,
      // Carried through unchanged — this is what the resource server compares
      // against its own canonical URI on every request.
      resource: args.resource,
      expiresAt: expiresAt(ACCESS_TOKEN_TTL_SECONDS, now),
      refreshExpiresAt: refreshToken ? expiresAt(REFRESH_TOKEN_TTL_SECONDS, now) : null,
    },
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: args.scopes.join(" "),
      // Echoed so a client can confirm the audience it received.
      resource: args.resource || mcpResourceUri(),
    },
    { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } }
  );
}
