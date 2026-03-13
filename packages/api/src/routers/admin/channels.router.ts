import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { getSocialProvider } from "@postautomation/social";
import type { SocialPlatform } from "@postautomation/db";

export const adminChannelsRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor } = input;

      const items = await ctx.prisma.channel.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          organization: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        const next = items.pop()!;
        nextCursor = next.id;
      }

      const now = new Date();
      const enriched = items.map((ch) => {
        let tokenStatus: "expired" | "expiring" | "valid" | "unknown" =
          "unknown";
        if (ch.tokenExpiresAt) {
          if (ch.tokenExpiresAt < now) {
            tokenStatus = "expired";
          } else if (
            ch.tokenExpiresAt.getTime() - now.getTime() <
            7 * 24 * 60 * 60 * 1000
          ) {
            tokenStatus = "expiring";
          } else {
            tokenStatus = "valid";
          }
        }
        return {
          ...ch,
          tokenStatus,
          hasRefreshToken: !!ch.refreshToken,
        };
      });

      return { items: enriched, nextCursor };
    }),

  disconnect: superAdminProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findUnique({
        where: { id: input.channelId },
        select: { organizationId: true },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.prisma.channel.delete({ where: { id: input.channelId } });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: channel.organizationId,
        action: AUDIT_ACTIONS.ADMIN_CHANNEL_DISCONNECTED,
        entityType: "Channel",
        entityId: input.channelId,
      }).catch(() => {});

      return { success: true };
    }),

  refreshToken: superAdminProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findUnique({
        where: { id: input.channelId },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND" });

      if (!channel.refreshToken) {
        return { success: false, message: "No refresh token available" };
      }

      const platformKey = channel.platform.toUpperCase();
      const clientId = process.env[`${platformKey}_CLIENT_ID`];
      const clientSecret = process.env[`${platformKey}_CLIENT_SECRET`];

      if (!clientId || !clientSecret) {
        return {
          success: false,
          message: `Missing ${platformKey} credentials in environment`,
        };
      }

      const provider = getSocialProvider(channel.platform as SocialPlatform);
      const tokens = await provider.refreshAccessToken(channel.refreshToken, {
        clientId,
        clientSecret,
        callbackUrl: "",
        scopes: channel.scopes,
      });

      await ctx.prisma.channel.update({
        where: { id: input.channelId },
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? channel.refreshToken,
          tokenExpiresAt: tokens.expiresAt ?? null,
        },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: channel.organizationId,
        action: AUDIT_ACTIONS.ADMIN_CHANNEL_TOKEN_REFRESHED,
        entityType: "Channel",
        entityId: input.channelId,
      }).catch(() => {});

      return { success: true };
    }),
});
