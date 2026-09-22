import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@postautomation/db";
import {
  generateSecret,
  hashSecret,
  isValidRedirectUri,
  sanitizeScopes,
  parseScopeParam,
  ALL_MCP_SCOPES,
} from "@postautomation/api/src/lib/mcp-oauth";

/**
 * RFC 7591 Dynamic Client Registration.
 *
 * This is how Claude Desktop, claude.ai and ChatGPT add a custom connector: they
 * discover this endpoint from Authorization Server Metadata and register
 * themselves before starting the authorization flow. The draft MCP spec now
 * prefers Client ID Metadata Documents and marks DCR deprecated, but no shipping
 * client uses that yet, so this is required for the connector to work at all.
 *
 * ⚠️ UNAUTHENTICATED BY DESIGN — that is what "dynamic" means, and the spec
 * intends it. Registering a client therefore grants NOTHING on its own: a client
 * with no user consent can obtain no token. The real boundary is the consent
 * screen, which shows the user this client's name AND redirect URI so a
 * plausible-sounding impostor can still be recognised.
 *
 * What this endpoint must get right is (a) never storing a redirect URI that
 * enables open redirection, and (b) not being a free write primitive.
 */
export const dynamic = "force-dynamic";

/** Bound the damage an unauthenticated write endpoint can do. */
const MAX_REDIRECT_URIS = 10;
const MAX_NAME_LENGTH = 200;

function badRequest(error: string, description: string) {
  // RFC 7591 §3.2.2 error shape.
  return NextResponse.json({ error, error_description: description }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid_client_metadata", "Body must be JSON.");
  }
  if (!body || typeof body !== "object") {
    return badRequest("invalid_client_metadata", "Body must be a JSON object.");
  }

  // ── redirect_uris: the security-critical field ──────────────────────────
  const redirectUris: unknown = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return badRequest("invalid_redirect_uri", "redirect_uris is required and must be a non-empty array.");
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    return badRequest("invalid_redirect_uri", `At most ${MAX_REDIRECT_URIS} redirect URIs.`);
  }
  const uris: string[] = [];
  for (const u of redirectUris) {
    if (typeof u !== "string" || !isValidRedirectUri(u)) {
      // Named explicitly: a client author debugging this needs to know WHICH
      // URI we refused and why, or they cannot fix it.
      return badRequest(
        "invalid_redirect_uri",
        `Not an acceptable redirect URI: ${typeof u === "string" ? u : "(non-string)"}. ` +
          `Use https, a loopback http address (127.0.0.1 or ::1), or a custom scheme. No fragments.`
      );
    }
    if (!uris.includes(u)) uris.push(u);
  }

  // ── the rest is advisory metadata ───────────────────────────────────────
  const clientName =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, MAX_NAME_LENGTH)
      : "Unnamed MCP client";

  // We only ever issue authorization codes and refresh tokens. Anything else a
  // client asks for is dropped rather than honoured.
  const requestedGrants: string[] = Array.isArray(body.grant_types) ? body.grant_types : [];
  const grantTypes = ["authorization_code", "refresh_token"].filter(
    (g) => requestedGrants.length === 0 || requestedGrants.includes(g)
  );
  if (grantTypes.length === 0) {
    return badRequest(
      "invalid_client_metadata",
      "Only authorization_code and refresh_token grants are supported."
    );
  }

  // Scope requested at registration is a CEILING the client asks for; the user
  // still consents per-authorization. Unknown scopes are dropped, never granted.
  const scopes = sanitizeScopes(parseScopeParam(body.scope));

  /**
   * ⚠️ PUBLIC client by default. `token_endpoint_auth_method: "none"` is the
   * normal MCP case — a desktop app cannot keep a secret, and PKCE is what
   * actually protects the exchange. A secret is minted ONLY if the client
   * explicitly asks to be confidential.
   */
  const wantsSecret = body.token_endpoint_auth_method === "client_secret_post";
  const clientSecret = wantsSecret ? generateSecret("mcp_cs") : null;

  const clientId = generateSecret("mcp_client");

  const created = await prisma.mcpOAuthClient.create({
    data: {
      clientId,
      clientSecretHash: clientSecret ? hashSecret(clientSecret) : null,
      clientName,
      redirectUris: uris,
      grantTypes,
      scopes: scopes.length ? scopes : ALL_MCP_SCOPES,
      // Kept verbatim for audit — useful when working out which client a user
      // actually approved months later.
      metadata: {
        submitted: {
          client_uri: typeof body.client_uri === "string" ? body.client_uri.slice(0, 500) : undefined,
          logo_uri: typeof body.logo_uri === "string" ? body.logo_uri.slice(0, 500) : undefined,
          software_id: typeof body.software_id === "string" ? body.software_id.slice(0, 200) : undefined,
        },
      },
    },
    select: { clientId: true, clientName: true, redirectUris: true, grantTypes: true, scopes: true, createdAt: true },
  });

  // RFC 7591 §3.2.1 — 201 with the registered metadata echoed back.
  // ⚠️ The secret is returned HERE and never again; only its hash is stored.
  return NextResponse.json(
    {
      client_id: created.clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
      // 0 = does not expire, per RFC 7591.
      ...(clientSecret ? { client_secret_expires_at: 0 } : {}),
      client_name: created.clientName,
      redirect_uris: created.redirectUris,
      grant_types: created.grantTypes,
      response_types: ["code"],
      scope: created.scopes.join(" "),
      token_endpoint_auth_method: clientSecret ? "client_secret_post" : "none",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}
