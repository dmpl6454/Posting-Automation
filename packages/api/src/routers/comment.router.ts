import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import {
  getSocialProvider,
  commentCapabilities,
  fetchMetaTokenWindow,
  resolveMetaCredentials,
  COMMENT_NOT_ON_POST_MESSAGE,
  COMMENT_LIKE_REFUSED_MESSAGE,
  COMMENT_REPLY_MAX_LENGTH,
  FB_COMMENT_MAX_LENGTH,
  GRAPH_OBJECT_ID_RE,
  type CommentCapabilities,
  type CommentModerationAction,
  type CommentPlatform,
  type FacebookProvider,
  type InstagramProvider,
  type SocialCommentPage,
} from "@postautomation/social";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import {
  commentIgLikeBurstLimiter,
  commentModerateRateLimiter,
  commentPageModerateLimiter,
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
 *             reply / like / hide / delete / edit → pages_manage_engagement
 *   Instagram read + reply + hide + delete → instagram_manage_comments
 *             like (comments, replies, the post) → instagram_manage_engagement
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
  /** Which Meta app minted this channel's token (NULL = the legacy app). */
  metaAppId: string | null;
  /** Graph object whose /comments edge we read — PostTarget.publishedId. */
  objectId: string;
  /** FB video targets: the composite feed-post id, when analytics-sync resolved it. */
  resolvedPostId: string | null;
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
      // resolvedPostId (FB videos: the feed-post id analytics-sync recorded) —
      // one more valid prefix for this post's comment ids.
      metadata: true,
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
    metaAppId: channel.metaAppId ?? null,
    objectId: target.publishedId as string,
    resolvedPostId:
      typeof (target.metadata as any)?.resolvedPostId === "string" ? (target.metadata as any).resolvedPostId : null,
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

/** The scopes recorded at connect (or by a later check); null when never checked. */
function cachedGrantedScopes(metadata: Record<string, unknown> | undefined | null): string[] | null {
  const raw = metadata?.grantedScopes;
  return Array.isArray(raw) && raw.every((s) => typeof s === "string") ? (raw as string[]) : null;
}

/**
 * Ask Meta which scopes this channel's token was actually GRANTED (one
 * debug_token call) and remember the answer on the channel. Used lazily for
 * channels connected before grantedScopes was recorded at connect, and again
 * whenever Meta refuses a call for a missing permission (the user may have
 * revoked it in Facebook's settings since).
 *
 * ⚠️ Atomic jsonb MERGE, never a read-modify-write of the whole column: the
 * worker writes insightsHealth into the same `metadata` concurrently, and a
 * whole-column write would silently drop its verdict. Best-effort — never
 * fails the caller.
 */
async function refreshGrantedScopes(prisma: any, t: ResolvedCommentTarget): Promise<string[] | null> {
  try {
    const creds = resolveMetaCredentials(t.platform, t.metaAppId);
    if (!creds) return null;
    const win = await fetchMetaTokenWindow(t.tokens.accessToken, creds.clientId, creds.clientSecret);
    // A DEAD token reports no scopes — recording that as "granted nothing" would
    // show "missing the permission" when the real fault is the token (#190,
    // which the comment call itself surfaces as "reconnect"). Stay unknown.
    if (!win || !win.valid) return null;
    const patch = JSON.stringify({ grantedScopes: win.scopes, grantedScopesCheckedAt: new Date().toISOString() });
    await prisma.$executeRaw`UPDATE "Channel" SET "metadata" = COALESCE("metadata", '{}'::jsonb) || ${patch}::jsonb WHERE "id" = ${t.account.channelId}`;
    return win.scopes;
  } catch (err: any) {
    console.error("[comment] granted-scope check failed:", err?.message ?? err);
    return null;
  }
}

/** When the grant was last read (connect, backfill cron, or a lazy check). */
function grantCheckedAt(metadata: Record<string, unknown> | undefined | null): number | null {
  const raw = metadata?.grantedScopesCheckedAt;
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
}

const GRANT_RECHECK_IF_MISSING_MS = 60 * 60 * 1000; // a "missing" answer is re-read after 1h
const GRANT_RECHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // any answer after a week

/**
 * Should the list re-read the grant? Yes when it was never read; when it says a
 * write permission is missing and is over an hour old (the person may have
 * granted it in Facebook's settings — reconnecting rewrites it anyway); and
 * when it is over a week old. At most one debug_token per channel per hour.
 */
function grantNeedsRefresh(
  platform: CommentPlatform,
  metadata: Record<string, unknown> | undefined | null,
  now: number
): boolean {
  const scopes = cachedGrantedScopes(metadata);
  if (!scopes) return true;
  const checkedAt = grantCheckedAt(metadata);
  if (checkedAt === null) return true;
  const age = now - checkedAt;
  if (age > GRANT_RECHECK_MAX_AGE_MS) return true;
  return commentCapabilities(platform, scopes).canReply === false && age > GRANT_RECHECK_IF_MISSING_MS;
}

/**
 * A provider message that means "the token lacks the permission" — the comment
 * permission OR the Instagram like permission — so the cached grant is re-read.
 */
function isPermissionMessage(message: unknown): boolean {
  return /hasn't (been )?granted (comment|permission to like)/i.test(String(message ?? ""));
}

/** Public posts as the Page / account — human-paced ceiling (see the limiter). */
const replyRateLimited = orgProcedure.use(createRateLimitMiddleware(commentReplyRateLimiter));
/** Live Graph reads against the Page's rate budget (see the limiter). */
const readRateLimited = orgProcedure.use(createRateLimitMiddleware(commentReadRateLimiter));
/** Hide / unhide / delete / like / edit (see the limiter). */
const moderateRateLimited = orgProcedure.use(createRateLimitMiddleware(commentModerateRateLimiter));

/**
 * 🔒 Instagram writes must target a comment ON THE TARGET'S OWN MEDIA. An IG
 * channel's token is the Facebook USER token, which reaches every IG account
 * that consent granted — including accounts connected in other workspaces by
 * the same person — so Meta's own authorization does not scope it to this
 * channel. (Facebook has its own check below: a Page token is scoped to the
 * Page, but not to COMMENTS on this post.)
 */
async function assertInstagramCommentOnTarget(prisma: any, t: ResolvedCommentTarget, commentId: string): Promise<void> {
  if (t.platform !== "INSTAGRAM") return;
  const provider = getSocialProvider("INSTAGRAM") as InstagramProvider;
  let mediaId: string | null;
  try {
    mediaId = await provider.getCommentMediaId(t.tokens, commentId);
  } catch (err: any) {
    // The lookup is usually the FIRST call to hit a missing permission — keep
    // the recorded grant honest so the reconnect banner appears.
    if (isPermissionMessage(err?.message)) void refreshGrantedScopes(prisma, t);
    throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Couldn't check that comment." });
  }
  if (mediaId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That comment no longer exists — it may have been deleted. Refresh and try again.",
    });
  }
  if (mediaId !== t.objectId) {
    throw new TRPCError({ code: "FORBIDDEN", message: COMMENT_NOT_ON_POST_MESSAGE });
  }
}

