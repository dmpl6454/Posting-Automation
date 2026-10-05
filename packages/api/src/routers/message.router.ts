import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import {
  getSocialProvider,
  messagingCapabilities,
  isValidConversationId,
  messageTextTooLong,
  messagingFailureOf,
  messagingFailureMessage,
  MESSENGER_TEXT_MAX_CHARS,
  type FacebookProvider,
  type MessagingPlatform,
  type SocialConversationThread,
} from "@postautomation/social";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import {
  commentPageReadLimiter,
  commentPageReplyLimiter,
  messageReadRateLimiter,
  messageSendRateLimiter,
} from "../middleware/rate-limit";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import {
  afterMessagingFailure,
  cachedGrantedScopes,
  isMessagingPlatform,
  messagingGrantNeedsRefresh,
  refreshChannelGrant,
  resolveMessagingAccess,
  type MessagingChannel,
} from "../lib/meta-messaging-access";

/**
 * Messages inbox — Messenger conversations of a connected Facebook Page and
 * Instagram Direct conversations of a connected Instagram account (2026-10-05).
 *
 * Permissions (see docs/META-COMMENTS-APP-REVIEW-RUNBOOK-2026-09-23.md §12):
 *   Facebook   pages_messaging + pages_manage_metadata + pages_read_engagement
 *   Instagram  instagram_basic + instagram_manage_messages + pages_manage_metadata
 * Until Meta approves them only app-role accounts are granted them; the UI
 * gates on the GRANTED scopes and everyone else sees "reconnect / not
 * approved yet".
 *
 * 🔒 The only client-supplied Graph value is `conversationId`. It is shape-
 * checked (isValidConversationId), encoded at the call site, and the provider
 * refuses a conversation the account is not a participant of. The recipient of
 * a send is read from that conversation server-side — never taken from the
 * client.
 *
 * Sending is only possible inside Meta's 24-hour standard messaging window
 * (the person messaged in the last 24 hours). Creating a message is not
 * idempotent: an unknown outcome reads "may already have been sent".
 */

const readLimited = orgProcedure.use(createRateLimitMiddleware(messageReadRateLimiter));
const sendLimited = orgProcedure.use(createRateLimitMiddleware(messageSendRateLimiter));

const conversationIdSchema = z
  .string()
  .refine((v) => isValidConversationId(v), "That doesn't look like a valid conversation.");

/** The org's channel, loaded DIRECTLY (that is what decrypts the token). */
async function loadMessagingChannel(prisma: any, organizationId: string, channelId: string): Promise<MessagingChannel & { name: string; username: string | null; avatar: string | null }> {
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel || channel.organizationId !== organizationId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
  }
  if (!isMessagingPlatform(channel.platform)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Messages are available for Facebook Pages and Instagram accounts only." });
  }
  if (channel.disconnectedAt) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This channel has been disconnected." });
  }
  return {
    id: channel.id,
    platform: channel.platform,
    platformId: channel.platformId,
    accessToken: channel.accessToken,
    metaAppId: channel.metaAppId ?? null,
    metadata: (channel.metadata ?? null) as Record<string, unknown> | null,
    name: channel.name,
    username: channel.username ?? null,
    avatar: channel.avatar ?? null,
  };
}

/** Meta's quota is per Page — shared with the comment budget, across orgs. */
function enforcePageBudget(limiter: (key: string) => { success: boolean }, platform: string, platformId: string): void {
  if (limiter(`${platform}:${platformId}`).success) return;
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: `There's a lot of activity on this ${platform === "FACEBOOK" ? "Page" : "account"} right now. Please wait a minute and try again.`,
  });
}

async function readThread(
  prisma: any,
  channel: MessagingChannel,
  conversationId: string
): Promise<SocialConversationThread> {
  const access = await resolveMessagingAccess(prisma, channel);
  try {
    return await (getSocialProvider("FACEBOOK") as FacebookProvider).getConversation({
      platform: access.platform,
      pageToken: access.pageToken,
      pageId: access.pageId,
      conversationId,
      ownIds: access.ownIds,
    });
  } catch (err: any) {
    if (afterMessagingFailure(channel.id, err).refreshGrant) void refreshChannelGrant(prisma, channel);
    throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Couldn't load this conversation." });
  }
}

