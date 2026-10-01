"use server";

import { revalidatePath } from "next/cache";
import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import { createAuditLog } from "@postautomation/api/src/lib/audit";

/**
 * Revoke one AI connector's access for the signed-in user.
 *
 * 🔴 THIS IS THE STOP BUTTON. An MCP token can publish to live audience
 * accounts, and an access token lives an hour while its refresh chain lives
 * thirty days — so without this, a user who no longer trusts a connector (or an
 * assistant that has started behaving oddly) has no way to cut it off short of
 * resetting their password. Revoking a channel would not help: the connector
 * would still reach every other channel.
 */
export async function revokeMcpClient(formData: FormData) {
  const session = await auth();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return;

  const clientId = String(formData.get("clientId") ?? "");
  if (!clientId) return;

  /**
   * ⚠️ Scoped to `userId`, not just `clientId`. The same client row is shared by
   * every user who added that connector — Claude Desktop registers once per
   * install, not once per person — so an unscoped update would sign everyone
   * else out too. One user revoking is not a decision about anyone else.
   *
   * Access AND refresh die together: revoking only the access token leaves a
   * connector that mints a replacement within the hour.
   */
  const res = await prisma.mcpAccessToken.updateMany({
    where: { clientId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Unredeemed codes too — an authorization approved moments ago must not be
  // cashable after the user has said no.
  await prisma.mcpAuthCode.updateMany({
    where: { clientId, userId, usedAt: null },
    data: { usedAt: new Date() },
  });

  void createAuditLog({
    userId,
    action: "mcp.client_revoked",
    entityType: "mcp",
    entityId: clientId,
    metadata: { clientId, tokensRevoked: res.count },
  });

  revalidatePath("/dashboard/settings/connections");
}
