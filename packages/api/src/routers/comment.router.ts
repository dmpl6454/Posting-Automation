import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import {
  getSocialProvider,
  COMMENT_REPLY_MAX_LENGTH,
  FB_COMMENT_MAX_LENGTH,
  GRAPH_OBJECT_ID_RE,
  type CommentPlatform,
  type FacebookProvider,
  type InstagramProvider,
  type SocialCommentPage,
} from "@postautomation/social";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import {
  commentPageReadLimiter,
  commentPageReplyLimiter,
  commentReadRateLimiter,
  commentReplyRateLimiter,
} from "../middleware/rate-limit";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

/**
 * Comments inbox — read and reply to comments on posts published through
 * PostAutomation, for Facebook Pages (2026-09-23) and Instagram professional
 * accounts (2026-09-19).
 *
 * Permissions (none of this works without them — see
 * docs/META-COMMENTS-APP-REVIEW-RUNBOOK-2026-09-23.md):
 *   Facebook  read  → pages_read_user_content (+ pages_read_engagement)
 *             reply → pages_manage_engagement
 *   Instagram read + reply → instagram_manage_comments
 * Until Meta approves Advanced Access only app-role accounts receive them;
 * everyone else gets an actionable "not approved yet / reconnect" message from
 * the provider's error classifier.
 *
 * Scope of v1: posts published THROUGH PostAutomation (a PostTarget), the same
 * population Insights covers. The post id always comes from OUR database,
 * org-scoped; the only client-supplied Graph id is `commentId`, which is
 * shape-validated (GRAPH_OBJECT_ID_RE) before it can reach a URL path.
 *
 * ⚠️ Org-scoped in TWO separate queries, never `postTarget.findUnique({
 * include: { channel: true } })` — only a DIRECT prisma.channel.findUnique/
 * findFirst/findMany auto-decrypts accessToken (the $extends in
 * packages/db/src/index.ts). Reading the channel through the PostTarget
 * relation returns `enc:v1:` ciphertext, which would fail every Graph call
 * with "Cannot parse access token" — the DECRYPT GOTCHA documented for every
 * other analytics/publish path in this codebase.
 */

const COMMENT_PLATFORMS: readonly string[] = ["FACEBOOK", "INSTAGRAM"];

function isCommentPlatform(platform: unknown): platform is CommentPlatform {
  return typeof platform === "string" && COMMENT_PLATFORMS.includes(platform);
}

/**
 * "Not a story" WITHOUT the NULL trap. `format` is a NULLABLE enum and nearly
 * every feed post has `format IS NULL`; `{ format: { not: "STORY" } }` compiles
 * to `format <> 'STORY'`, which is NULL (i.e. false) for those rows and would
 * silently drop almost every post. State the NULL branch explicitly.
 */
const NOT_A_STORY = [{ format: null }, { format: { not: "STORY" as const } }];

/** A story has no comments edge on either platform (and expires in 24h). */
const STORY_MESSAGE: Record<CommentPlatform, string> = {
  FACEBOOK: "Facebook stories don't have comments — replies are available on feed posts, photos, videos and reels.",
  INSTAGRAM: "Instagram stories don't have comments — replies are available on feed posts and reels.",
};

interface ResolvedCommentTarget {
  platform: CommentPlatform;
  /** Graph object whose /comments edge we read — PostTarget.publishedId. */
  objectId: string;
  publishedUrl: string | null;
  tokens: { accessToken: string; refreshToken?: string; metadata?: Record<string, unknown> };
  account: {
    channelId: string;
    name: string;
    username: string | null;
    avatar: string | null;
    /** FB: the Page id (flags the Page's own replies). IG: the IG user id. */
    platformId: string;
    igUserId: string | null;
  };
}

