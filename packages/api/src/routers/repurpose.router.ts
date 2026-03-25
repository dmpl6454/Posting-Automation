import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";

// S3 helpers
function getS3Client(): S3Client {
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
const BUCKET = process.env.S3_BUCKET || "postautomation-media";
function getPublicUrl(key: string): string {
  if (process.env.S3_PUBLIC_URL) return `${process.env.S3_PUBLIC_URL}/${key}`;
  return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;
}

export const repurposeRouter = createRouter({
  repurpose: protectedProcedure
    .input(
      z.object({
        originalContent: z.string().min(1).max(50000),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek"]).default("openai"),
      })
    )
    .mutation(async ({ input }) => {
      const { repurposeContent } = await import("@postautomation/ai");
      const result = await repurposeContent({
        originalContent: input.originalContent,
        targetPlatforms: input.targetPlatforms,
        provider: input.provider,
      });
      return { platformContent: result };
    }),

  /** Extract content from a URL */
  extractUrl: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input }) => {
      const { extractUrlContent } = await import("@postautomation/ai");
      const content = await extractUrlContent(input.url);
      return content;
    }),

  /** Repurpose from URL — generates caption + media (static/carousel/reel) */
  repurposeFromUrl: protectedProcedure
    .input(
      z.object({
        url: z.string().url(),
        format: z.enum(["static", "carousel", "reel"]),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek"]).default("gemini"),
        channelName: z.string().optional(),
        channelHandle: z.string().optional(),
        logoUrl: z.string().optional(),
        accentColor: z.string().optional(),
        theme: z.enum(["dark", "light", "gradient"]).default("dark"),
      })
    )
    .mutation(async ({ input }) => {
      const {
        extractUrlContent,
        repurposeContent,
        generateStaticNewsCreativeImage,
        generateCarouselImages,
        generateReelVideo,
        generateContent,
      } = await import("@postautomation/ai");

      // 1. Extract content from URL
      console.log(`[Repurpose] Extracting content from: ${input.url}`);
      const extracted = await extractUrlContent(input.url);
      console.log(`[Repurpose] Extracted: "${extracted.title}" (${extracted.body.length} chars)`);

      // 2. Generate platform-specific captions
      const sourceText = `Title: ${extracted.title}\n\n${extracted.body.slice(0, 6000)}`;
      const platformContent = await repurposeContent({
        originalContent: sourceText,
        targetPlatforms: input.targetPlatforms,
        provider: input.provider,
      });

      // 3. Generate media based on format
      const channelName = input.channelName || extracted.siteName || "Channel";
      const handle = input.channelHandle || channelName;
      let mediaUrls: string[] = [];
      let mediaType = "image/jpeg";

      if (input.format === "static") {
        // Single news creative image
        try {
          const result = await generateStaticNewsCreativeImage({
            headline: extracted.title,
            channelName,
            handle,
            logoUrl: input.logoUrl || null,
            template: "breaking_news",
            bgSeed: Date.now(),
            date: new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase(),
          });

          const s3 = getS3Client();
          const key = `repurpose/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
          const buf = Buffer.from(result.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: "image/jpeg" }));
          mediaUrls = [getPublicUrl(key)];
          console.log(`[Repurpose] Static image uploaded: ${mediaUrls[0]}`);
        } catch (e) {
          console.warn(`[Repurpose] Static image generation failed:`, (e as Error).message);
        }
      } else if (input.format === "carousel" || input.format === "reel") {
        // Generate carousel slide content via AI
        const slidePrompt = `Analyze this article and break it into 5-7 key points for a carousel post.

Title: ${extracted.title}
Content: ${extracted.body.slice(0, 4000)}

Return a JSON array of objects with "title" (short, 3-6 words) and "body" (1-2 sentences, max 120 chars each).
Example: [{"title": "Key Insight", "body": "The main takeaway explained simply."}]

Return ONLY the JSON array, no other text.`;

        let slideData: Array<{ title: string; body: string }> = [];
        try {
          const slideResponse = await generateContent({
            provider: input.provider,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          });

          const cleaned = slideResponse
            .replace(/```json\s*/g, "")
            .replace(/```\s*/g, "")
            .trim();
          // Find the JSON array
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            slideData = JSON.parse(arrMatch[0]);
          }
        } catch (e) {
          console.warn(`[Repurpose] AI slide generation failed, using fallback:`, (e as Error).message);
        }

        // Fallback: split body into chunks
        if (slideData.length === 0) {
          const sentences = extracted.body.split(/[.!?]+/).filter((s) => s.trim().length > 20);
          slideData = sentences.slice(0, 5).map((s, i) => ({
            title: `Point ${i + 1}`,
            body: s.trim().slice(0, 120),
          }));
        }

        // Build slide objects
        const slides: Array<import("@postautomation/ai").CarouselSlide> = [
          { type: "cover", title: extracted.title, body: extracted.description?.slice(0, 100) || undefined },
          ...slideData.map((d) => ({
            type: "content" as const,
            title: d.title,
            body: d.body,
          })),
          { type: "cta", title: "Follow for More", body: `Source: ${extracted.siteName}` },
        ];

        // Render carousel images
        const carouselResult = await generateCarouselImages({
          slides,
          channelName,
          handle,
          logoUrl: input.logoUrl || null,
          accentColor: input.accentColor,
          theme: input.theme,
        });

        // Upload each slide to S3
        const s3 = getS3Client();
        const uploadedUrls: string[] = [];
        for (let i = 0; i < carouselResult.slides.length; i++) {
          const slide = carouselResult.slides[i]!;
          const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.jpg`;
          const buf = Buffer.from(slide.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: "image/jpeg" }));
          uploadedUrls.push(getPublicUrl(key));
        }
        console.log(`[Repurpose] ${uploadedUrls.length} carousel slides uploaded`);

        if (input.format === "reel") {
          // Stitch slides into video
          try {
            const reelResult = await generateReelVideo({
              slideImages: carouselResult.slides.map((s) => ({
                imageBase64: s.imageBase64,
                mimeType: s.mimeType,
              })),
              slideDuration: 3,
              width: 1080,
              height: 1350,
            });

            const videoKey = `repurpose/reel-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
            const videoBuf = Buffer.from(reelResult.videoBase64, "base64");
            await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));
            mediaUrls = [getPublicUrl(videoKey)];
            mediaType = "video/mp4";
            console.log(`[Repurpose] Reel video uploaded: ${mediaUrls[0]}`);
          } catch (e) {
            console.warn(`[Repurpose] Reel generation failed, falling back to carousel:`, (e as Error).message);
            mediaUrls = uploadedUrls;
          }
        } else {
          mediaUrls = uploadedUrls;
        }
      }

      return {
        extracted: {
          title: extracted.title,
          description: extracted.description,
          siteName: extracted.siteName,
          type: extracted.type,
          images: extracted.images,
          url: extracted.url,
        },
        platformContent,
        mediaUrls,
        mediaType,
        format: input.format,
      };
    }),
});
