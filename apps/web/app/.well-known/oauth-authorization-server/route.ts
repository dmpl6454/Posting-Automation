import { NextResponse } from "next/server";
import { ALL_MCP_SCOPES } from "@postautomation/api/src/lib/mcp-oauth";
import { appOrigin, issuer, OAUTH_PATHS } from "~/lib/mcp-urls";

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * The MCP spec requires an authorization server to provide at least one of RFC
 * 8414 or OpenID Connect Discovery; this is the former. Clients read it to find
 * the authorize, token and registration endpoints.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const base = appOrigin();
  return NextResponse.json(
    {
      issuer: issuer(),
      authorization_endpoint: `${base}${OAUTH_PATHS.authorize}`,
      token_endpoint: `${base}${OAUTH_PATHS.token}`,
      // Dynamic Client Registration. The draft spec now marks DCR deprecated in
      // favour of Client ID Metadata Documents — but every shipping MCP client
      // still registers dynamically, so omitting this endpoint would make the
      // connector unusable from Claude and ChatGPT today.
      registration_endpoint: `${base}${OAUTH_PATHS.register}`,

      scopes_supported: ALL_MCP_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],

      // ⚠️ S256 ONLY. OAuth 2.1 removes `plain`, and these are public clients:
      // advertising plain would invite a client to use it, and verifyPkce
      // refuses it anyway — so advertising it would be a lie that breaks clients.
      code_challenge_methods_supported: ["S256"],

      // `none` is the normal MCP case: a desktop client is a public client and
      // cannot keep a secret. PKCE is what protects the exchange.
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],

      // 🔴 We DO return `iss` on every authorization response (RFC 9207), so we
      // advertise it. The spec is explicit that a server which sets this to true
      // MUST include the parameter — and a client that sees `true` will REJECT
      // any response missing it. These two facts must stay in lockstep.
      authorization_response_iss_parameter_supported: true,

      service_documentation: `${base}/docs/mcp`,
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