/** The object-id part a Facebook comment id starts with, for a post id. */
function postObjectSegment(postId: string): string {
  return postId.includes("_") ? postId.slice(postId.indexOf("_") + 1) : postId;
}

/**
 * 🔒 Facebook writes must target a COMMENT ON THIS POST. The channel token is a
 * Page token, which limits the damage to this Page — but not to comments: the
 * id-shape check alone also accepts a Page POST id (`{pageId}_{postId}`) or a
 * bare photo/video id, and `DELETE /{id}` / `POST /{id} {message}` would then
 * delete or rewrite a live Page post (caught in review, 2026-09-23).
 *
 * Facebook comment ids are `{postObjectId}_{commentId}`, where postObjectId is
 * the second half of the post's composite id — live-verified 2026-09-23
 * (post 1200847766436751_122136671235340772 → comment
 * 122136671235340772_1452846363362337). Replies share the prefix. For a VIDEO
 * post (bare Video-node id) the prefix may be the video id or its feed-post id,
 * so both are accepted, resolving the post id once if analytics hasn't.
 */
async function assertFacebookCommentOnTarget(t: ResolvedCommentTarget, commentId: string): Promise<void> {
  if (t.platform !== "FACEBOOK") return;
  const refuse = () => {
    throw new TRPCError({ code: "FORBIDDEN", message: COMMENT_NOT_ON_POST_MESSAGE });
  };
  const underscore = commentId.indexOf("_");
  // A comment id is ALWAYS composite; a bare id is a photo/video/post node.
  if (underscore <= 0) refuse();
  // A Page post id starts with the Page id — never a comment on this post.
  if (commentId === t.objectId || commentId.startsWith(`${t.account.platformId}_`)) refuse();

  const prefix = commentId.slice(0, underscore);
  const accepted = new Set<string>([postObjectSegment(t.objectId)]);
  if (t.resolvedPostId) accepted.add(postObjectSegment(t.resolvedPostId));
  if (accepted.has(prefix)) return;

  // Video post whose feed-post id we haven't learned yet: resolve it once.
  if (!t.objectId.includes("_") && !t.resolvedPostId) {
    const fb = getSocialProvider("FACEBOOK") as FacebookProvider;
    const resolved = await fb.resolveVideoPostId(t.tokens, t.objectId, t.account.platformId).catch(() => null);
    if (resolved && postObjectSegment(resolved) === prefix) return;
  }
  refuse();
}

