import type { PrismaClient } from "@prisma/client";

/**
 * Auto-resolve a channel's open token/auth monitoring errors when it reconnects.
 * ─────────────────────────────────────────────────────────────────────────────
 * The single most common Monitoring noise is "Access token expired. Please
 * reconnect this channel in Settings." (errorType token_expired/auth_expired),
 * written by the post-publish worker with metadata.channelId. Reconnecting a
 * channel mints a fresh token, so those open rows are no longer actionable —
 * mark them resolved automatically instead of leaving the operator to hand-resolve.
 *
 * Best-effort: never throws (monitoring hygiene must not break a reconnect).
 * Called from every channel-token-store path (OAuth callback + connectWithToken).
 *
 * @returns number of rows auto-resolved (0 on any failure)
 */
export async function resolveChannelErrorsOnReconnect(
  prisma: PrismaClient,
  channelId: string,
): Promise<number> {
  try {
    const { count } = await prisma.errorLog.updateMany({
      where: {
        resolved: false,
        source: "publish",
        metadata: { path: ["channelId"], equals: channelId },
        OR: [
          { metadata: { path: ["errorType"], equals: "token_expired" } },
          { metadata: { path: ["errorType"], equals: "auth_expired" } },
          { metadata: { path: ["errorType"], equals: "permission" } },
        ],
      },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolvedNote: "Auto-resolved: channel reconnected with a fresh token.",
      },
    });
    return count;
  } catch {
    return 0;
  }
}
