import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { getSocialProvider, getSupportedPlatforms, signState } from "@postautomation/social";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { enforcePlanLimit } from "../middleware/plan-limit.middleware";
import {
  TOKEN_PLATFORMS,
  TOKEN_PLATFORM_SPECS,
  validateAndBuildChannel,
  type TokenPlatform,
} from "../lib/channel-token-validators";

// OAuth platforms that require <PLATFORM>_CLIENT_ID and <PLATFORM>_CLIENT_SECRET
// env vars before the Connect button can do anything useful. Used by the
// `platformAuthInfo` query so the UI can show a "Setup required" state
// instead of a misleading Connect button.
const OAUTH_PLATFORMS = [
  "TWITTER",
  "LINKEDIN",
  "FACEBOOK",
  "INSTAGRAM",
  "REDDIT",
  "YOUTUBE",
  "TIKTOK",
  "PINTEREST",
  "THREADS",
  "SLACK",
] as const;

const TOKEN_PLATFORM_SET = new Set<string>(TOKEN_PLATFORMS);

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

  /**
   * Per-platform connection info — tells the UI how to wire the Connect
   * button. For OAuth platforms, returns whether the operator has set
   * CLIENT_ID/SECRET env vars. For token platforms, returns the field spec
   * the dialog should render.
   */
  platformAuthInfo: orgProcedure.query(() => {
    return getSupportedPlatforms().map((platform) => {
      const provider = getSocialProvider(platform);
      const platformKey = String(platform);

      if (TOKEN_PLATFORM_SET.has(platformKey)) {
        const spec = TOKEN_PLATFORM_SPECS[platformKey as TokenPlatform];
        return {
          platform,
          displayName: provider.displayName,
          authType: "token" as const,
          configured: true,
          description: spec.description,
          helpUrl: spec.helpUrl,
          helpLinkLabel: spec.helpLinkLabel ?? null,
          steps: spec.steps,
          features: spec.features ?? null,
          fields: spec.fields,
        };
      }

      // Default: OAuth platform — check that env vars are set.
      const clientId = process.env[`${platformKey}_CLIENT_ID`];
      const clientSecret = process.env[`${platformKey}_CLIENT_SECRET`];
      const configured = Boolean(clientId && clientSecret);
      return {
        platform,
        displayName: provider.displayName,
        authType: "oauth" as const,
        configured,
        description: configured
          ? "Click Connect to authorize via the official sign-in flow."
          : "OAuth credentials not configured — see docs/OAUTH_SETUP.md.",
        helpUrl: null,
        helpLinkLabel: null,
        steps: [] as string[],
        features: null,
        fields: [] as never[],
      };
    });
  }),

  getOAuthUrl: orgProcedure
    .input(z.object({ platform: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Enforce plan limit for connected channels
      await enforcePlanLimit(ctx.organizationId, "channels", ctx.isSuperAdmin);

      const provider = getSocialProvider(input.platform as any);

      // SECURITY: state must be unforgeable. We sign an HMAC token that
      // binds {organizationId, userId} together with a TTL so the OAuth
      // callback can verify (a) the state was issued by us and not crafted
      // by an attacker, (b) the user completing the flow is the same user
      // who started it, and (c) the org binding hasn't been swapped.
      const userId = (ctx.session.user as any).id as string;

      // SECURITY: pin the signed OAuth state to a *validated* membership.
      // Defense-in-depth — orgProcedure already rejects non-members after the
      // hard-isolation change, but connecting a channel writes a Channel row
      // bound to ctx.organizationId, so we re-verify here with a connect-
      // specific error. No superadmin carve-out (hard isolation, no
      // connect-on-behalf): a superadmin may only connect channels for orgs
      // they are a real member of.
      const membership = await ctx.prisma.organizationMember.findUnique({
        where: {
          userId_organizationId: { userId, organizationId: ctx.organizationId },
        },
      });
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "You are not a member of this workspace; switch workspaces to connect a channel here.",
        });
      }

      const signedState = signState({
        organizationId: ctx.organizationId,
        userId,
      });

      const platformEnvPrefix = input.platform.toUpperCase();
      const clientId = process.env[`${platformEnvPrefix}_CLIENT_ID`];
      const clientSecret = process.env[`${platformEnvPrefix}_CLIENT_SECRET`];

      // Fix #19: surface missing env vars before attempting OAuth redirect
      if (!clientId || !clientSecret) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.platform} is not configured by the administrator. Please contact support.`,
        });
      }

      const config = {
        clientId,
        clientSecret,
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

  /**
   * Telegram-only: given a bot token, return the list of chats the bot has
   * recently seen messages in. Lets the user pick a chat from a dropdown
   * instead of hunting for a numeric chat ID.
   *
   * Telegram's getUpdates returns ~24 hours of recent updates. The user must
   * add the bot to a channel/group as admin AND post a message there for
   * the chat to appear here.
   */
  detectTelegramChats: orgProcedure
    .input(z.object({ botToken: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const botToken = input.botToken.trim();
      if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That doesn't look like a Telegram bot token. Format: 123456789:ABCdef...",
        });
      }

      // Verify the token works at all
      const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const meData: any = await meRes.json().catch(() => null);
      if (!meRes.ok || !meData?.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Telegram rejected that bot token. Double-check it by sending /mybots to @BotFather.",
        });
      }

      const updatesRes = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?allowed_updates=${encodeURIComponent(
          JSON.stringify(["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member"])
        )}`
      );
      const updatesData: any = await updatesRes.json().catch(() => null);

      if (!updatesRes.ok || !updatesData?.ok) {
        // 409 Conflict means a webhook is currently set on the bot — getUpdates won't work
        if (updatesData?.error_code === 409) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "This bot has a webhook set, which blocks chat detection. Either delete the webhook (DM @BotFather → /mybots → your bot → Edit Webhook → Remove Webhook) or enter the chat ID manually.",
          });
        }
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Telegram returned an error fetching chats. Try again in a moment.",
        });
      }

      const updates: any[] = updatesData.result ?? [];
      const seen = new Map<
        string,
        { id: string; title: string; type: string; username: string | null }
      >();
      for (const u of updates) {
        const chat =
          u.message?.chat ??
          u.channel_post?.chat ??
          u.edited_message?.chat ??
          u.edited_channel_post?.chat ??
          u.my_chat_member?.chat;
        if (!chat?.id) continue;
        const id = String(chat.id);
        if (seen.has(id)) continue;
        const title: string =
          chat.title ||
          [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
          (chat.username ? `@${chat.username}` : `Chat ${id}`);
        seen.set(id, {
          id,
          title,
          type: chat.type as string,
          username: (chat.username as string | undefined) ?? null,
        });
      }

      return {
        botUsername: meData.result.username as string,
        botName: (meData.result.first_name as string) || meData.result.username,
        chats: Array.from(seen.values()),
      };
    }),

  /**
   * Connect a token-based platform (Telegram bot, Discord webhook, Bluesky
   * app password, Mastodon access token, WordPress app password, etc).
   *
   * Validates the credentials by calling the platform's own API, then
   * upserts the Channel row. No OAuth redirect — the dialog stays in-app.
   */
  connectWithToken: orgProcedure
    .input(
      z.object({
        platform: z.enum(TOKEN_PLATFORMS as readonly [string, ...string[]]),
        credentials: z.record(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await enforcePlanLimit(ctx.organizationId, "channels", ctx.isSuperAdmin);

      const validated = await validateAndBuildChannel(
        input.platform as TokenPlatform,
        input.credentials
      );

      const channel = await ctx.prisma.channel.upsert({
        where: {
          organizationId_platform_platformId: {
            organizationId: ctx.organizationId,
            platform: input.platform as any,
            platformId: validated.platformId,
          },
        },
        create: {
          organizationId: ctx.organizationId,
          platform: input.platform as any,
          platformId: validated.platformId,
          name: validated.name,
          username: validated.username,
          avatar: validated.avatar,
          accessToken: validated.accessToken,
          refreshToken: validated.refreshToken ?? null,
          tokenExpiresAt: validated.tokenExpiresAt ?? null,
          scopes: validated.scopes,
          metadata: validated.metadata as any,
          isActive: true,
        },
        update: {
          accessToken: validated.accessToken,
          refreshToken: validated.refreshToken ?? null,
          tokenExpiresAt: validated.tokenExpiresAt ?? null,
          scopes: validated.scopes,
          metadata: validated.metadata as any,
          name: validated.name,
          username: validated.username,
          avatar: validated.avatar,
          isActive: true,
        },
      });

      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.CHANNEL_CONNECTED,
        entityType: "Channel",
        entityId: channel.id,
        metadata: {
          platform: input.platform,
          name: validated.name,
          method: "token",
        },
      }).catch((err) => {
        console.error("audit_log_write_failed", {
          err: err?.message,
          action: AUDIT_ACTIONS.CHANNEL_CONNECTED,
        });
      });

      return channel;
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

  bulkDisconnect: orgProcedure
    .input(z.object({ channelIds: z.array(z.string()).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      // Fetch the to-be-deleted channels scoped to the org (for audit + count)
      const channels = await ctx.prisma.channel.findMany({
        where: { id: { in: input.channelIds }, organizationId: ctx.organizationId },
        select: { id: true, platform: true, name: true },
      });
      const result = await ctx.prisma.channel.deleteMany({
        where: { id: { in: input.channelIds }, organizationId: ctx.organizationId },
      });

      // Fire-and-forget audit per deleted channel
      for (const ch of channels) {
        createAuditLog({
          organizationId: ctx.organizationId,
          userId: (ctx.session.user as any).id,
          action: AUDIT_ACTIONS.CHANNEL_DISCONNECTED,
          entityType: "Channel",
          entityId: ch.id,
          metadata: { platform: ch.platform, name: ch.name, bulk: true },
        }).catch(() => {});
      }

      return { deleted: result.count };
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
    // `email` intentionally omitted: sign-in is via Google, and the FB/IG
    // providers never read the FB-provided email. Dropping it slims the Meta
    // App Review surface (one fewer permission to get Advanced Access for).
    FACEBOOK: ["public_profile", "pages_show_list", "pages_manage_posts", "pages_read_engagement"],
    // `instagram_manage_comments` intentionally omitted: Meta rejected it as a
    // "disallowed use case" (Dev Policy 1.6) in the 2026-06 App Review because the
    // app never reads/creates/hides/deletes comment threads — getPostAnalytics
    // (instagram.provider.ts) only reads the `comments_count` integer, which rides
    // on `instagram_basic`. Re-adding it requires building an actual comment-
    // moderation feature first, or it will be rejected again.
    INSTAGRAM: ["public_profile", "pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_content_publish", "business_management"],
    REDDIT: ["submit", "identity", "read"],
    // TikTok Content Posting API. `video.publish` = Direct Post (what publishPost
    // uses via PULL_FROM_URL); `video.upload` = upload-to-drafts; `user.info.basic`
    // backs getProfile (/v2/user/info/). The provider joins these with "," (TikTok's
    // required separator). Until the app's Content Posting API audit is approved,
    // TikTok runs as an unaudited client: test users only + posts forced SELF_ONLY.
    TIKTOK: ["user.info.basic", "video.publish", "video.upload"],
    YOUTUBE: [
      "https://www.googleapis.com/auth/youtube.upload",
      // channels.list (used by getProfile to fetch channel name/avatar) needs a read scope;
      // youtube.upload alone returns 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT.
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    WORDPRESS: ["global"],
  };
  return scopeMap[platform] || [];
}
