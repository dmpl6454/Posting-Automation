import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { getSocialProvider, getSupportedPlatforms, generateState } from "@postautomation/social";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

export const channelRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.channel.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        platform: true,
        name: true,
        username: true,
        avatar: true,
        isActive: true,
        tokenExpiresAt: true,
        createdAt: true,
      },
    });
  }),

  supportedPlatforms: orgProcedure.query(() => {
    return getSupportedPlatforms().map((platform) => {
      const provider = getSocialProvider(platform);
      return {
        platform,
        displayName: provider.displayName,
        constraints: provider.constraints,
      };
    });
  }),

  getOAuthUrl: orgProcedure
    .input(z.object({ platform: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const provider = getSocialProvider(input.platform as any);
      const state = generateState();

      // Store state in Redis or session for verification
      // For now, encode org ID in state
      const stateWithOrg = `${state}:${ctx.organizationId}`;

      const platformEnvPrefix = input.platform.toUpperCase();
      const config = {
        clientId: process.env[`${platformEnvPrefix}_CLIENT_ID`] || "",
        clientSecret: process.env[`${platformEnvPrefix}_CLIENT_SECRET`] || "",
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${input.platform.toLowerCase()}`,
        scopes: getDefaultScopes(input.platform),
      };

      const url = provider.getOAuthUrl(config, stateWithOrg);
      return { url, state: stateWithOrg };
    }),

  disconnect: orgProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.channel.delete({ where: { id: input.channelId } });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.CHANNEL_DISCONNECTED,
        entityType: "Channel",
        entityId: input.channelId,
        metadata: { platform: channel.platform, name: channel.name },
      }).catch(() => {});

      return { success: true };
    }),

  toggleActive: orgProcedure
    .input(z.object({ channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.prisma.channel.update({
        where: { id: input.channelId },
        data: { isActive: !channel.isActive },
      });
    }),
});

function getDefaultScopes(platform: string): string[] {
  const scopeMap: Record<string, string[]> = {
    TWITTER: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    LINKEDIN: ["openid", "profile", "w_member_social"],
    FACEBOOK: ["public_profile", "email", "pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    INSTAGRAM: ["instagram_basic", "instagram_content_publish"],
    REDDIT: ["submit", "identity", "read"],
    YOUTUBE: ["https://www.googleapis.com/auth/youtube.upload"],
  };
  return scopeMap[platform] || [];
}