export async function resolvePublishedCommentTarget(
  prisma: {
    postTarget: { findUnique: (args: any) => Promise<any> };
    channel: { findUnique: (args: any) => Promise<any> };
  },
  organizationId: string,
  targetId: string
): Promise<ResolvedCommentTarget> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      status: true,
      format: true,
      publishedId: true,
      publishedUrl: true,
      channelId: true,
      post: { select: { organizationId: true } },
    },
  });
  if (!target || target.post?.organizationId !== organizationId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Post target not found" });
  }
  if (target.status !== "PUBLISHED" || !target.publishedId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Comments are only available once this channel's post has published.",
    });
  }

  const channel = await prisma.channel.findUnique({ where: { id: target.channelId } });
  // Defence in depth: post.create already refuses foreign channels, but this is
  // the row whose DECRYPTED token we are about to use, so check its own org too
  // rather than trusting that invariant from another router.
  if (!channel || channel.organizationId !== organizationId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Post target not found" });
  }
  if (!isCommentPlatform(channel.platform)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Comments are available for Facebook Pages and Instagram accounts only.",
    });
  }
  // Same format-vs-mode distinction the publish and analytics paths draw.
  if (target.format === "STORY") {
    throw new TRPCError({ code: "BAD_REQUEST", message: STORY_MESSAGE[channel.platform as CommentPlatform] });
  }
  if (channel.disconnectedAt) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This channel has been disconnected." });
  }

  const metadata = (channel.metadata ?? undefined) as Record<string, unknown> | undefined;
  const igUserId =
    channel.platform === "INSTAGRAM"
      ? (typeof metadata?.igUserId === "string" ? metadata.igUserId : null) ?? channel.platformId ?? null
      : null;

  return {
    platform: channel.platform as CommentPlatform,
    objectId: target.publishedId as string,
    publishedUrl: target.publishedUrl ?? null,
    tokens: {
      accessToken: channel.accessToken,
      refreshToken: channel.refreshToken ?? undefined,
      // Mirrors the avatar-cache / analytics-sync precedent.
      metadata,
    },
    account: {
      channelId: channel.id,
      name: channel.name,
      username: channel.username ?? null,
      avatar: channel.avatar ?? null,
      platformId: channel.platformId,
      igUserId,
    },
  };
}

/** Public posts as the Page / account — human-paced ceiling (see the limiter). */
const replyRateLimited = orgProcedure.use(createRateLimitMiddleware(commentReplyRateLimiter));
/** Live Graph reads against the Page's rate budget (see the limiter). */
const readRateLimited = orgProcedure.use(createRateLimitMiddleware(commentReadRateLimiter));

/**
 * Per-Page budget shared by every user and org that connected this Page —
 * checked AFTER resolving the target, because only then is the Page known.
 */
function enforcePageBudget(
  limiter: (key: string) => { success: boolean },
  platform: CommentPlatform,
  platformId: string
): void {
  if (limiter(`${platform}:${platformId}`).success) return;
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message: `There's a lot of comment activity on this ${platform === "FACEBOOK" ? "Page" : "account"} right now. Please wait a minute and try again.`,
  });
}

