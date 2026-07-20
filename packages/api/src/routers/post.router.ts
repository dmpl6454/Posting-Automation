import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { postPublishQueue, captionFanoutQueue, enqueueScheduledPublishJobs } from "@postautomation/queue";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { enforcePlanLimit } from "../middleware/plan-limit.middleware";
import { assertMediaOwned, assertMediaForPlatforms } from "./chat.router";
import { planCaptionFanout, captionFanoutJobId } from "../lib/caption-fanout";

/**
 * PR-5: load a PostTarget with its parent post's org and require it to belong
 * to `organizationId` — IDOR guard for per-target caption edits (mirrors
 * assertChannelsOwned in chat.router.ts). Throws NOT_FOUND for missing AND
 * foreign targets alike (no cross-org existence leak); rejects edits to
 * already-PUBLISHED targets. Exported for tests.
 */
export async function assertTargetEditable(
  prisma: { postTarget: { findUnique: (args: any) => Promise<any> } },
  organizationId: string,
  targetId: string
): Promise<{ id: string; status: string }> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    select: { id: true, status: true, post: { select: { organizationId: true } } },
  });
  if (!target || target.post?.organizationId !== organizationId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Post target not found" });
  }
  if (target.status === "PUBLISHED") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "This channel's caption was already published and can no longer be edited.",
    });
  }
  return { id: target.id, status: target.status };
}