export const messageRouter = createRouter({
  /** The org's Facebook Pages + Instagram accounts and what each may do with messages. */
  accounts: orgProcedure.query(async ({ ctx }) => {
    const channels = await ctx.prisma.channel.findMany({
      where: { organizationId: ctx.organizationId, disconnectedAt: null, platform: { in: ["FACEBOOK", "INSTAGRAM"] } },
      // metadata only to derive access from the cached grant — never forwarded.
      select: { id: true, platform: true, name: true, username: true, avatar: true, isActive: true, metadata: true },
      orderBy: [{ platform: "asc" }, { name: "asc" }],
    });
    return channels.map(({ metadata, ...c }) => ({
      ...c,
      messageAccess: messagingCapabilities(
        c.platform as MessagingPlatform,
        cachedGrantedScopes(metadata as Record<string, unknown> | null)
      ),
    }));
  }),

  /** One page of conversations, newest first, live from Meta. */
  conversations: readLimited
    .input(z.object({ channelId: z.string(), cursor: z.string().max(1024).nullish() }))
    .query(async ({ ctx, input }) => {
      const channel = await loadMessagingChannel(ctx.prisma, ctx.organizationId, input.channelId);
      enforcePageBudget(commentPageReadLimiter, channel.platform, channel.platformId);
      const platform = channel.platform as MessagingPlatform;

      let scopes = cachedGrantedScopes(channel.metadata);
      if (!input.cursor && messagingGrantNeedsRefresh(platform, channel.metadata, Date.now())) {
        scopes = (await refreshChannelGrant(ctx.prisma, channel)) ?? scopes;
      }
      const capabilities = messagingCapabilities(platform, scopes);
      const account = { channelId: channel.id, name: channel.name, username: channel.username, avatar: channel.avatar };

      // A known-missing grant: say so without spending a Graph call on a
      // refusal we can predict.
      if (capabilities.canUseInbox === false) {
        return { capabilities, platform, account, conversations: [], nextCursor: null, blocked: true as const };
      }

      const access = await resolveMessagingAccess(ctx.prisma, channel);
      try {
        const page = await (getSocialProvider("FACEBOOK") as FacebookProvider).listConversations({
          platform,
          pageToken: access.pageToken,
          pageId: access.pageId,
          ownIds: access.ownIds,
          after: input.cursor ?? undefined,
        });
        return { capabilities, platform, account, ...page, blocked: false as const };
      } catch (err: any) {
        if (afterMessagingFailure(channel.id, err).refreshGrant) void refreshChannelGrant(ctx.prisma, channel);
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Couldn't load messages." });
      }
    }),

  /** One conversation — the newest messages Meta details (up to 20) and the 24-hour window. */
  thread: readLimited
    .input(z.object({ channelId: z.string(), conversationId: conversationIdSchema }))
    .query(async ({ ctx, input }) => {
      const channel = await loadMessagingChannel(ctx.prisma, ctx.organizationId, input.channelId);
      enforcePageBudget(commentPageReadLimiter, channel.platform, channel.platformId);
      const thread = await readThread(ctx.prisma, channel, input.conversationId);
      return { platform: channel.platform as MessagingPlatform, ...thread };
    }),

  /**
   * Send a text message in a conversation. The recipient is read from the
   * conversation (server-side), and the 24-hour window is checked first so an
   * expired one is explained without a doomed call.
   */
  send: sendLimited
    .input(
      z.object({
        channelId: z.string(),
        conversationId: conversationIdSchema,
        text: z.string().trim().min(1, "Message cannot be empty.").max(MESSENGER_TEXT_MAX_CHARS),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const channel = await loadMessagingChannel(ctx.prisma, ctx.organizationId, input.channelId);
      const platform = channel.platform as MessagingPlatform;
      const tooLong = messageTextTooLong(platform, input.text);
      if (tooLong) throw new TRPCError({ code: "BAD_REQUEST", message: tooLong });
      enforcePageBudget(commentPageReplyLimiter, channel.platform, channel.platformId);

      const thread = await readThread(ctx.prisma, channel, input.conversationId);
      if (thread.windowOpen === false) {
        throw new TRPCError({ code: "BAD_REQUEST", message: messagingFailureMessage(platform, "window_closed", "send") });
      }
      const recipientId = thread.participant?.id;
      if (!recipientId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: messagingFailureMessage(platform, "not_found", "send") });
      }

      const access = await resolveMessagingAccess(ctx.prisma, channel);
      const audit = (metadata: Record<string, unknown>) =>
        createAuditLog({
          organizationId: ctx.organizationId,
          userId: (ctx.session?.user as any)?.id,
          action: AUDIT_ACTIONS.MESSAGE_SENT,
          entityType: "Channel",
          entityId: channel.id,
          metadata: { platform, conversationId: input.conversationId, length: input.text.length, ...metadata },
        });

      try {
        const result = await (getSocialProvider("FACEBOOK") as FacebookProvider).sendMessage({
          platform,
          pageToken: access.pageToken,
          pageId: access.pageId,
          recipientId,
          text: input.text,
        });
        await audit({ messageId: result.messageId });
        return { messageId: result.messageId };
      } catch (err: any) {
        const failure = messagingFailureOf(err);
        // A message that MAY have gone out is still an outward action.
        if (failure === "unconfirmed") await audit({ outcome: "unconfirmed" });
        if (afterMessagingFailure(channel.id, err).refreshGrant) void refreshChannelGrant(ctx.prisma, channel);
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Couldn't send that message." });
      }
    }),
});