export const commentRouter = createRouter({
  /**
   * The org's Facebook Pages + Instagram accounts, with how many published
   * (non-story) posts each has — the inbox's first column. Accounts with the
   * most recent post first; accounts with nothing to show last.
   */
  accounts: orgProcedure.query(async ({ ctx }) => {
    const channels = await ctx.prisma.channel.findMany({
      where: {
        organizationId: ctx.organizationId,
        disconnectedAt: null,
        platform: { in: ["FACEBOOK", "INSTAGRAM"] },
      },
      select: { id: true, platform: true, name: true, username: true, avatar: true, isActive: true },
    });
    if (channels.length === 0) return [];

    const counts = await ctx.prisma.postTarget.groupBy({
      by: ["channelId"],
      where: {
        channelId: { in: channels.map((c) => c.id) },
        post: { organizationId: ctx.organizationId },
        status: "PUBLISHED",
        publishedId: { not: null },
        OR: NOT_A_STORY,
      },
      _count: { _all: true },
      _max: { publishedAt: true },
    });
    const byChannel = new Map(counts.map((c) => [c.channelId, c]));

    return channels
      .map((c) => {
        const row = byChannel.get(c.id);
        return {
          ...c,
          publishedPosts: row?._count._all ?? 0,
          lastPublishedAt: row?._max.publishedAt ?? null,
        };
      })
      .sort((a, b) => {
        const at = a.lastPublishedAt ? new Date(a.lastPublishedAt).getTime() : 0;
        const bt = b.lastPublishedAt ? new Date(b.lastPublishedAt).getTime() : 0;
        return bt - at || a.name.localeCompare(b.name);
      });
  }),

  /** Published (non-story) posts on one of the org's FB/IG channels, newest first. */
  posts: orgProcedure
    .input(
      z.object({
        channelId: z.string(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId, disconnectedAt: null },
        select: { id: true, platform: true, name: true, username: true, avatar: true },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found" });
      if (!isCommentPlatform(channel.platform)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Comments are available for Facebook Pages and Instagram accounts only.",
        });
      }

      const rows = await ctx.prisma.postTarget.findMany({
        where: {
          channelId: channel.id,
          post: { organizationId: ctx.organizationId },
          status: "PUBLISHED",
          publishedId: { not: null },
          OR: NOT_A_STORY,
        },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          format: true,
          publishedAt: true,
          publishedUrl: true,
          contentOverride: true,
          post: {
            select: {
              id: true,
              content: true,
              mediaAttachments: {
                orderBy: { order: "asc" },
                take: 1,
                select: { media: { select: { url: true, thumbnailUrl: true, fileType: true } } },
              },
            },
          },
        },
      });

      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map((r) => {
        const media = r.post.mediaAttachments[0]?.media;
        const isVideo = !!media?.fileType?.startsWith("video/");
        return {
          targetId: r.id,
          postId: r.post.id,
          caption: (r.contentOverride ?? r.post.content ?? "").slice(0, 280),
          format: r.format,
          publishedAt: r.publishedAt,
          publishedUrl: r.publishedUrl,
          mediaKind: media ? (isVideo ? ("video" as const) : ("image" as const)) : null,
          // ⚠️ NEVER hand a video URL to an <img> (the WebKit full-file-ingest
          // OOM). Only a real thumbnail, or the image itself, is an image URL.
          thumbnailUrl: media?.thumbnailUrl ?? (media && !isVideo ? media.url : null),
        };
      });
      return {
        channel,
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.targetId ?? null) : null,
      };
    }),

  /**
   * One page of TOP-LEVEL comments (each with its first page of replies),
   * loaded live from Meta. `cursor` is the previous page's `nextCursor`; the
   * legacy name `after` (2026-09-19 clients) is still accepted.
   */
  list: readRateLimited
    .input(
      z.object({
        targetId: z.string(),
        cursor: z.string().max(1024).nullish(),
        after: z.string().max(1024).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const t = await resolvePublishedCommentTarget(ctx.prisma as any, ctx.organizationId, input.targetId);
      enforcePageBudget(commentPageReadLimiter, t.platform, t.account.platformId);
      const cursor = input.cursor ?? input.after ?? undefined;

      let page: SocialCommentPage;
      try {
        page =
          t.platform === "FACEBOOK"
            ? await (getSocialProvider("FACEBOOK") as FacebookProvider).getPostComments(
                t.tokens,
                t.objectId,
                t.account.platformId,
                cursor
              )
            : await (getSocialProvider("INSTAGRAM") as InstagramProvider).getMediaComments(
                t.tokens,
                t.objectId,
                cursor,
                { igUserId: t.account.igUserId, username: t.account.username }
              );
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Failed to load comments." });
      }

      return {
        platform: t.platform,
        publishedUrl: t.publishedUrl,
        account: {
          channelId: t.account.channelId,
          name: t.account.name,
          username: t.account.username,
          avatar: t.account.avatar,
        },
        ...page,
      };
    }),

  /** Reply to a top-level comment, publicly, AS the connected Page / account. */
  reply: replyRateLimited
    .input(
      z.object({
        targetId: z.string(),
        // 🔴 SECURITY: the only client-supplied value that reaches a Graph URL
        // PATH. Unconstrained it is an arbitrary-authenticated-POST primitive —
        // see GRAPH_OBJECT_ID_RE. encodeURIComponent in the provider is the
        // second, independent layer.
        commentId: z.string().regex(GRAPH_OBJECT_ID_RE, "That doesn't look like a valid comment."),
        // Facebook's ceiling here; Instagram's lower one is enforced below once
        // the platform is known.
        message: z.string().trim().min(1, "Reply cannot be empty.").max(FB_COMMENT_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Resolving re-checks org/status/platform/disconnect — a client cannot
      // skip the gate `list` enforces by calling `reply` directly.
      const t = await resolvePublishedCommentTarget(ctx.prisma as any, ctx.organizationId, input.targetId);
      enforcePageBudget(commentPageReplyLimiter, t.platform, t.account.platformId);
      if (t.platform === "INSTAGRAM" && input.message.length > COMMENT_REPLY_MAX_LENGTH) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Instagram replies can be at most ${COMMENT_REPLY_MAX_LENGTH.toLocaleString("en-US")} characters.`,
        });
      }

      let result: { id: string };
      try {
        result =
          t.platform === "FACEBOOK"
            ? await (getSocialProvider("FACEBOOK") as FacebookProvider).replyToComment(
                t.tokens,
                input.commentId,
                input.message,
                t.account.platformId
              )
            : await (getSocialProvider("INSTAGRAM") as InstagramProvider).replyToComment(
                t.tokens,
                input.commentId,
                input.message
              );
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Failed to send the reply." });
      }

      // Never throws (it catches its own failures) — a missing audit row must
      // not turn a reply that IS live into an error the user would retry.
      await createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session?.user as any)?.id,
        action: AUDIT_ACTIONS.COMMENT_REPLIED,
        entityType: "PostTarget",
        entityId: input.targetId,
        metadata: {
          platform: t.platform,
          channelId: t.account.channelId,
          commentId: input.commentId,
          replyId: result.id,
          length: input.message.length,
        },
      });

      return { id: result.id, platform: t.platform };
    }),
});
