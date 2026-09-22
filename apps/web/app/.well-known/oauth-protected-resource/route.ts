import { NextResponse } from "next/server";
import { ALL_MCP_SCOPES } from "@postautomation/api/src/lib/mcp-oauth";
import { appOrigin, mcpResourceUri } from "~/lib/mcp-urls";

/**
 * RFC 9728 Protected Resource Metadata.
 *
 * ⚠️ MANDATORY. The MCP spec: "MCP servers MUST implement OAuth 2.0 Protected
 * Resource Metadata" and "MCP clients MUST use [it] for authorization server
 * discovery." A client that gets a 401 from our MCP endpoint reads the
 * `resource_metadata` URL out of the WWW-Authenticate header and fetches THIS —
 * it is the entry point to the whole flow. Without it, no client can connect.
 *
 * Public and unauthenticated by design: it is discovery metadata, and it
 * contains no secrets.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      resource: mcpResourceUri(),
      authorization_servers: [appOrigin()],
      // `scopes_supported` is the MINIMAL set needed for basic functionality —
      // the spec points clients here when the 401 carries no explicit scope, and
      // asks them to request more incrementally via step-up authorization.
      scopes_supported: ALL_MCP_SCOPES,
      bearer_methods_supported: ["header"],
      resource_documentation: `${appOrigin()}/docs/mcp`,
    },
    {
      headers: {
        // Discovery is stable; let clients cache it briefly but re-check often
        // enough that a deployment change propagates.
        "Cache-Control": "public, max-age=300",
      },
    }
  );
}
