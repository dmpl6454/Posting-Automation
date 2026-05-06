import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { getSocialProvider, getSupportedPlatforms, signState } from "@postautomation/social";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { enforcePlanLimit } from "../middleware/plan-limit.middleware";

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

  recentlyUsed: orgProcedure.query(async ({ ctx }) => {
    // Get channel IDs from the most recent post targets (last 30 days)
    const recentTargets = await ctx.prisma.postTarget.findMany({
      where: {
        post: { organizationId: ctx.organizationId },
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      select: { channelId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    // Deduplicate: keep first occurrence (most recent) of each channel
    const seen = new Set<string>();
    const orderedIds: string[] = [];
    for (const t of recentTargets) {
      if (!seen.has(t.channelId)) {
        seen.add(t.channelId);
        orderedIds.push(t.channelId);
      }
    }
    return orderedIds;
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
      // Enforce plan limit for connected channels
      await enforcePlanLimit(ctx.organizationId, "channels");

      const provider = getSocialProvider(input.platform as any);

      // SECURITY: state must be unforgeable. We sign an HMAC token that
      // binds {organizationId, userId} together with a TTL so the OAuth
      // callback can verify (a) the state was issued by us and not crafted
      // by an attacker, (b) the user completing the flow is the same user
      // who started it, and (c) the org binding hasn't been swapped.
      const userId = (ctx.session.user as any).id as string;
      const signedState = signState({
        organizationId: ctx.organizationId,
        userId,
      });

      const platformEnvPrefix = input.platform.toUpperCase();
      const config = {
        clientId: process.env[`${platformEnvPrefix}_CLIENT_ID`] || "",
        clientSecret: process.env[`${platformEnvPrefix}_CLIENT_SECRET`] || "",
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${input.platform.toLowerCase()}`,
        scopes: getDefaultScopes(input.platform),
      };

      try {
        const url = await provider.getOAuthUrl(config, signedState);
        return { url, state: signedState };
      } catch (err: any) {
        console.error(`[channel.getOAuthUrl] ${input.platform} failed:`, err.message);
        throw err;
      }
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
    TWITTER: ["tweet.read", "tweet.write", "media.write", "users.read", "offline.access"],
    LINKEDIN: ["openid", "profile", "w_member_social", "w_organization_social", "r_organization_social"],
    FACEBOOK: ["public_profile", "email", "pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    INSTAGRAM: ["public_profile", "email", "pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "instagram_manage_comments", "business_management"],
    REDDIT: ["submit", "identity", "read"],
    YOUTUBE: ["https://www.googleapis.com/auth/youtube.upload"],
    WORDPRESS: ["global"],
  };
  return scopeMap[platform] || [];
}
