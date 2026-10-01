"use server";

import { redirect } from "next/navigation";
import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import {
  generateSecret,
  hashSecret,
  expiresAt,
  AUTH_CODE_TTL_SECONDS,
  sanitizeScopes,
  narrowToClientScopes,
  redirectUriAllowed,
  canonicalizeResource,
} from "@postautomation/api/src/lib/mcp-oauth";
import { issuer, mcpResourceUri } from "~/lib/mcp-urls";

/**
 * The consent decision. Mints a single-use authorization code and sends the user
 * back to the MCP client.
 *
 * ⚠️ Re-validates EVERYTHING from scratch. The form is attacker-controlled: the
 * page's earlier validation is a UX affordance, not a security boundary, and a
 * crafted POST can arrive without ever loading the page.
 */
export async function decideAuthorization(formData: FormData) {
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) redirect("/login");

  const clientId = String(formData.get("client_id") ?? "");
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const codeChallengeMethod = String(formData.get("code_challenge_method") ?? "");
  const resourceRaw = String(formData.get("resource") ?? "");
  const scopeRaw = String(formData.get("scope") ?? "");
  const organizationId = String(formData.get("organization_id") ?? "");
  const approved = String(formData.get("decision") ?? "") === "allow";

  const client = await prisma.mcpOAuthClient.findUnique({ where: { clientId } });
  // 🔴 If the client or redirect URI is not valid we must NOT redirect anywhere —
  // that is the open-redirect hole. Render an error on our own origin instead.
  if (!client || client.revokedAt) redirect("/oauth/authorize/error?reason=unknown_client");
  if (!redirectUriAllowed(redirectUri, client!.redirectUris)) {
    redirect("/oauth/authorize/error?reason=bad_redirect");
  }

  // From here the redirect target is proven registered, so OAuth errors may
  // safely travel back to the client.
  const back = new URL(redirectUri);
  // RFC 9207: we advertise authorization_response_iss_parameter_supported=true,
  // so `iss` MUST be present on success AND on error, or conformant clients
  // reject the response outright.
  back.searchParams.set("iss", issuer());
  if (state) back.searchParams.set("state", state);

  if (!approved) {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "The user declined the request.");
    redirect(back.toString());
  }

  if (codeChallengeMethod !== "S256" || !codeChallenge) {
    back.searchParams.set("error", "invalid_request");
    back.searchParams.set("error_description", "PKCE with S256 is required.");
    redirect(back.toString());
  }

  // ⚠️ Membership is re-checked server-side. A crafted POST could name any
  // organization id; only a real membership row may bind a token to a workspace.
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: { userId: userId!, organizationId } },
    select: { organizationId: true },
  });
  if (!membership) {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("error_description", "You are not a member of the selected workspace.");
    redirect(back.toString());
  }

  /**
   * 🔴 THE SCOPE FIELD IS A FORM INPUT, so it is attacker-controlled — the
   * consent page renders a hidden input and anything can POST this action
   * directly. Narrowing to what WE define is not enough: it must also be
   * narrowed to what THIS client registered for.
   *
   * Otherwise a client that registered read-only can post `mcp:publish` and,
   * with one click from a user who was shown a read-only screen, hold publish
   * rights on live audience accounts. The registered set is the ceiling; the
   * user's consent narrows within it, never past it.
   */
  const scopes = narrowToClientScopes(scopeRaw.split(/\s+/).filter(Boolean), client.scopes);
  if (scopes.length === 0) {
    back.searchParams.set("error", "invalid_scope");
    back.searchParams.set(
      "error_description",
      "No recognised scopes were requested, or none are permitted for this client."
    );
    redirect(back.toString());
  }

  // The audience this code may mint a token for. Falls back to our own canonical
  // URI when the client omitted it, so the token is never unbound.
  const resource = canonicalizeResource(resourceRaw) ?? mcpResourceUri();

  const code = generateSecret("mcp_code");
  await prisma.mcpAuthCode.create({
    data: {
      codeHash: hashSecret(code),
      clientId,
      userId: userId!,
      organizationId,
      scopes,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256",
      resource,
      expiresAt: expiresAt(AUTH_CODE_TTL_SECONDS, new Date()),
    },
  });

  back.searchParams.set("code", code);
  redirect(back.toString());
}