export const postRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        status: z.enum(["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"]).optional(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const posts = await ctx.prisma.post.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.status && { status: input.status }),
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (posts.length > input.limit) {
        const lastItem = posts.pop();
        nextCursor = lastItem?.id;
      }

      return { posts, nextCursor };
    }),

  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true }, orderBy: { order: "asc" } },
          tags: true,
        },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });
      return post;
    }),

  create: orgProcedure
    .input(
      z.object({
        content: z.string().min(1),
        contentVariants: z.record(z.string()).optional(),
        // Empty is allowed for channel-less DRAFTS (save now, pick channels
        // later on the post page). Scheduling still requires ≥1 channel —
        // enforced below, not in the schema, so the error message is friendly.
        channelIds: z.array(z.string()).default([]),
        scheduledAt: z.string().datetime().optional(),
        mediaIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        aiGenerated: z.boolean().default(false),
        aiProvider: z.string().optional(),
        aiPrompt: z.string().optional(),
        // D2 (deferred Plan-1 media block): whether AI image generation is ON for
        // this post. Default true preserves current behaviour (the publish worker
        // auto-generates an image for media-less IG/FB). When explicitly false +
        // no media + an IG/FB target, scheduling is blocked (the post can never
        // publish). Drafts are exempt (only enforced when scheduledAt is set).
        aiImages: z.boolean().default(true),
        // PR-5: generate a DISTINCT AI caption per selected channel (async
        // caption-fanout worker writes PostTarget.contentOverride, then flips
        // the parked DRAFT to SCHEDULED). Only meaningful with >1 channel —
        // false / single-channel keeps today's shared-caption path untouched.
        uniqueCaptions: z.boolean().default(false),
        formatByChannelId: z.record(z.enum(["FEED", "REEL", "STORY", "SHORT", "VIDEO", "CAROUSEL"])).optional(),
        metadata: z.object({
          title: z.string().optional(),
          tags: z.array(z.string()).optional(),
          privacyStatus: z.enum(["public", "unlisted", "private"]).optional(),
          videoOverlayText: z.string().optional(),
        }).passthrough().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Enforce plan limit for posts per month
      await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);

      // Reject past scheduled dates (allow up to 60s in the past for clock skew)
      if (input.scheduledAt) {
        const scheduled = new Date(input.scheduledAt);
        const now = new Date(Date.now() - 60_000);
        if (scheduled < now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Scheduled time cannot be in the past." });
        }
        // A scheduled post must have somewhere to publish; only DRAFTS may be
        // saved channel-less (channels are added later on the post page).
        if (input.channelIds.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Select at least one channel to schedule a post." });
        }
      }

      // Validate every channelId belongs to this organization before persisting
      const ownedChannels = await ctx.prisma.channel.findMany({
        where: { id: { in: input.channelIds }, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (ownedChannels.length !== new Set(input.channelIds).size) {
        // Identify which requested IDs are invalid (deleted, or belong to another
        // org). Stale IDs commonly come from a restored draft referencing a channel
        // that was since disconnected/reconnected (new id). Name them so the error
        // is actionable instead of a vague "wrong organization".
        const ownedSet = new Set(ownedChannels.map((c) => c.id));
        const invalidIds = [...new Set(input.channelIds)].filter((id) => !ownedSet.has(id));
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            `Some selected channels are no longer available (they were removed or reconnected): ` +
            `${invalidIds.join(", ")}. Please re-select your channels and try again.`,
        });
      }

      // Reject any mediaId that doesn't belong to this organization.
      // Mirrors the channel ownership guard above — prevents a user from
      // attaching another org's Media row to their post (cross-org IDOR).
      if (input.mediaIds?.length) {
        await assertMediaOwned(ctx.prisma as any, ctx.organizationId, input.mediaIds);
      }

      // Block a media-less IG/FB SCHEDULE when AI is off (it can never publish).
      // Only enforced for scheduled posts — DRAFTS may be saved media-less and
      // filled in later. aiImages defaults true, so this is dormant by default.
      if (input.scheduledAt) {
        await assertMediaForPlatforms(ctx.prisma as any, ctx.organizationId, input.channelIds, {
          hasMedia: !!input.mediaIds?.length,
          aiEnabled: input.aiImages,
        });
      }

      // PR-5: unique-captions fanout — the post is parked as DRAFT (the publish
      // cron only picks SCHEDULED) while the caption-fanout worker generates
      // per-channel captions; the worker flips DRAFT→SCHEDULED when done (or
      // degraded). Quota unchanged: 1 post = 1 unit regardless of caption count.
      const captionFanout = planCaptionFanout({
        uniqueCaptions: input.uniqueCaptions,
        channelCount: input.channelIds.length,
        scheduledAt: input.scheduledAt ?? null,
      });

      const status = captionFanout.enabled ? "DRAFT" : input.scheduledAt ? "SCHEDULED" : "DRAFT";

      const post = await ctx.prisma.post.create({
        data: {
          organizationId: ctx.organizationId,
          createdById: (ctx.session.user as any).id,
          content: input.content,
          contentVariants: input.contentVariants || undefined,
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          status,
          aiGenerated: input.aiGenerated,
          aiProvider: input.aiProvider,
          aiPrompt: input.aiPrompt,
          metadata: (captionFanout.enabled
            ? {
                ...(input.metadata ?? {}),
                captionFanout: { requested: true, pendingSchedule: captionFanout.pendingSchedule },
              }
            : (input.metadata ?? undefined)) as any,
          targets: {
            create: input.channelIds.map((channelId) => ({
              channelId,
              status,
              format: (input.formatByChannelId?.[channelId] ?? null) as any,
            })),
          },
          ...(input.mediaIds?.length && {
            mediaAttachments: {
              create: input.mediaIds.map((mediaId, index) => ({
                mediaId,
                order: index,
              })),
            },
          }),
          ...(input.tags?.length && {
            tags: {
              create: input.tags.map((tag) => ({ tag })),
            },
          }),
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
      });

      // Phase 2 exact-time scheduling: enqueue per-target DELAYED publish jobs
      // now, with DETERMINISTIC jobIds (sched:{targetId}:{scheduledAtEpoch}) —
      // the 30s reconciliation cron re-adds the SAME ids at due time, so BullMQ
      // dedupes and the two producers can overlap freely. (The old "do NOT
      // enqueue here" rule existed because the cron's jobIds were
      // non-deterministic; deterministic ids are what make this safe.)
      // Best-effort: a Redis blip here must never fail post creation — the
      // cron reconciles, costing only exactness (≤30s), never the post.
      // Caption-fanout posts are parked DRAFT and enqueue after the flip via
      // the cron path instead.
      if (post.status === "SCHEDULED" && post.scheduledAt && post.targets.length > 0) {
        try {
          await enqueueScheduledPublishJobs({
            postId: post.id,
            organizationId: ctx.organizationId,
            scheduledAt: post.scheduledAt,
            targets: post.targets.map((t) => ({
              id: t.id,
              channelId: t.channelId,
              platform: t.channel.platform,
            })),
          });
        } catch (queueErr: any) {
          console.warn(`[post.create] exact-time enqueue failed for ${post.id} (cron will reconcile): ${queueErr?.message}`);
        }
      }

      // PR-5: ONE caption-fanout job per post (jobId dedupes re-submits). The
      // worker writes the per-target captions, then flips DRAFT→SCHEDULED for
      // the cron above to pick up.
      if (captionFanout.enabled) {
        await captionFanoutQueue.add(
          captionFanoutJobId(post.id),
          { postId: post.id, organizationId: ctx.organizationId },
          { jobId: captionFanoutJobId(post.id) }
        );
      }

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.POST_CREATED,
        entityType: "Post",
        entityId: post.id,
      }).catch(() => {});

      return post;
    }),

  // PR-5: edit one channel's caption override (review surface on the post
  // detail page). Org-scoped via assertTargetEditable (IDOR guard); PUBLISHED
  // targets are immutable. Passing null / blank clears the override so the
  // target falls back to the shared caption.
  updateTargetContent: orgProcedure
    .input(
      z.object({
        targetId: z.string(),
        contentOverride: z.string().max(100_000).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertTargetEditable(ctx.prisma as any, ctx.organizationId, input.targetId);
      const trimmed = input.contentOverride?.trim() ?? "";
      const updated = await ctx.prisma.postTarget.update({
        where: { id: input.targetId },
        data: { contentOverride: trimmed.length > 0 ? input.contentOverride : null },
      });
      return { id: updated.id, contentOverride: updated.contentOverride };
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        content: z.string().min(1).optional(),
        contentVariants: z.record(z.string()).optional(),
        scheduledAt: z.string().datetime().nullable().optional(),
        tags: z.array(z.string()).optional(),
        // Replace the post's target channels (drafts/scheduled only). Enables
        // adding channels to a channel-less draft saved from Content Studio.
        channelIds: z.array(z.string()).optional(),
        // Mirrors create: whether AI image generation is on for this post. Default
        // true keeps the worker's auto-gen behaviour; an explicit false blocks a
        // media-less IG/FB SCHEDULE (the post-update path of the media-required
        // guard — closes the create-only gap so it can't be reached via edit).
        aiImages: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          targets: { select: { channelId: true } },
          _count: { select: { mediaAttachments: true } },
        },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.status === "PUBLISHED" || existing.status === "PUBLISHING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit published posts" });
      }

      // `aiImages` is a guard input, not a Post column — keep it out of `data`.
      const { id, tags, channelIds, aiImages, ...data } = input;

      // Channel replacement: only for DRAFT/SCHEDULED posts (a FAILED post may
      // hold already-PUBLISHED targets that must not be deleted). Every id is
      // org-ownership-validated — same IDOR guard as create.
      if (channelIds) {
        if (existing.status !== "DRAFT" && existing.status !== "SCHEDULED") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Channels can only be changed on draft or scheduled posts." });
        }
        const ownedChannels = await ctx.prisma.channel.findMany({
          where: { id: { in: channelIds }, organizationId: ctx.organizationId },
          select: { id: true },
        });
        if (ownedChannels.length !== new Set(channelIds).size) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Some selected channels are no longer available. Please re-select your channels and try again." });
        }
      }

      // Full-coverage media-required guard (closes the create-only gap): if this
      // update leaves the post SCHEDULED (effective scheduledAt set), block a
      // media-less IG/FB target when AI is off — it can never publish. Uses the
      // EFFECTIVE channels (input replacement OR the post's existing targets) and
      // the post's existing media count (update can't change media). Dormant by
      // default (aiImages defaults true). Runs AFTER the channel IDOR check.
      const effectiveScheduledAt =
        input.scheduledAt !== undefined ? input.scheduledAt : existing.scheduledAt;
      if (effectiveScheduledAt) {
        const effectiveChannelIds = channelIds ?? existing.targets.map((t) => t.channelId);
        await assertMediaForPlatforms(ctx.prisma as any, ctx.organizationId, effectiveChannelIds, {
          hasMedia: existing._count.mediaAttachments > 0,
          aiEnabled: aiImages,
        });
      }

      const updatedPost = await ctx.prisma.post.update({
        where: { id },
        data: {
          ...data,
          scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : data.scheduledAt === null ? null : undefined,
          ...(tags && {
            tags: {
              deleteMany: {},
              create: tags.map((tag) => ({ tag })),
            },
          }),
          ...(channelIds && {
            targets: {
              deleteMany: {},
              create: channelIds.map((channelId) => ({
                channelId,
                status: existing.status,
              })),
            },
          }),
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
      });

      // Phase 2 exact-time scheduling: (re-)enqueue the delayed publish jobs
      // for the post's CURRENT schedule + targets. Idempotent — deterministic
      // jobIds (sched:{targetId}:{epoch}) dedupe against jobs the create path
      // or a previous update already added. A reschedule mints NEW ids (the
      // epoch changed) and the orphaned old-time jobs are neutralized by the
      // worker's isStaleScheduleJob guard; a channel swap recreates targets
      // (new ids), and the old targets' jobs die on the atomic claim.
      // Best-effort: the 30s cron reconciles on a Redis blip.
      if (updatedPost.status === "SCHEDULED" && updatedPost.scheduledAt && updatedPost.targets.length > 0) {
        try {
          await enqueueScheduledPublishJobs({
            postId: updatedPost.id,
            organizationId: ctx.organizationId,
            scheduledAt: updatedPost.scheduledAt,
            targets: updatedPost.targets.map((t) => ({
              id: t.id,
              channelId: t.channelId,
              platform: t.channel.platform,
            })),
          });
        } catch (queueErr: any) {
          console.warn(`[post.update] exact-time enqueue failed for ${updatedPost.id} (cron will reconcile): ${queueErr?.message}`);
        }
      }

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.POST_UPDATED,
        entityType: "Post",
        entityId: id,
      }).catch(() => {});

      return updatedPost;
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.post.delete({ where: { id: input.id } });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.POST_DELETED,
        entityType: "Post",
        entityId: input.id,
      }).catch(() => {});

      return { success: true };
    }),

  publishNow: orgProcedure
    .input(z.object({ id: z.string(), targetIds: z.array(z.string()).optional() }))
    .mutation(async ({ ctx, input }) => {
      const post = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: { targets: { include: { channel: true } } },
      });
      if (!post) throw new TRPCError({ code: "NOT_FOUND" });

      // If specific targetIds provided, use those; otherwise use all FAILED/DRAFT/SCHEDULED targets
      let targetsToPublish = input.targetIds?.length
        ? post.targets.filter((t) => input.targetIds!.includes(t.id) && t.status !== "PUBLISHED")
        : post.targets.filter((t) => t.status === "FAILED" || t.status === "DRAFT" || t.status === "SCHEDULED");

      if (targetsToPublish.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No eligible channels to publish." });
      }

      await ctx.prisma.post.update({
        where: { id: input.id },
        data: { status: "SCHEDULED", scheduledAt: new Date() },
      });

      await ctx.prisma.postTarget.updateMany({
        where: { id: { in: targetsToPublish.map((t) => t.id) } },
        data: { status: "SCHEDULED", errorMessage: null },
      });

      for (const target of targetsToPublish) {
        await postPublishQueue.add(
          `publish-now-${target.id}-${Date.now()}`,
          {
            postId: post.id,
            postTargetId: target.id,
            channelId: target.channelId,
            platform: target.channel.platform,
            organizationId: ctx.organizationId,
          },
          { delay: 0, attempts: 3, backoff: { type: "exponential", delay: 30000 } }
        );
      }

      return { success: true };
    }),

  /** Recent post target activity for the activity feed */
  recentActivity: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const targets = await ctx.prisma.postTarget.findMany({
        where: {
          post: { organizationId: ctx.organizationId },
          // Exclude pure drafts — only show targets that have been acted on
          status: { not: "DRAFT" },
        },
        include: {
          channel: { select: { name: true, platform: true } },
          post: { select: { content: true, scheduledAt: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
      });

      return targets.map((t) => ({
        id: t.id,
        postId: t.postId,
        status: t.status,
        platform: t.channel.platform,
        channelName: t.channel.name,
        content: t.post.content?.slice(0, 100),
        errorMessage: t.errorMessage,
        publishedAt: t.publishedAt,
        scheduledAt: t.post.scheduledAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    }),

  /** Generate Instagram carousel slides from text content */
  generateCarousel: orgProcedure
    .input(
      z.object({
        content: z.string().min(10).max(10000),
        slideCount: z.number().min(3).max(10).default(6),
        channelName: z.string().default(""),
        channelHandle: z.string().default(""),
        channelLogoUrl: z.string().optional(),
        theme: z.enum(["dark", "light", "gradient"]).default("dark"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { generateContent, generateImage: generateGeminiImage, generateCarouselImages } = await import("@postautomation/ai");
      const userId = (ctx.session.user as any).id as string;

      // S3 helpers
      function getS3() {
        return new S3Client({
          region: process.env.S3_REGION || "us-east-1",
          endpoint: process.env.S3_ENDPOINT || undefined,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
          },
        });
      }
      const bucket = process.env.S3_BUCKET || "postautomation-media";
      function getPublicUrl(key: string): string {
        if (process.env.S3_PUBLIC_URL) return `${process.env.S3_PUBLIC_URL}/${key}`;
        return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;
      }

      async function uploadAndCreateMedia(imageBase64: string, mimeType: string, prefix: string) {
        const s3 = getS3();
        const ext = mimeType.includes("png") ? "png" : "jpg";
        const contentType = mimeType.includes("png") ? "image/png" : "image/jpeg";
        const key = `carousel/${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
        const buf = Buffer.from(imageBase64, "base64");
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType }));
        const url = getPublicUrl(key);
        const media = await ctx.prisma.media.create({
          data: {
            organizationId: ctx.organizationId,
            uploadedById: userId,
            fileName: `carousel-slide-${prefix}.${ext}`,
            fileType: contentType,
            fileSize: buf.length,
            url,
          },
        });
        return { url, mediaId: media.id };
      }

      // 1. Break content into carousel slides via AI
      console.log(`[Carousel] Generating ${input.slideCount} slide outlines from content...`);
      const slidePrompt = `Analyze this content and break it into exactly ${input.slideCount - 2} key points for an Instagram carousel post.

Content: ${input.content.slice(0, 5000)}

Return a JSON array of objects with "title" (short, 3-6 words) and "body" (1-2 sentences, max 120 chars each).
Example: [{"title": "Key Insight", "body": "The main takeaway explained simply."}]

Return ONLY the JSON array, no other text.`;

      let slideData: Array<{ title: string; body: string }> = [];
      try {
        // Resilient chain: 'gemini' was hardcoded — during the Google billing
        // hold carousels silently degraded to the dumb text-split fallback.
        const { withTextProviderFallback } = await import("@postautomation/ai");
        const slideResponse = await withTextProviderFallback("gemini", (p) =>
          generateContent({
            provider: p as any,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          }),
        );
        const cleaned = slideResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const arrMatch = cleaned.match(/\[[\s\S]*\]/);
        if (arrMatch) slideData = JSON.parse(arrMatch[0]);
      } catch (e) {
        console.warn(`[Carousel] AI slide generation failed, using fallback:`, (e as Error).message);
      }

      // Fallback: split content into chunks
      if (slideData.length === 0) {
        const sentences = input.content.split(/[.!?]+/).filter((s) => s.trim().length > 15);
        slideData = sentences.slice(0, input.slideCount - 2).map((s, i) => ({
          title: `Point ${i + 1}`,
          body: s.trim().slice(0, 120),
        }));
      }

      // 2. Build all slides: cover + content + CTA
      const headline = input.content.split("\n")[0]?.slice(0, 80) || "Key Insights";
      const handle = input.channelHandle || input.channelName || "channel";
      const channelName = input.channelName || "Channel";
      const allSlides = [
        { type: "cover", title: headline, body: "" },
        ...slideData.map((d) => ({ type: "content", title: d.title, body: d.body })),
        { type: "cta", title: "Follow for More", body: `@${handle}` },
      ];

      console.log(`[Carousel] Generating ${allSlides.length} AI carousel images...`);

      // 3. Generate AI images one at a time with delay to avoid Gemini rate limits
      const DELAY_BETWEEN_SLIDES = 4000; // 4s between each slide
      const slideImages: Array<{ imageBase64: string; mimeType: string } | null> = [];

      const slidePrompts = allSlides.map((slide, i) => {
        if (slide.type === "cover") {
          return `Create a professional Instagram carousel COVER slide image.
Topic: "${slide.title}"
Channel: "${channelName}"
Style: Bold headline text "${slide.title.slice(0, 60)}" with dramatic background. Modern typography, vibrant colors, 4:5 portrait ratio. Premium social media design.`;
        } else if (slide.type === "cta") {
          return `Create an Instagram carousel CTA slide image.
Large centered text: "Follow for More"
Handle: @${handle}
Style: Clean minimal design, bold typography, 4:5 portrait ratio.`;
        } else {
          return `Create an Instagram carousel content slide image (slide ${i + 1} of ${allSlides.length}).
Heading: "${slide.title}"
Body text: "${slide.body}"
Style: Clean readable typography, visual hierarchy, 4:5 portrait ratio. Professional social media design.`;
        }
      });

      for (let i = 0; i < slidePrompts.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, DELAY_BETWEEN_SLIDES));
        let success = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) {
              const backoff = 5000 * (attempt + 1); // 10s, 15s
              console.log(`[Carousel] Retrying slide ${i + 1} (attempt ${attempt + 1}) after ${backoff}ms...`);
              await new Promise((r) => setTimeout(r, backoff));
            }
            console.log(`[Carousel] Generating slide ${i + 1}/${slidePrompts.length}...`);
            const result = await generateGeminiImage({ prompt: slidePrompts[i]!, aspectRatio: "3:4" });
            slideImages.push({ imageBase64: result.imageBase64, mimeType: result.mimeType });
            console.log(`[Carousel] Slide ${i + 1} generated successfully`);
            success = true;
            break;
          } catch (e) {
            console.warn(`[Carousel] Slide ${i + 1} attempt ${attempt + 1} failed:`, (e as Error).message);
          }
        }
        if (!success) {
          console.warn(`[Carousel] Slide ${i + 1} failed after 3 attempts, skipping`);
          slideImages.push(null);
        }
      }

      // 4. Fallback: if Gemini AI failed for all/most slides, use Puppeteer HTML templates
      const successCount = slideImages.filter((s) => s !== null).length;
      if (successCount < Math.ceil(allSlides.length / 2)) {
        console.log(`[Carousel] Only ${successCount}/${allSlides.length} AI slides succeeded — falling back to Puppeteer templates`);
        try {
          const carouselResult = await generateCarouselImages({
            slides: allSlides.map((s) => ({
              type: s.type as "cover" | "content" | "cta",
              title: s.title,
              body: s.body,
            })),
            channelName,
            handle,
            theme: input.theme,
          });
          // Replace all slide images with Puppeteer results
          slideImages.length = 0;
          for (const slide of carouselResult.slides) {
            slideImages.push({ imageBase64: slide.imageBase64, mimeType: slide.mimeType });
          }
          console.log(`[Carousel] Puppeteer fallback generated ${carouselResult.slides.length} slides`);
        } catch (puppeteerErr) {
          console.warn(`[Carousel] Puppeteer fallback also failed:`, (puppeteerErr as Error).message);
        }
      }

      // Upload successful slides to S3
      const mediaItems: Array<{ url: string; mediaId: string }> = [];
      for (let i = 0; i < slideImages.length; i++) {
        const slide = slideImages[i];
        if (!slide) continue;
        const result = await uploadAndCreateMedia(slide.imageBase64, slide.mimeType, `slide-${i + 1}`);
        mediaItems.push(result);
      }

      if (mediaItems.length === 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to generate carousel images. Check GOOGLE_GEMINI_API_KEY or try with fewer slides.",
        });
      }

      console.log(`[Carousel] Generated ${mediaItems.length}/${allSlides.length} slides successfully`);
      return {
        slides: mediaItems,
        slideCount: mediaItems.length,
        slideOutlines: allSlides.map((s) => ({ type: s.type, title: s.title, body: s.body })),
      };
    }),
});
