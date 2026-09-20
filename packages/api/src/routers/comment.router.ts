import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import {
  getSocialProvider,
  COMMENT_REPLY_MAX_LENGTH,
  GRAPH_OBJECT_ID_RE,
  type InstagramProvider,
} from "@postautomation/social";

/**
 * Instagram comment replies (2026-09-19). See
 * packages/social/src/utils/instagram-comments.ts for the permission status
 * (`instagram_manage_comments` — requested, not yet Advanced-Access approved
 * for external users; app-role accounts get it on reconnect).
 *
 * ⚠️ Org-scoped in TWO separate queries, never `postTarget.findUnique({
 * include: { channel: true } })` — only a DIRECT prisma.channel.findUnique/
 * findFirst/findMany auto-decrypts accessToken (the $extends in
 * packages/db/src/index.ts). Reading the channel through the PostTarget
 * relation returns `enc:v1:` ciphertext, which would fail every Graph call
 * with "Cannot parse access token" — the exact DECRYPT GOTCHA documented for
 * every other analytics/publish path in this codebase.
 */
async function resolvePublishedInstagramTarget(
  prisma: {
    postTarget: { findUnique: (args: any) => Promise<any> };
    channel: { findUnique: (args: any) => Promise<any> };
  },
  organizationId: string,
  targetId: string
): Promise<{
  mediaId: string;
  tokens: { accessToken: string; refreshToken?: string; metadata?: Record<string, unknown> };
}> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      status: true,
      format: true,
      publishedId: true,
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
  // A story has no comments edge (and expires in 24h), so the call could only
  // ever fail with a confusing Meta error. Same format-vs-mode distinction the
  // publish and analytics paths already draw.
  if (target.format === "STORY") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Instagram stories don't have comments — replies are available on feed posts and reels.",
    });
  }

  const channel = await prisma.channel.findUnique({ where: { id: target.channelId } });
  if (!channel || channel.platform !== "INSTAGRAM") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Comment replies are only available for Instagram channels.",
    });
  }
  if (channel.disconnectedAt) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This channel has been disconnected." });
  }

  return {
    mediaId: target.publishedId as string,
    tokens: {
      accessToken: channel.accessToken,
      refreshToken: channel.refreshToken ?? undefined,
      // Mirrors the avatar-cache / analytics-sync precedent: thread channel
      // metadata through in case a future call needs it (e.g. igUserId).
      metadata: (channel.metadata ?? undefined) as Record<string, unknown> | undefined,
    },
  };
}

export const commentRouter = createRouter({
  list: orgProcedure
    .input(z.object({ targetId: z.string(), after: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const { mediaId, tokens } = await resolvePublishedInstagramTarget(
        ctx.prisma as any,
        ctx.organizationId,
        input.targetId
      );
      const provider = getSocialProvider("INSTAGRAM") as InstagramProvider;
      try {
        return await provider.getMediaComments(tokens, mediaId, input.after);
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Failed to load comments." });
      }
    }),

  reply: orgProcedure
    .input(
      z.object({
        targetId: z.string(),
        // 🔴 SECURITY: this is the only client-supplied value that reaches a
        // Graph URL PATH. Unconstrained, it is an arbitrary-authenticated-POST
        // primitive — see GRAPH_OBJECT_ID_RE. encodeURIComponent in the provider
        // is the second, independent layer.
        commentId: z
          .string()
          .regex(GRAPH_OBJECT_ID_RE, "That doesn't look like a valid Instagram comment."),
        // Same ceiling as a normal Instagram comment.
        message: z.string().trim().min(1, "Reply cannot be empty.").max(COMMENT_REPLY_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Resolving (and thereby re-checking status/platform/disconnect) even
      // though `reply` doesn't need `mediaId` — a client cannot skip the same
      // org/platform gate `list` enforces by targeting `reply` directly.
      const { tokens } = await resolvePublishedInstagramTarget(
        ctx.prisma as any,
        ctx.organizationId,
        input.targetId
      );
      const provider = getSocialProvider("INSTAGRAM") as InstagramProvider;
      try {
        return await provider.replyToComment(tokens, input.commentId, input.message);
      } catch (err: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: err?.message ?? "Failed to send the reply." });
      }
    }),
});
