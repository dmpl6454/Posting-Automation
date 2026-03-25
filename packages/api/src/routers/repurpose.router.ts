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
    .mutation(async ({ input }) => {
      const {
        extractUrlContent,
        repurposeContent,
        generateReelVideo,
        generateContent,
        generateSpeech,
        generateVoiceOverScript,
        generateImage: generateGeminiImage,
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
        // Generate a UNIQUE AI-designed creative per platform
        const contentSummary = extracted.body.slice(0, 600) || extracted.description || extracted.title;
        const s3 = getS3Client();

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
        const perPlatformMedia: Record<string, string> = {};
        for (const platform of input.targetPlatforms) {
          const style = platformStyles[platform] || defaultStyle;
          const imagePrompt = `Create a professional social media post image.

Topic: "${extracted.title}"
Context: ${contentSummary.slice(0, 400)}

Design style: ${style}

Requirements:
- Visually stunning, premium quality design
- Include headline text "${extracted.title.slice(0, 60)}" integrated into the design
- Relevant visual imagery that matches the topic
- Professional layout with strong visual hierarchy
- Do NOT include any watermarks or stock photo marks
- 4:5 portrait aspect ratio`;

          try {
            console.log(`[Repurpose] Generating AI creative for ${platform}...`);
            const aiResult = await generateGeminiImage({
              prompt: imagePrompt,
              aspectRatio: "3:4",
            });

            const ext = aiResult.mimeType.includes("png") ? "png" : "jpg";
            const ct = aiResult.mimeType.includes("png") ? "image/png" : "image/jpeg";
            const key = `repurpose/${platform.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
            const buf = Buffer.from(aiResult.imageBase64, "base64");
            await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: ct }));
            const url = getPublicUrl(key);
            perPlatformMedia[platform] = url;
            mediaUrls.push(url);
            mediaType = ct;
            console.log(`[Repurpose] ${platform} creative uploaded: ${url}`);
          } catch (e) {
            console.warn(`[Repurpose] ${platform} AI image failed:`, (e as Error).message);
          }
        }

        // Store per-platform media mapping in response
        (platformContent as any).__mediaMap = perPlatformMedia;
      } else if (input.format === "carousel" || input.format === "reel") {
        // Generate carousel slide content via AI
        const slidePrompt = `Analyze this content and break it into 5-7 key points for a carousel post.

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
          { type: "cta", title: "Follow for More", body: `@${handle}` },
        ];

        console.log(`[Repurpose] Generating ${allSlides.length} AI carousel slides...`);

        // Generate each slide as an AI-designed creative
        const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
        for (let i = 0; i < allSlides.length; i++) {
          const slide = allSlides[i]!;
          try {
            let slideImagePrompt: string;
            if (slide.type === "cover") {
              slideImagePrompt = `Design a bold, eye-catching social media carousel COVER slide (slide 1 of ${allSlides.length}).

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
              slideImagePrompt = `Design a social media carousel CTA (call-to-action) slide (last slide of ${allSlides.length}).

Text: "Follow for More"
Handle: "${handle}"
Channel: "${channelName}"

Requirements:
- Large "Follow for More" text in the center
- Show the handle "${handle}" below
- Clean, minimal design with bold typography
- Matching color scheme for social media
- 4:5 portrait aspect ratio
- Professional, engaging call-to-action design`;
            } else {
              slideImagePrompt = `Design a social media carousel content slide (slide ${i + 1} of ${allSlides.length}).

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

            const slideResult = await generateGeminiImage({
              prompt: slideImagePrompt,
              aspectRatio: "3:4",
            });

            slideImages.push({
              imageBase64: slideResult.imageBase64,
              mimeType: slideResult.mimeType,
            });

            // Upload to S3
            const ext = slideResult.mimeType.includes("png") ? "png" : "jpg";
            const contentType = slideResult.mimeType.includes("png") ? "image/png" : "image/jpeg";
            const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
            const buf = Buffer.from(slideResult.imageBase64, "base64");
            await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
            uploadedUrls.push(getPublicUrl(key));
            console.log(`[Repurpose] Slide ${i + 1}/${allSlides.length} generated`);
          } catch (slideErr) {
            console.warn(`[Repurpose] AI slide ${i + 1} failed:`, (slideErr as Error).message);
          }
        }

        console.log(`[Repurpose] ${uploadedUrls.length} AI carousel slides uploaded`);

        if (input.format === "reel") {
          // Stitch slides into video with optional voice-over + background music
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
            console.log(`[Repurpose] Reel video uploaded: ${mediaUrls[0]}`);
          } catch (e) {
            console.warn(`[Repurpose] Reel generation failed, falling back to carousel:`, (e as Error).message);
            mediaUrls = uploadedUrls;
          }
        } else {
          mediaUrls = uploadedUrls;
        }
      }

      // Extract per-platform media map if available
      const mediaMap = (platformContent as any).__mediaMap as Record<string, string> | undefined;
      if (mediaMap) delete (platformContent as any).__mediaMap;

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
        mediaMap: mediaMap || {},
        mediaType,
        format: input.format,
      };
    }),
});