/** Both platforms' "is this comment on this post?" gate, run before every write. */
async function assertCommentOnTarget(prisma: any, t: ResolvedCommentTarget, commentId: string): Promise<void> {
  await assertFacebookCommentOnTarget(t, commentId);
  await assertInstagramCommentOnTarget(prisma, t, commentId);
}

/** A write whose outcome the platform didn't confirm — it may have happened. */
function isUnconfirmedMessage(message: unknown): boolean {
  return /may already be posted|didn't confirm that change/i.test(String(message ?? ""));
}

const MODERATION_AUDIT: Record<CommentModerationAction, string> = {
  hide: AUDIT_ACTIONS.COMMENT_HIDDEN,
  unhide: AUDIT_ACTIONS.COMMENT_UNHIDDEN,
  delete: AUDIT_ACTIONS.COMMENT_DELETED,
  like: AUDIT_ACTIONS.COMMENT_LIKED,
  unlike: AUDIT_ACTIONS.COMMENT_UNLIKED,
  edit: AUDIT_ACTIONS.COMMENT_EDITED,
};

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

/**
 * Instagram locks an account out of liking for an HOUR after "more than 50
 * requests in 5 seconds" (User Likes reference). Keyed per IG account across
 * every user and org, checked after the target resolves.
 */
function enforceInstagramLikeBurst(platformId: string): void {
  if (commentIgLikeBurstLimiter(`INSTAGRAM:${platformId}`).success) return;
  throw new TRPCError({
    code: "TOO_MANY_REQUESTS",
    message:
      "Slow down a little — Instagram locks an account out of liking for an hour if it likes too fast. Try again in a few seconds.",
  });
}

