import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { postPublishQueue } from "@postautomation/queue";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { enforcePlanLimit } from "../middleware/plan-limit.middleware";

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
        channelIds: z.array(z.string()).min(1),
        scheduledAt: z.string().datetime().optional(),
        mediaIds: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        aiGenerated: z.boolean().default(false),
        aiProvider: z.string().optional(),
        aiPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Enforce plan limit for posts per month
      await enforcePlanLimit(ctx.organizationId, "postsPerMonth");

      const status = input.scheduledAt ? "SCHEDULED" : "DRAFT";

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
          targets: {
            create: input.channelIds.map((channelId) => ({
              channelId,
              status,
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

      // If scheduled, enqueue publish jobs
      if (status === "SCHEDULED" && input.scheduledAt) {
        const delay = new Date(input.scheduledAt).getTime() - Date.now();
        for (const target of post.targets) {
          await postPublishQueue.add(
            `publish-${target.id}`,
            {
              postId: post.id,
              postTargetId: target.id,
              channelId: target.channelId,
              platform: target.channel.platform,
              organizationId: ctx.organizationId,
            },
            { delay: Math.max(delay, 0), attempts: 3, backoff: { type: "exponential", delay: 30000 } }
          );
        }
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

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        content: z.string().min(1).optional(),
        contentVariants: z.record(z.string()).optional(),
        scheduledAt: z.string().datetime().nullable().optional(),
        tags: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.post.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      if (existing.status === "PUBLISHED" || existing.status === "PUBLISHING") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit published posts" });
      }

      const { id, tags, ...data } = input;
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
        },
        include: {
          targets: { include: { channel: true } },
          mediaAttachments: { include: { media: true } },
          tags: true,
        },
      });

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
        const slideResponse = await generateContent({
          provider: "gemini",
          platform: "INSTAGRAM",
          userPrompt: slidePrompt,
          tone: "professional",
        });
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
