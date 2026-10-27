import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getSocialProvider } from "@postautomation/social";
import { createRouter, orgProcedure } from "../trpc";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import { tiktokCreatorInfoRateLimiter, tiktokCreatorInfoAccountLimiter } from "../middleware/rate-limit";
import {
  queryTikTokCreatorInfo,
  tiktokCannotPostReason,
  TIKTOK_RECONNECT_MESSAGE,
  TIKTOK_UNREACHABLE_MESSAGE,
} from "../lib/tiktok-post";

/**
 * TikTok — live account checks for Content Studio (2026-10-28).
 *
 * `creatorInfo` answers "what can this TikTok account post right now": its
 * nickname/@handle/avatar, the privacy levels it allows, whether it switched off
 * comments/Duet/Stitch, its max video length — and whether it can post at all.
 * TikTok's Content Sharing Guidelines require showing these fresh before every
 * post; the provider checks them again right before publishing.
 *
 * Rules (the comment.router / wordpressTaxonomies pattern):
 *  - The channel is read with a DIRECT prisma.channel.findFirst — the only read
 *    path that decrypts the token — scoped to org + TIKTOK + not disconnected.
 *  - Per-user limit (middleware) + per-ACCOUNT budget across every user and org:
 *    TikTok allows 20 creator_info calls a minute per token, and the publish
 *    worker spends the same budget.
 *  - Fixed-text errors only; TikTok's body (and its `log_id` digits) never
 *    reaches the caller.
 */

/** Access tokens live 24 h; refresh when this close to expiry. */
const REFRESH_LEAD_MS = 5 * 60_000;

/**
 * One refresh per channel at a time in this process: two tabs opening Compose
 * together must not both spend the refresh token (TikTok may rotate it).
 */
const inflightRefresh = new Map<string, Promise<string>>();

type TikTokChannelRow = {
  id: string;
  organizationId: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

/**
 * The token to call TikTok with. Refreshes first when it expires within 5 minutes
 * and a refresh token exists. The new tokens are persisted with a CONDITIONAL
 * update (only while `tokenExpiresAt` is still what we read), so a refresh the
 * cron or the publish worker made in the meantime is never overwritten; this
 * call still uses its own fresh (valid) access token. A failed refresh falls
 * back to the stored token — TikTok's answer to that then decides the message
 * (a dead token reads "Reconnect"), and the refresh error is never surfaced.
 */
async function usableAccessToken(prisma: any, channel: TikTokChannelRow): Promise<string> {
  const expiresAt = channel.tokenExpiresAt;
  if (!channel.refreshToken || !expiresAt || expiresAt.getTime() - Date.now() > REFRESH_LEAD_MS) {
    return channel.accessToken;
  }
  // Built exactly as the token-refresh worker builds it for a non-Meta platform.
  const clientId = process.env.TIKTOK_CLIENT_ID ?? "";
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return channel.accessToken;

  const pending = inflightRefresh.get(channel.id);
  if (pending) return pending;
  const run = (async () => {
    try {
      const tokens = await getSocialProvider("TIKTOK" as any).refreshAccessToken(channel.refreshToken!, {
        clientId,
        clientSecret,
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/tiktok`,
        scopes: [],
      });
      if (!tokens?.accessToken) return channel.accessToken;
      const written = await prisma.channel.updateMany({
        where: { id: channel.id, organizationId: channel.organizationId, tokenExpiresAt: expiresAt },
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? channel.refreshToken,
          tokenExpiresAt: tokens.expiresAt ?? null,
        },
      });
      if (written?.count === 0) {
        console.warn(`[tiktok.creatorInfo] channel ${channel.id}: token was refreshed elsewhere meanwhile — kept that one`);
      }
      return tokens.accessToken;
    } catch (err: any) {
      // Never log the error text: a provider error can carry TikTok's body.
      const kind = /invalid_grant/i.test(String(err?.message ?? "")) ? "invalid_grant" : "error";
      console.warn(`[tiktok.creatorInfo] channel ${channel.id}: token refresh failed (${kind}) — using the stored token`);
      return channel.accessToken;
    }
  })();
  inflightRefresh.set(channel.id, run);
  try {
    return await run;
  } finally {
    inflightRefresh.delete(channel.id);
  }
}

export const tiktokRouter = createRouter({
  creatorInfo: orgProcedure
    .use(createRateLimitMiddleware(tiktokCreatorInfoRateLimiter))
    .input(z.object({ channelId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId, platform: "TIKTOK", disconnectedAt: null },
      });
      if (!channel) {
        throw new TRPCError({ code: "NOT_FOUND", message: "TikTok account not found." });
      }
      // Per-account budget, keyed on the TikTok account (open_id) across every
      // user and org that connected it — checked once the account is known.
      if (!tiktokCreatorInfoAccountLimiter(`TIKTOK:${channel.platformId}`).success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "This TikTok account has been checked a lot in the last minute. Wait a minute and try again.",
        });
      }

      const accessToken = await usableAccessToken(ctx.prisma, channel as TikTokChannelRow);
      const result = await queryTikTokCreatorInfo(accessToken);
      switch (result.kind) {
        case "ok":
          return { creator: result.creator, canPost: true, reason: null };
        case "cannot_post":
          return { creator: result.creator, canPost: false, reason: tiktokCannotPostReason(result.code) };
        case "reconnect":
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: TIKTOK_RECONNECT_MESSAGE });
        default:
          throw new TRPCError({ code: "BAD_GATEWAY", message: TIKTOK_UNREACHABLE_MESSAGE });
      }
    }),
});
