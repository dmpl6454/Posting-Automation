import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import type { TRPCContext } from "../trpc";

/**
 * Validates an API key from the Authorization header.
 * Returns the organization ID if valid.
 */
export async function validateApiKey(
  prisma: TRPCContext["prisma"],
  apiKey: string
): Promise<{ organizationId: string } | null> {
  if (!apiKey.startsWith("pa_")) {
    return null;
  }

  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

  const key = await prisma.apiKey.findFirst({
    where: {
      keyHash,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    select: {
      id: true,
      organizationId: true,
    },
  });

  if (!key) {
    return null;
  }

  // Update last used timestamp (fire-and-forget)
  prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  return { organizationId: key.organizationId };
}