/** The IG user id the like is made AS — always from our DB, never the client. */
function requireIgUserId(t: ResolvedCommentTarget): string {
  const id = t.account.igUserId;
  if (!id) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This Instagram account's connection is incomplete. Reconnect it on the Channels page, then try again.",
    });
  }
  return id;
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
      // metadata is read ONLY to derive commentAccess from the cached grant —
      // never forwarded raw (it carries provider internals).
      select: { id: true, platform: true, name: true, username: true, avatar: true, isActive: true, metadata: true },
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
      .map(({ metadata, ...c }) => {
        const row = byChannel.get(c.id);
        return {
          ...c,
          publishedPosts: row?._count._all ?? 0,
          lastPublishedAt: row?._max.publishedAt ?? null,
          commentAccess: commentCapabilities(
            c.platform as CommentPlatform,
            cachedGrantedScopes(metadata as Record<string, unknown> | null)
          ),
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

      // What this channel's token may do — from the grant recorded at connect,
      // or (channels connected before that existed) one lazy debug_token check.
      let scopes = cachedGrantedScopes(t.tokens.metadata);
      if (!cursor && grantNeedsRefresh(t.platform, t.tokens.metadata, Date.now())) {
        scopes = (await refreshGrantedScopes(ctx.prisma, t)) ?? scopes;
      }

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
        // A permission refusal may mean the grant changed since we last looked —
        // refresh it so the next load shows the right "reconnect" state.
        if (isPermissionMessage(err?.message)) void refreshGrantedScopes(ctx.prisma, t);
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Failed to load comments." });
      }

      const capabilities: CommentCapabilities = commentCapabilities(t.platform, scopes);
      return {
        capabilities,
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

      await assertCommentOnTarget(ctx.prisma, t, input.commentId);

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
        if (isPermissionMessage(err?.message)) void refreshGrantedScopes(ctx.prisma, t);
        // A reply that MAY be live is still an outward action someone took —
        // keep the trail even though we couldn't confirm it.
        if (isUnconfirmedMessage(err?.message)) {
          await createAuditLog({
            organizationId: ctx.organizationId,
            userId: (ctx.session?.user as any)?.id,
            action: AUDIT_ACTIONS.COMMENT_REPLIED,
            entityType: "PostTarget",
            entityId: input.targetId,
            metadata: { platform: t.platform, channelId: t.account.channelId, commentId: input.commentId, outcome: "unconfirmed", length: input.message.length },
          });
        }
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

  /**
   * Moderate a comment as the Page / account: hide, unhide, delete, like and
   * unlike (both platforms — Instagram likes via instagram_manage_engagement),
   * and edit-own (Facebook only). Same org/status/platform gate as list/reply;
   * both platforms prove the comment is on the target post first. All of these
   * are idempotent state changes.
   *
   * Instagram likes return the re-read `likeCount`: Meta's like/unlike "has no
   * effect" when the state already matches, so a success does not say whether
   * the count moved, and Instagram exposes no "liked by me" field to ask.
   */
  moderate: moderateRateLimited
    .input(
      z
        .object({
          targetId: z.string(),
          // 🔴 Same path-injection guard as reply — see GRAPH_OBJECT_ID_RE.
          commentId: z.string().regex(GRAPH_OBJECT_ID_RE, "That doesn't look like a valid comment."),
          action: z.enum(["hide", "unhide", "delete", "like", "unlike", "edit"]),
          message: z.string().trim().min(1, "Comment cannot be empty.").max(FB_COMMENT_MAX_LENGTH).optional(),
        })
        .refine((v) => v.action !== "edit" || !!v.message, { message: "Edited text is required.", path: ["message"] })
    )
    .mutation(async ({ ctx, input }) => {
      const t = await resolvePublishedCommentTarget(ctx.prisma as any, ctx.organizationId, input.targetId);
      if (t.platform === "INSTAGRAM" && input.action === "edit") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Instagram doesn't allow editing a comment — delete it and reply again instead.",
        });
      }
      const igLike = t.platform === "INSTAGRAM" && (input.action === "like" || input.action === "unlike");
      const igUserId = igLike ? requireIgUserId(t) : null;
      enforcePageBudget(commentPageModerateLimiter, t.platform, t.account.platformId);
      if (igLike) enforceInstagramLikeBurst(t.account.platformId);
      await assertCommentOnTarget(ctx.prisma, t, input.commentId);

      let likeCount: number | null | undefined;
      try {
        if (t.platform === "FACEBOOK") {
          const fb = getSocialProvider("FACEBOOK") as FacebookProvider;
          const pageId = t.account.platformId;
          if (input.action === "hide" || input.action === "unhide") {
            await fb.setCommentHidden(t.tokens, input.commentId, input.action === "hide", pageId);
          } else if (input.action === "delete") {
            await fb.deleteComment(t.tokens, input.commentId, pageId);
          } else if (input.action === "like" || input.action === "unlike") {
            await fb.setCommentLiked(t.tokens, input.commentId, input.action === "like", pageId);
          } else {
            await fb.editComment(t.tokens, input.commentId, input.message!, pageId);
          }
        } else {
          const ig = getSocialProvider("INSTAGRAM") as InstagramProvider;
          if (input.action === "delete") await ig.deleteComment(t.tokens, input.commentId);
          else if (igLike) await ig.setCommentLiked(t.tokens, igUserId!, input.commentId, input.action === "like");
          else await ig.setCommentHidden(t.tokens, input.commentId, input.action === "hide");
        }
      } catch (err: any) {
        let message: string = err?.message ?? "Couldn't complete that action.";
        if (isPermissionMessage(message)) {
          void refreshGrantedScopes(ctx.prisma, t);
          // Instagram refuses likes on comments FROM private accounts with the
          // same "Authorization Error" as a missing permission. If the recorded
          // grant already includes the like permission, "reconnect" is the
          // wrong advice — say what is actually likely. (The re-read above still
          // catches a permission revoked since it was recorded.)
          if (igLike && cachedGrantedScopes(t.tokens.metadata)?.includes("instagram_manage_engagement")) {
            message = COMMENT_LIKE_REFUSED_MESSAGE;
          }
        }
        if (isUnconfirmedMessage(message)) {
          await createAuditLog({
            organizationId: ctx.organizationId,
            userId: (ctx.session?.user as any)?.id,
            action: MODERATION_AUDIT[input.action],
            entityType: "PostTarget",
            entityId: input.targetId,
            metadata: { platform: t.platform, channelId: t.account.channelId, commentId: input.commentId, outcome: "unconfirmed" },
          });
        }
        throw new TRPCError({ code: "BAD_REQUEST", message });
      }

      await createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session?.user as any)?.id,
        action: MODERATION_AUDIT[input.action],
        entityType: "PostTarget",
        entityId: input.targetId,
        // Never the comment text (edit included).
        metadata: { platform: t.platform, channelId: t.account.channelId, commentId: input.commentId },
      });

      // After the action is confirmed and audited: a failed re-read only means
      // the UI keeps its current number, never that the like failed.
      if (igLike) {
        likeCount = await (getSocialProvider("INSTAGRAM") as InstagramProvider).readLikeCount(t.tokens, input.commentId);
      }

      return { ok: true as const, action: input.action, platform: t.platform, likeCount };
    }),

  /**
   * Like / unlike the POST itself as the Instagram account (feed post, reel,
   * carousel) — `POST|DELETE /{ig-user-id}/likes` with `media_id`. Meta's
   * screencast requirements for instagram_manage_engagement ask for a like on
   * media as well as on comments, and this is the same permission and edge.
   *
   * The media id is the target's own `publishedId` from OUR database — no
   * client-supplied Graph id reaches this call. Stories are refused by
   * resolvePublishedCommentTarget (Instagram cannot like a story anyway).
   */
  likePost: moderateRateLimited
    .input(z.object({ targetId: z.string(), liked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const t = await resolvePublishedCommentTarget(ctx.prisma as any, ctx.organizationId, input.targetId);
      if (t.platform !== "INSTAGRAM") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Liking the post from here is available for Instagram posts." });
      }
      const igUserId = requireIgUserId(t);
      enforcePageBudget(commentPageModerateLimiter, t.platform, t.account.platformId);
      enforceInstagramLikeBurst(t.account.platformId);

      const ig = getSocialProvider("INSTAGRAM") as InstagramProvider;
      const action = input.liked ? AUDIT_ACTIONS.POST_LIKED : AUDIT_ACTIONS.POST_UNLIKED;
      const audit = (outcome?: "unconfirmed") =>
        createAuditLog({
          organizationId: ctx.organizationId,
          userId: (ctx.session?.user as any)?.id,
          action,
          entityType: "PostTarget",
          entityId: input.targetId,
          metadata: { platform: t.platform, channelId: t.account.channelId, ...(outcome ? { outcome } : {}) },
        });
      try {
        await ig.setMediaLiked(t.tokens, igUserId, t.objectId, input.liked);
      } catch (err: any) {
        if (isPermissionMessage(err?.message)) void refreshGrantedScopes(ctx.prisma, t);
        if (isUnconfirmedMessage(err?.message)) await audit("unconfirmed");
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Couldn't complete that action." });
      }
      await audit();
      const likeCount = await ig.readLikeCount(t.tokens, t.objectId);
      return { ok: true as const, liked: input.liked, likeCount };
    }),
});
