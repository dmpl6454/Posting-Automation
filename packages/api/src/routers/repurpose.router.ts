import { z } from "zod";
import { createRouter, protectedProcedure, orgProcedure } from "../trpc";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { pushProgress, finishProgress } from "../lib/progress";

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
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"]).default("openai"),
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
  repurposeFromUrl: orgProcedure
    .input(
      z.object({
        url: z.string().url(),
        progressId: z.string().optional(),
        format: z.enum(["static", "carousel", "reel", "ai_video", "seedance_video"]),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"]).default("gemini"),
        channelName: z.string().optional().default(""),
        channelHandle: z.string().optional().default(""),
        logoUrl: z.string().optional().default(""),
        accentColor: z.string().nullish(),
        theme: z.enum(["dark", "light", "gradient"]).default("dark"),
        voiceOver: z.boolean().default(false),
        voiceType: z.enum(["nova", "shimmer", "alloy", "echo", "fable", "onyx"]).default("nova"),
        bgMusic: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Seedance & AI video are Pro/Enterprise only
      if (input.format === "seedance_video" || input.format === "ai_video") {
        const org = await ctx.prisma.organization.findUniqueOrThrow({
          where: { id: ctx.organizationId },
          select: { plan: true },
        });
        if (org.plan === "FREE" || org.plan === "STARTER") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "AI video generation is available on Professional and Enterprise plans. Please upgrade to access this feature.",
          });
        }
      }

      const {
        extractUrlContent,
        repurposeContent,
        generateReelVideo,
        generateContent,
        generateSpeech,
        generateVoiceOverScript,
        generateImage: generateGeminiImage,
        generateVideo: generateVeo3Video,
        buildVideoPrompt,
        generateSeedanceVideo,
        buildSeedancePrompt,
        overlayLogoOnImage,
      } = await import("@postautomation/ai");

      const userId = (ctx.session.user as any).id as string;
      const organizationId = ctx.organizationId;

      // Resolve logo: prefer input.logoUrl → DB media (category: "logo") → channel avatar
      let resolvedLogoUrl = input.logoUrl || "";
      const channelName = input.channelName || "";
      const channelHandle = input.channelHandle || "";

      if (!resolvedLogoUrl && channelName) {
        try {
          // Try to find a channel matching the name/handle
          const channel = await ctx.prisma.channel.findFirst({
            where: { organizationId, OR: [{ name: channelName }, { username: channelHandle || undefined }] },
            select: { id: true, avatar: true, metadata: true },
          });
          if (channel) {
            // Check for custom logo in media library
            const logoMedia = await ctx.prisma.media.findFirst({
              where: { organizationId, category: "logo", channelId: channel.id },
              orderBy: { createdAt: "desc" },
            });
            if (logoMedia) {
              resolvedLogoUrl = logoMedia.url;
            } else {
              // Fallback to metadata.logo_path → channel avatar
              const meta = channel.metadata as any;
              resolvedLogoUrl = meta?.logo_path || channel.avatar || "";
            }
          }
        } catch {
          // Non-critical — continue without logo
        }
      }

      console.log(`[Repurpose] Logo config: logoUrl="${resolvedLogoUrl?.slice(0, 60) || ""}", channelName="${channelName}", handle="${channelHandle}"`);

      // Helper: apply logo overlay to a generated image
      async function applyLogoOverlay(
        imageBase64: string,
        imgMimeType: string,
        imgWidth = 1080,
        imgHeight = 1350,
      ): Promise<{ imageBase64: string; mimeType: string }> {
        if (!resolvedLogoUrl && !channelName) {
          console.log(`[Repurpose] Skipping logo overlay — no logo or channel name`);
          return { imageBase64, mimeType: imgMimeType };
        }
        try {
          console.log(`[Repurpose] Applying logo overlay (${imgWidth}x${imgHeight})...`);
          return await overlayLogoOnImage({
            imageBase64,
            mimeType: imgMimeType,
            width: imgWidth,
            height: imgHeight,
            logoUrl: resolvedLogoUrl || undefined,
            channelName: channelName || undefined,
            channelHandle: channelHandle || undefined,
            position: "bottom-left",
            accentColor: input.accentColor || "#e11d48",
          });
        } catch (e) {
          console.warn(`[Repurpose] Logo overlay failed, using original:`, (e as Error).message);
          return { imageBase64, mimeType: imgMimeType };
        }
      }

      // Progress tracking — fire-and-forget, never blocks
      const pid = input.progressId;
      const progress = (step: string, status: "running" | "done" | "error" | "skipped" = "running", detail?: string) => {
        if (pid) pushProgress(pid, step, status, detail).catch(() => {});
      };

      // Helper: upload to S3 + create Media record in DB
      async function uploadAndCreateMedia(
        imageBase64: string,
        mimeType: string,
        prefix: string,
      ): Promise<{ url: string; mediaId: string }> {
        const s3 = getS3Client();
        const ext = mimeType.includes("png") ? "png" : mimeType.includes("mp4") ? "mp4" : "jpg";
        const contentType = mimeType.includes("png") ? "image/png" : mimeType.includes("mp4") ? "video/mp4" : "image/jpeg";
        const key = `repurpose/${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
        const buf = Buffer.from(imageBase64, "base64");
        const fileSize = buf.length;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
        const url = getPublicUrl(key);

        // Create Media record so it can be attached to posts
        const media = await ctx.prisma.media.create({
          data: {
            organizationId,
            uploadedById: userId,
            fileName: `${prefix}-${Date.now()}.${ext}`,
            fileType: contentType,
            fileSize,
            url,
          },
        });

        return { url, mediaId: media.id };
      }

      // 1. Extract content from URL
      progress("Extracting content from URL");
      console.log(`[Repurpose] Extracting content from: ${input.url}`);
      const extracted = await extractUrlContent(input.url);
      progress("Extracting content from URL", "done", `"${extracted.title}" (${extracted.body.length} chars)`);
      console.log(`[Repurpose] Extracted: "${extracted.title}" (${extracted.body.length} chars)`);

      // 2. Understand the content — disambiguate people, identify context, create content brief
      progress("Analyzing content with AI");
      const contentBody = extracted.body.slice(0, 5000) || extracted.description || extracted.title;
      let contentBrief = "";
      try {
        const understandPrompt = `You are a content analyst. Analyze this article and provide a clear content brief.

IMPORTANT: Many names are shared by different people. You MUST identify the CORRECT person based on article context.
Examples:
- "Imran Khan" could be the Bollywood actor OR the Pakistani politician/cricketer
- "Chris Brown" could be the singer OR someone else
- "John Smith" could be anyone

Read the FULL article context carefully to determine WHO exactly is being discussed.

Title: ${extracted.title}
Source: ${extracted.siteName} (${extracted.url})
Content: ${contentBody}

Provide a JSON response:
{
  "subject": "Full name and identity of the main person/topic (e.g. 'Imran Khan, Bollywood actor' or 'Imran Khan, former PM of Pakistan')",
  "context": "What is this article about in 2-3 sentences",
  "category": "entertainment/politics/sports/technology/business/health/lifestyle/other",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "tone": "the emotional tone - inspiring/shocking/informative/controversial/celebratory/sad",
  "visualDescription": "What kind of imagery would best represent this article (describe the ideal image scene)"
}

Return ONLY the JSON, no other text.`;

        const briefResponse = await generateContent({
          provider: input.provider,
          platform: "INSTAGRAM",
          userPrompt: understandPrompt,
          tone: "professional",
        });

        const cleaned = briefResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const brief = JSON.parse(jsonMatch[0]);
          contentBrief = `SUBJECT: ${brief.subject || extracted.title}
CONTEXT: ${brief.context || extracted.description}
CATEGORY: ${brief.category || "general"}
TONE: ${brief.tone || "informative"}
VISUAL: ${brief.visualDescription || ""}
KEYWORDS: ${(brief.keywords || []).join(", ")}`;
          console.log(`[Repurpose] Content understood: ${brief.subject} (${brief.category})`);
          progress("Analyzing content with AI", "done", `${brief.subject} — ${brief.category}`);
        }
      } catch (e) {
        console.warn(`[Repurpose] Content understanding failed, using raw content:`, (e as Error).message);
        progress("Analyzing content with AI", "skipped", "Using raw content");
      }

      // Fallback if content understanding failed
      if (!contentBrief) {
        contentBrief = `SUBJECT: ${extracted.title}\nCONTEXT: ${extracted.description || contentBody.slice(0, 300)}`;
      }

      // 3. Generate platform-specific captions WITH content brief for accuracy
      progress("Generating captions for " + input.targetPlatforms.length + " platforms");
      const sourceText = `${contentBrief}\n\n---\n\nTitle: ${extracted.title}\n\n${extracted.body.slice(0, 5000)}`;
      const platformContent = await repurposeContent({
        originalContent: sourceText,
        targetPlatforms: input.targetPlatforms,
        provider: input.provider,
      });
      progress("Generating captions for " + input.targetPlatforms.length + " platforms", "done", Object.keys(platformContent).join(", "));

      // 4. Generate media based on format
      const displayName = channelName || extracted.siteName || "Channel";
      const handle = channelHandle || displayName;
      let mediaUrls: string[] = [];
      let mediaType = "image/jpeg";
      const perPlatformMedia: Record<string, { url: string; mediaId: string }> = {};

      if (input.format === "static") {
        // Generate a UNIQUE AI-designed creative per platform
        const contentSummary = extracted.body.slice(0, 600) || extracted.description || extracted.title;

        const platformStyles: Record<string, string> = {
          INSTAGRAM: "Instagram-style visual storytelling with bold typography, vibrant colors, cinematic imagery, 4:5 portrait, trendy design with gradients and modern aesthetics",
          FACEBOOK: "Facebook news-style creative with professional layout, clean typography, engaging hero image, informative design that drives engagement and shares",
          TWITTER: "Bold, attention-grabbing Twitter/X graphic with impactful headline, high-contrast design, minimal text, punchy visual that stops the scroll",
          LINKEDIN: "Professional LinkedIn post design with corporate aesthetics, clean layout, business-focused imagery, subtle gradients, executive look and feel",
          YOUTUBE: "YouTube thumbnail-style design with dramatic visuals, bold text overlay, high contrast colors, expressive imagery that makes people click",
          TIKTOK: "TikTok-style vibrant creative with Gen-Z aesthetics, bold neon accents, dynamic layout, trendy and eye-catching mobile-first design",
          THREADS: "Minimalist Threads-style design with clean typography, subtle aesthetics, modern and understated elegance, conversation-starting visual",
          PINTEREST: "Pinterest-optimized pin design with beautiful imagery, aspirational aesthetics, elegant typography, lifestyle visual appeal",
          REDDIT: "Informative infographic-style design with data-focused layout, clear hierarchy, educational visual that adds value to discussion",
        };

        const defaultStyle = "Professional social media creative with bold typography, modern design, vibrant colors, and engaging visual hierarchy";

        // Generate one unique image per selected platform
        for (const platform of input.targetPlatforms) {
          const style = platformStyles[platform] || defaultStyle;
          const imagePrompt = `Create a professional social media post image.

${contentBrief}

Topic: "${extracted.title}"
Context: ${contentSummary.slice(0, 400)}

Design style: ${style}

IMPORTANT: Use the SUBJECT and CONTEXT above to understand exactly who/what this is about.
For example, if the subject is "Imran Khan, Bollywood actor" — show imagery related to Bollywood/movies, NOT politics.
If the subject is "Imran Khan, former PM of Pakistan" — show imagery related to politics/cricket, NOT Bollywood.

Requirements:
- Visually stunning, premium quality design
- Include headline text "${extracted.title.slice(0, 60)}" integrated into the design
- Relevant visual imagery that ACCURATELY matches the topic and subject
- Professional layout with strong visual hierarchy
- Do NOT include any watermarks or stock photo marks
- 4:5 portrait aspect ratio`;

          try {
            progress(`Generating image for ${platform}`);
            console.log(`[Repurpose] Generating AI creative for ${platform}...`);
            const aiResult = await generateGeminiImage({
              prompt: imagePrompt,
              aspectRatio: "3:4",
            });

            // Apply logo overlay
            const branded = await applyLogoOverlay(aiResult.imageBase64, aiResult.mimeType, 1080, 1350);

            const { url, mediaId } = await uploadAndCreateMedia(
              branded.imageBase64,
              branded.mimeType,
              platform.toLowerCase(),
            );
            perPlatformMedia[platform] = { url, mediaId };
            mediaUrls.push(url);
            mediaType = aiResult.mimeType.includes("png") ? "image/png" : "image/jpeg";
            progress(`Generating image for ${platform}`, "done", "Uploaded to S3");
            console.log(`[Repurpose] ${platform} creative uploaded: ${url} (mediaId: ${mediaId})`);
          } catch (e) {
            progress(`Generating image for ${platform}`, "error", (e as Error).message);
            console.warn(`[Repurpose] ${platform} AI image failed:`, (e as Error).message);
          }
        }
      } else if (input.format === "ai_video") {
        // ── Veo3 Ultra AI Video Generation ─────────────────────────────
        // 1. Break content into key points for video scenes
        const slidePrompt = `Analyze this content and extract 4-6 key points for a short video.

${contentBrief}

Title: ${extracted.title}
Content: ${extracted.body.slice(0, 4000)}

Return a JSON array of strings — each is a short, punchy point (max 15 words each).
Example: ["AI is transforming marketing", "Content creation is now 10x faster", "Brands see 3x engagement"]

Return ONLY the JSON array, no other text.`;

        let keyPoints: string[] = [];
        progress("Extracting key points for video scenes");
        try {
          const kpResponse = await generateContent({
            provider: input.provider,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          });
          const cleaned = kpResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) keyPoints = JSON.parse(arrMatch[0]);
          progress("Extracting key points for video scenes", "done", `${keyPoints.length} scenes`);
        } catch (e) {
          progress("Extracting key points for video scenes", "error", (e as Error).message);
          console.warn(`[Repurpose] Key point extraction failed:`, (e as Error).message);
        }

        if (keyPoints.length === 0) {
          const sentences = extracted.body.split(/[.!?]+/).filter((s) => s.trim().length > 20);
          keyPoints = sentences.slice(0, 5).map((s) => s.trim().slice(0, 80));
        }

        // 2. Build cinematic video prompt
        const musicMood = input.theme === "dark" ? "dramatic, cinematic, deep bass" :
          input.theme === "gradient" ? "upbeat electronic, modern" : "clean corporate, optimistic";

        const videoPrompt = buildVideoPrompt({
          title: extracted.title.slice(0, 60),
          keyPoints,
          visualStyle: `${input.theme} theme, professional social media video, cinematic B-roll`,
          musicMood,
          brandName: input.channelName || undefined,
        });

        progress("Generating reference image for Veo3");
        console.log(`[Repurpose] Generating Veo3 AI video (${keyPoints.length} scenes)...`);

        // 3. Also generate a reference image for visual style guidance
        let referenceImage: { base64: string; mimeType?: string } | undefined;
        try {
          const refResult = await generateGeminiImage({
            prompt: `Create a cinematic vertical still frame for a social media video about: "${extracted.title}". ${input.theme} theme, dark background, dramatic lighting, bold white text overlay, modern design. 9:16 portrait vertical.`,
            aspectRatio: "9:16",
          });
          referenceImage = { base64: refResult.imageBase64, mimeType: refResult.mimeType };
          progress("Generating reference image for Veo3", "done");
          console.log(`[Repurpose] Reference image generated for Veo3`);
        } catch (e) {
          progress("Generating reference image for Veo3", "skipped", (e as Error).message);
          console.warn(`[Repurpose] Reference image failed (continuing without):`, (e as Error).message);
        }

        // 4. Generate video with Veo3
        progress("Generating AI video with Veo3 Ultra (1-3 min)");
        try {
          const veoResult = await generateVeo3Video({
            prompt: videoPrompt,
            referenceImage,
            durationSeconds: 8,
            aspectRatio: "9:16",
            personGeneration: "allow_adult",
          });

          // 5. Upload video to S3
          const videoKey = `repurpose/veo3-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
          const videoBuf = Buffer.from(veoResult.videoBase64, "base64");
          const s3 = getS3Client();
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));

          const videoUrl = getPublicUrl(videoKey);

          // Create Media record
          await ctx.prisma.media.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: `veo3-video-${Date.now()}.mp4`,
              fileType: "video/mp4",
              fileSize: videoBuf.length,
              url: videoUrl,
              duration: veoResult.durationSeconds,
            },
          });

          mediaUrls = [videoUrl];
          mediaType = "video/mp4";
          progress("Generating AI video with Veo3 Ultra (1-3 min)", "done", `${(videoBuf.length / 1024 / 1024).toFixed(1)}MB uploaded`);
          console.log(`[Repurpose] Veo3 video uploaded: ${videoUrl} (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)`);
        } catch (e) {
          progress("Generating AI video with Veo3 Ultra (1-3 min)", "error", (e as Error).message);
          progress("Falling back to slideshow reel");
          console.error(`[Repurpose] Veo3 generation failed, falling back to slideshow reel:`, (e as Error).message);

          // Fallback: generate slideshow reel from images (same as "reel" format)
          try {
            const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
            for (const point of keyPoints.slice(0, 6)) {
              try {
                const img = await generateGeminiImage({
                  prompt: `Create a professional social media slide. Text: "${point}". ${input.theme} theme, cinematic, bold typography, relevant visual background. 4:5 portrait.`,
                  aspectRatio: "3:4",
                });
                // Apply logo overlay to fallback reel slides
                const branded = await applyLogoOverlay(img.imageBase64, img.mimeType, 1080, 1350);
                slideImages.push({ imageBase64: branded.imageBase64, mimeType: branded.mimeType });
              } catch { /* skip failed slide */ }
              await new Promise((r) => setTimeout(r, 1500)); // rate limit
            }

            if (slideImages.length > 0) {
              let voiceOverBase64: string | undefined;
              if (input.voiceOver) {
                try {
                  const script = generateVoiceOverScript(extracted.title, extracted.body, slideImages.length * 3);
                  const ttsResult = await generateSpeech({ text: script, voice: input.voiceType as any, speed: 1.0, model: "tts-1-hd" });
                  voiceOverBase64 = ttsResult.audioBase64;
                } catch {}
              }

              let bgMusicBase64: string | undefined;
              if (input.bgMusic) {
                try {
                  const { execSync } = await import("node:child_process");
                  const { readFileSync, mkdirSync, rmSync } = await import("node:fs");
                  const { join } = await import("node:path");
                  const { tmpdir } = await import("node:os");
                  const musicDir = join(tmpdir(), `bgmusic-${Date.now()}`);
                  mkdirSync(musicDir, { recursive: true });
                  const musicPath = join(musicDir, "bg.mp3");
                  const duration = slideImages.length * 3 + 2;
                  execSync(`ffmpeg -y -f lavfi -i "sine=frequency=110:duration=${duration}" -f lavfi -i "sine=frequency=165:duration=${duration}" -filter_complex "[0:a][1:a]amix=inputs=2,volume=0.3,afade=t=in:d=1,afade=t=out:st=${duration - 1}:d=1[out]" -map "[out]" -c:a libmp3lame -b:a 128k "${musicPath}"`, { timeout: 30_000, stdio: "pipe" });
                  bgMusicBase64 = readFileSync(musicPath).toString("base64");
                  rmSync(musicDir, { recursive: true, force: true });
                } catch {}
              }

              const reelResult = await generateReelVideo({
                slideImages,
                slideDuration: 3,
                width: 1080,
                height: 1350,
                voiceOverBase64,
                bgMusicBase64,
              });

              const s3 = getS3Client();
              const videoKey = `repurpose/veo3-fallback-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
              const videoBuf = Buffer.from(reelResult.videoBase64, "base64");
              await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));
              mediaUrls = [getPublicUrl(videoKey)];
              mediaType = "video/mp4";
              console.log(`[Repurpose] Fallback slideshow reel uploaded: ${mediaUrls[0]}`);
            }
          } catch (fallbackErr) {
            console.error(`[Repurpose] Fallback reel also failed:`, (fallbackErr as Error).message);
          }
        }
      } else if (input.format === "seedance_video") {
        // ── Seedance 2.0 AI Video Generation ─────────────────────────────
        progress("Extracting key points for video scenes");
        const slidePrompt = `Analyze this content and extract 4-6 key points for a short video.

${contentBrief}

Title: ${extracted.title}
Content: ${extracted.body.slice(0, 4000)}

Return a JSON array of strings — each is a short, punchy point (max 15 words each).
Return ONLY the JSON array, no other text.`;

        let keyPoints: string[] = [];
        try {
          const kpResponse = await generateContent({
            provider: input.provider,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          });
          const cleaned = kpResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) keyPoints = JSON.parse(arrMatch[0]);
          progress("Extracting key points for video scenes", "done", `${keyPoints.length} scenes`);
        } catch (e) {
          progress("Extracting key points for video scenes", "error", (e as Error).message);
        }

        if (keyPoints.length === 0) {
          const sentences = extracted.body.split(/[.!?]+/).filter((s) => s.trim().length > 20);
          keyPoints = sentences.slice(0, 5).map((s) => s.trim().slice(0, 80));
        }

        const musicMood = input.theme === "dark" ? "dramatic cinematic, deep bass, orchestral"
          : input.theme === "gradient" ? "upbeat electronic, modern synth" : "clean corporate, optimistic";

        const videoPrompt = buildSeedancePrompt({
          title: extracted.title.slice(0, 60),
          keyPoints,
          visualStyle: `${input.theme} theme, professional social media video, cinematic B-roll`,
          musicMood,
          brandName: input.channelName || undefined,
        });

        progress("Generating AI video with Seedance 2.0 (30s-3min)");
        console.log(`[Repurpose] Generating Seedance 2.0 video (${keyPoints.length} scenes)...`);

        try {
          const seedResult = await generateSeedanceVideo({
            prompt: videoPrompt,
            duration: 8,
            aspectRatio: "9:16",
            enableAudio: true,
          });

          const s3 = getS3Client();
          const videoKey = `repurpose/seedance-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
          const videoBuf = Buffer.from(seedResult.videoBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));

          const videoUrl = getPublicUrl(videoKey);

          await ctx.prisma.media.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: `seedance-video-${Date.now()}.mp4`,
              fileType: "video/mp4",
              fileSize: videoBuf.length,
              url: videoUrl,
              duration: seedResult.durationSeconds,
            },
          });

          mediaUrls = [videoUrl];
          mediaType = "video/mp4";
          progress("Generating AI video with Seedance 2.0 (30s-3min)", "done", `${(videoBuf.length / 1024 / 1024).toFixed(1)}MB uploaded`);
          console.log(`[Repurpose] Seedance video uploaded: ${videoUrl} (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)`);
        } catch (e) {
          progress("Generating AI video with Seedance 2.0 (30s-3min)", "error", (e as Error).message);
          console.error(`[Repurpose] Seedance generation failed:`, (e as Error).message);
          // No fallback — Seedance failure is final for this format
        }

      } else if (input.format === "carousel" || input.format === "reel") {
        // Generate carousel slide content via AI
        const slidePrompt = `Analyze this content and break it into 5-7 key points for a carousel post.

${contentBrief}

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

        // Generate AI-designed carousel slides using Gemini
        const s3 = getS3Client();
        const uploadedUrls: string[] = [];

        // Build all slide texts: cover + content + CTA
        const allSlides = [
          { type: "cover", title: extracted.title, body: extracted.description?.slice(0, 100) || "" },
          ...slideData.map((d, i) => ({ type: "content", title: d.title, body: d.body })),
          { type: "cta", title: "Follow for More", body: "" },
        ];

        progress(`Generating ${allSlides.length} carousel slides`);
        console.log(`[Repurpose] Generating ${allSlides.length} AI carousel slides...`);

        // Build prompts for all slides
        const slidePrompts: string[] = allSlides.map((slide, i) => {
          if (slide.type === "cover") {
            return `Design a bold, eye-catching social media carousel COVER slide (slide 1 of ${allSlides.length}).

${contentBrief}

Topic: "${slide.title}"
${slide.body ? `Subtitle: "${slide.body}"` : ""}

Requirements:
- Include the title text "${slide.title.slice(0, 60)}" prominently in the design
- Bold, modern typography with large readable text
- Dramatic visual background related to the topic
- Professional social media design with gradients and visual hierarchy
- 4:5 portrait aspect ratio
- Make it look like a premium Instagram carousel cover
- Use vibrant, attention-grabbing colors`;
          } else if (slide.type === "cta") {
            return `Design a social media carousel CTA (call-to-action) slide (last slide of ${allSlides.length}).

Text: "Follow for More"

Requirements:
- Large "Follow for More" text in the center
- Clean, minimal design with bold typography
- Matching color scheme for social media
- 4:5 portrait aspect ratio
- Professional, engaging call-to-action design`;
          } else {
            return `Design a social media carousel content slide (slide ${i + 1} of ${allSlides.length}).

Heading: "${slide.title}"
Content: "${slide.body}"

Requirements:
- Include the heading "${slide.title}" and content text in the design
- Clean, readable typography with visual hierarchy
- Subtle visual elements or icons related to the topic
- Consistent social media carousel design style
- 4:5 portrait aspect ratio
- Professional layout with good spacing
- Use complementary colors`;
          }
        });

        // Generate slides in batches of 3 with retry + delay to avoid Gemini rate limits
        const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
        const BATCH_SIZE = 3;
        const DELAY_BETWEEN_BATCHES = 3000; // 3s between batches

        for (let batchStart = 0; batchStart < slidePrompts.length; batchStart += BATCH_SIZE) {
          if (batchStart > 0) {
            await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES));
          }

          const batchEnd = Math.min(batchStart + BATCH_SIZE, slidePrompts.length);
          const batchPromises = slidePrompts.slice(batchStart, batchEnd).map(async (prompt, batchIdx) => {
            const slideIdx = batchStart + batchIdx;
            // Retry up to 2 times per slide
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                if (attempt > 0) {
                  await new Promise((r) => setTimeout(r, 2000 * attempt)); // backoff
                  console.log(`[Repurpose] Retrying slide ${slideIdx + 1} (attempt ${attempt + 1})`);
                }
                const slideResult = await generateGeminiImage({
                  prompt,
                  aspectRatio: "3:4",
                });
                // Apply logo overlay to each carousel slide
                const branded = await applyLogoOverlay(slideResult.imageBase64, slideResult.mimeType, 1080, 1350);
                return { slideIdx, imageBase64: branded.imageBase64, mimeType: branded.mimeType };
              } catch (e) {
                if (attempt === 2) {
                  console.warn(`[Repurpose] Slide ${slideIdx + 1} failed after 3 attempts:`, (e as Error).message);
                  return null;
                }
              }
            }
            return null;
          });

          const batchResults = await Promise.all(batchPromises);
          for (const result of batchResults) {
            if (result) {
              slideImages[result.slideIdx] = { imageBase64: result.imageBase64, mimeType: result.mimeType };
            }
          }
          const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
          const batchOk = batchResults.filter(Boolean).length;
          progress(`Generating ${allSlides.length} carousel slides`, "running", `Batch ${batchNum} done — ${batchOk}/${batchEnd - batchStart} slides`);
          console.log(`[Repurpose] Batch ${batchNum} done (${batchOk}/${batchEnd - batchStart} slides)`);
        }

        // Upload all successfully generated slides to S3
        for (let i = 0; i < slideImages.length; i++) {
          const slide = slideImages[i];
          if (!slide) continue;
          const ext = slide.mimeType.includes("png") ? "png" : "jpg";
          const contentType = slide.mimeType.includes("png") ? "image/png" : "image/jpeg";
          const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
          const buf = Buffer.from(slide.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
          uploadedUrls.push(getPublicUrl(key));
        }

        progress(`Generating ${allSlides.length} carousel slides`, "done", `${uploadedUrls.length} uploaded`);
        console.log(`[Repurpose] ${uploadedUrls.length}/${allSlides.length} carousel slides uploaded`);

        if (input.format === "reel") {
          // Stitch slides into video with optional voice-over + background music
          progress("Stitching reel video from slides");
          try {
            // Generate voice-over if requested
            let voiceOverBase64: string | undefined;
            if (input.voiceOver) {
              try {
                const totalSlidesDuration = slideImages.length * 3;
                const script = generateVoiceOverScript(extracted.title, extracted.body, totalSlidesDuration);
                console.log(`[Repurpose] Generating voice-over (${script.split(/\s+/).length} words, voice: ${input.voiceType})`);
                const ttsResult = await generateSpeech({
                  text: script,
                  voice: input.voiceType as any,
                  speed: 1.0,
                  model: "tts-1-hd",
                });
                voiceOverBase64 = ttsResult.audioBase64;
                console.log(`[Repurpose] Voice-over generated (~${Math.round(ttsResult.durationEstimate)}s)`);
              } catch (ttsErr) {
                console.warn(`[Repurpose] Voice-over generation failed:`, (ttsErr as Error).message);
              }
            }

            // Fetch background music if requested
            let bgMusicBase64: string | undefined;
            if (input.bgMusic) {
              try {
                // Use a bundled news-style background music (royalty-free)
                // Generate a subtle ambient tone using FFmpeg if no music file available
                const { execSync } = await import("node:child_process");
                const { readFileSync, mkdirSync } = await import("node:fs");
                const { join } = await import("node:path");
                const { tmpdir } = await import("node:os");
                const musicDir = join(tmpdir(), `bgmusic-${Date.now()}`);
                mkdirSync(musicDir, { recursive: true });
                const musicPath = join(musicDir, "bg.mp3");
                // Generate a subtle ambient news-style tone (low drone + soft pad)
                const duration = slideImages.length * 3 + 2;
                execSync(
                  `ffmpeg -y -f lavfi -i "sine=frequency=110:duration=${duration}" -f lavfi -i "sine=frequency=165:duration=${duration}" -filter_complex "[0:a][1:a]amix=inputs=2,volume=0.3,afade=t=in:d=1,afade=t=out:st=${duration - 1}:d=1[out]" -map "[out]" -c:a libmp3lame -b:a 128k "${musicPath}"`,
                  { timeout: 30_000, stdio: "pipe" }
                );
                bgMusicBase64 = readFileSync(musicPath).toString("base64");
                const { rmSync } = await import("node:fs");
                rmSync(musicDir, { recursive: true, force: true });
                console.log(`[Repurpose] Background music generated (${duration}s)`);
              } catch (musicErr) {
                console.warn(`[Repurpose] Background music generation failed:`, (musicErr as Error).message);
              }
            }

            const reelResult = await generateReelVideo({
              slideImages: slideImages.map((s) => ({
                imageBase64: s.imageBase64,
                mimeType: s.mimeType,
              })),
              slideDuration: 3,
              width: 1080,
              height: 1350,
              voiceOverBase64,
              bgMusicBase64,
              bgMusicVolume: 0.15,
              voiceVolume: 0.9,
            });

            const videoKey = `repurpose/reel-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
            const videoBuf = Buffer.from(reelResult.videoBase64, "base64");
            await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));
            mediaUrls = [getPublicUrl(videoKey)];
            mediaType = "video/mp4";
            progress("Stitching reel video from slides", "done", "Video uploaded");
            console.log(`[Repurpose] Reel video uploaded: ${mediaUrls[0]}`);
          } catch (e) {
            progress("Stitching reel video from slides", "error", (e as Error).message);
            console.warn(`[Repurpose] Reel generation failed, falling back to carousel:`, (e as Error).message);
            mediaUrls = uploadedUrls;
          }
        } else {
          mediaUrls = uploadedUrls;
        }
      }

      if (pid) finishProgress(pid, "done", `${Object.keys(platformContent).length} captions, ${mediaUrls.length} media`).catch(() => {});

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
        mediaMap: perPlatformMedia,
        mediaType,
        format: input.format,
      };
    }),
});
