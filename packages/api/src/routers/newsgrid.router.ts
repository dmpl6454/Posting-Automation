import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";
import { postPublishQueue } from "@postautomation/queue";

// ── tone → CTA mapping ───────────────────────────────────────────────────────
const TONE_CTA_MAP: Record<string, string[]> = {
  editorial:      ["What do you think?", "Your take?"],
  dramatic:       ["Did you expect this?", "Drop your reaction below"],
  breaking:       ["Fans reacting already", "Breaking — thoughts?"],
  "fan-reaction": ["Your take?", "Fans reacting already"],
  insider:        ["Did you expect this?", "Excited to see more?"],
  minimalist:     ["What do you think?", "Your take?"],
  viral:          ["Drop your reaction below", "Fans reacting already"],
  "question-hook":["What do you think?", "Excited to see more?"],
  timeline:       ["Your take?", "What happens next?"],
  announcement:   ["Excited to see more?", "Drop your reaction below"],
};

const DEFAULT_CTAS = [
  "What do you think?",
  "Fans reacting already",
  "Your take?",
  "Did you expect this?",
  "Excited to see more?",
  "Drop your reaction below",
];

const CREATIVE_TEMPLATES: Record<string, { layout: string; gradient: string; frameStyle: string; overlayIntensity: string }> = {
  luxury_news:       { layout: "center headline editorial",    gradient: "dark gold overlay",         frameStyle: "premium border",       overlayIntensity: "0.6" },
  breaking_news:     { layout: "left-aligned bold headline",   gradient: "red-black breaking alert",  frameStyle: "alert frame ticker",   overlayIntensity: "0.75" },
  cinematic:         { layout: "center headline cinematic",    gradient: "dark cinematic gradient",   frameStyle: "widescreen bars",      overlayIntensity: "0.65" },
  viral_entertainment:{ layout: "dynamic center viral",        gradient: "vibrant color pop",         frameStyle: "emoji accent frame",   overlayIntensity: "0.55" },
  paparazzi_stamp:   { layout: "timestamp strip footer",       gradient: "dark minimal overlay",      frameStyle: "timestamp footer bar", overlayIntensity: "0.5" },
  minimal_dark:      { layout: "minimal dark headline card",   gradient: "pure black overlay",        frameStyle: "clean edge frame",     overlayIntensity: "0.7" },
  quote_typography:  { layout: "quote-centered typography",    gradient: "subtle texture gradient",   frameStyle: "quote marks accent",   overlayIntensity: "0.6" },
  magazine:          { layout: "left editorial magazine",      gradient: "white-black split",         frameStyle: "editorial columns",    overlayIntensity: "0.45" },
};

const LOGO_PLACEMENTS = ["bottom_center","bottom_left","top_left","top_right","footer_strip","timestamp_bar","masthead_style"] as const;
const USERNAME_PLACEMENTS = ["below_logo","footer_center","lower_third","corner_signature","ticker_strip","watermark_line"] as const;

function pickCTA(tone: string, seed: number): string {
  const options = TONE_CTA_MAP[tone] ?? DEFAULT_CTAS;
  return options[seed % options.length]!;
}

function buildCreativeSpec(profile: any, seed: number) {
  const templateType = (profile?.template_type as string) ?? "cinematic";
  const tpl = CREATIVE_TEMPLATES[templateType] ?? CREATIVE_TEMPLATES["cinematic"]!;
  const logoPos = (profile?.logo_position as string) ?? LOGO_PLACEMENTS[seed % LOGO_PLACEMENTS.length]!;
  const usernamePos = (profile?.username_position as string) ?? USERNAME_PLACEMENTS[seed % USERNAME_PLACEMENTS.length]!;
  return {
    template: templateType,
    layout: tpl.layout,
    gradient: tpl.gradient,
    frameStyle: tpl.frameStyle,
    overlayIntensity: tpl.overlayIntensity,
    logoPosition: logoPos,
    usernamePosition: usernamePos,
    brandPalette: (profile?.brand_palette as string) ?? "default",
    fontFamily: (profile?.font_family as string) ?? "sans-serif",
  };
}

function buildHashtags(
  headline: string,
  celebName: string | undefined,
  eventName: string | undefined,
  channelName: string,
  handle: string,
  existingBrandTags: string[],
  seed: number
): string[] {
  const tags: string[] = [];

  // 2 niche tags (derived from headline words)
  const words = headline.replace(/[^a-zA-Z0-9 ]/g, "").split(" ").filter((w) => w.length > 3);
  if (words[seed % words.length]) tags.push(`#${words[seed % words.length]}`);
  if (words[(seed + 1) % words.length]) tags.push(`#${words[(seed + 1) % words.length]}Update`);

  // 3 celebrity/event tags
  if (celebName) tags.push(`#${celebName.replace(/\s+/g, "")}`);
  if (eventName) tags.push(`#${eventName.replace(/\s+/g, "")}`);
  tags.push(`#Bollywood`);

  // 2 trending tags
  const trending = ["#TrendingNow","#BreakingNews","#Celebrity","#Entertainment","#FilmiNews","#BollywoodUpdate","#CelebritySpotting"];
  tags.push(trending[seed % trending.length]!);
  tags.push(trending[(seed + 3) % trending.length]!);

  // 1 brand tag (channel name)
  const brandTag = `#${channelName.replace(/\s+/g, "")}`;
  tags.push(brandTag);

  // extra brand tags from profile
  existingBrandTags.forEach((t) => tags.push(t.startsWith("#") ? t : `#${t}`));

  // dedupe
  return [...new Set(tags)].slice(0, 10);
}

const tonePromptMap: Record<string, string> = {
  editorial:      "Write a polished editorial-style caption for Instagram.",
  dramatic:       "Write a dramatic, high-tension Instagram caption.",
  breaking:       "Write an urgent breaking-news style Instagram caption.",
  "fan-reaction": "Write an Instagram caption focused on fan excitement and reaction.",
  insider:        "Write an insider/exclusive-feel Instagram caption.",
  minimalist:     "Write an ultra-short minimalist Instagram caption (1-2 lines).",
  viral:          "Write a viral, shareable Instagram caption with high engagement potential.",
  "question-hook":"Write an Instagram caption that opens with a provocative question.",
  timeline:       "Write a timeline-style Instagram caption covering what happened.",
  announcement:   "Write an official announcement-style Instagram caption.",
};

export const newsgridRouter = createRouter({
  // ── Generate payloads for all selected channels ──────────────────────────
  generate: orgProcedure
    .input(
      z.object({
        headline:    z.string().min(3),
        summary:     z.string().optional(),
        contentType: z.string().default("celebrity"),
        channelIds:  z.array(z.string()).min(1),
        postFormat:  z.enum(["single","carousel","reel","story"]).default("single"),
        celebName:   z.string().optional(),
        eventName:   z.string().optional(),
        location:    z.string().optional(),
        moodStyle:   z.string().optional(),
        includeHashtags: z.boolean().default(true),
        includeCTA:  z.boolean().default(true),
        language:    z.enum(["EN","HI","MIX"]).default("EN"),
        provider:    z.enum(["openai","anthropic","gemini","grok","deepseek","gemma4"]).default("gemini"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const channels = await ctx.prisma.channel.findMany({
        where: {
          id:             { in: input.channelIds },
          organizationId: ctx.organizationId,
          isActive:       true,
        },
      });

      if (channels.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No active channels found." });
      }

      const { generateContent } = await import("@postautomation/ai");

      // Process channels in parallel batches of 10 to avoid overwhelming the AI
      const BATCH = 10;
      const results: any[] = [];

      for (let i = 0; i < channels.length; i += BATCH) {
        const batch = channels.slice(i, i + BATCH);
        const batchResults = await Promise.all(
          batch.map(async (channel, batchIdx) => {
            const seed = i + batchIdx;
            const profile = (channel.metadata as any) ?? {};
            const tone = (profile.caption_style as string) ?? Object.keys(tonePromptMap)[seed % Object.keys(tonePromptMap).length]!;
            const toneInstruction = tonePromptMap[tone] ?? tonePromptMap["editorial"]!;
            const langNote = input.language === "HI" ? " Write in Hindi (Devanagari)." : input.language === "MIX" ? " Mix Hindi and English (Hinglish)." : "";

            const prompt = [
              toneInstruction + langNote,
              `News headline: "${input.headline}"`,
              input.summary ? `Context: ${input.summary}` : "",
              input.celebName ? `Celebrity: ${input.celebName}` : "",
              input.eventName ? `Event: ${input.eventName}` : "",
              input.location  ? `Location: ${input.location}` : "",
              `Channel: ${channel.name} (${channel.username ?? channel.platformId})`,
              "Keep it under 150 characters. No hashtags in the caption body.",
            ].filter(Boolean).join("\n");

            let caption = input.headline;
            let rephrasedHeadline = input.headline;
            try {
              // Generate caption + rephrased headline in one call
              const headlinePrompt = [
                `You are a social media creative bot for ${channel.name}.`,
                `Given this news headline: "${input.headline}"`,
                `Return ONLY a JSON object (no markdown) with two keys:`,
                `"caption": a ${tone}-style Instagram caption under 150 chars, no hashtags`,
                `"headline": a short rephrased headline for the image card (max 12 words, punchy, ${tone} tone)`,
                input.summary ? `Context: ${input.summary}` : "",
                input.celebName ? `Celebrity: ${input.celebName}` : "",
                input.eventName ? `Event: ${input.eventName}` : "",
                input.language === "HI" ? "Write in Hindi." : input.language === "MIX" ? "Use Hinglish." : "",
              ].filter(Boolean).join("\n");

              const res = await generateContent({
                provider: input.provider as any,
                platform:  "INSTAGRAM" as any,
                userPrompt: headlinePrompt,
                tone:       "casual" as any,
              });

              if (res) {
                try {
                  const jsonMatch = res.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.caption) caption = parsed.caption;
                    if (parsed.headline) rephrasedHeadline = parsed.headline;
                  } else {
                    caption = res;
                  }
                } catch {
                  caption = res;
                }
              }
            } catch {
              // fallback: use headline as caption
            }

            const hashtags = input.includeHashtags
              ? buildHashtags(
                  input.headline,
                  input.celebName,
                  input.eventName,
                  channel.name,
                  channel.username ?? channel.name,
                  (profile.hashtag_style as string[] | undefined) ?? [],
                  seed
                )
              : [];

            const cta = input.includeCTA ? pickCTA(tone, seed) : "";
            const creativeSpec = buildCreativeSpec(profile, seed);

            // Resolve logo: prefer logo library assignment, fallback to profile.logo_path
            let resolvedLogoUrl: string | null = (profile.logo_path as string | undefined) ?? null;
            try {
              const logoMedia = await ctx.prisma.media.findFirst({
                where: { organizationId: ctx.organizationId, category: "logo", channelId: channel.id },
                select: { url: true },
              });
              if (logoMedia) resolvedLogoUrl = logoMedia.url;
            } catch {
              // fallback to profile logo_path
            }

            // Step 0: Extract brand color from logo
            const { generateImage: genGeminiImg, generateStaticNewsCreativeImage, extractDominantColor } = await import("@postautomation/ai");
            let brandColor: string | null = null;
            if (resolvedLogoUrl) {
              try {
                brandColor = await extractDominantColor(resolvedLogoUrl);
                if (brandColor) console.log(`[NewsGrid] Extracted brand color from logo: ${brandColor}`);
              } catch { /* use default template color */ }
            }

            // Step 1: Generate a relevant background image via Gemini AI
            // Step 2: Composite headline text + logo via Puppeteer HTML template
            let backgroundImageUrl: string | null = null;

            // Generate background image with Gemini (no text — just a relevant visual)
            try {
              const bgPrompt = `Create a cinematic, high-quality background image related to this news headline:

"${rephrasedHeadline}"

Requirements:
- Photorealistic or editorial illustration style
- Dramatic lighting, rich colors, and strong visual mood
- DO NOT include any text, words, letters, numbers, or typography
- DO NOT include any logos or branding elements
- The image should work as a background with text overlaid on top
- Use dark/moody tones so white text will be readable over it
- Relevant visual elements that convey the topic of the headline`;

              const bgRes = await genGeminiImg({
                prompt: bgPrompt,
                aspectRatio: "3:4",
              });
              const geminiDataUrl = `data:${bgRes.mimeType};base64,${bgRes.imageBase64}`;
              console.log(`[NewsGrid] Gemini background generated for "${rephrasedHeadline.slice(0, 40)}..."`);

              // Now composite with Puppeteer template (crisp text + logo)
              const imgResult = await generateStaticNewsCreativeImage({
                headline:    rephrasedHeadline,
                channelName: channel.name,
                handle:      channel.username ?? channel.platformId,
                logoUrl:     resolvedLogoUrl,
                template:    creativeSpec.template as any,
                bgSeed:      seed,
                backgroundImageUrl: geminiDataUrl,
                ...(brandColor && { brandColor }),
              });
              backgroundImageUrl = `data:${imgResult.mimeType};base64,${imgResult.imageBase64}`;
              console.log(`[NewsGrid] Composited creative with Gemini bg + Puppeteer text/logo`);
            } catch (e) {
              console.warn(`[NewsGrid] Gemini bg failed, using Puppeteer-only fallback:`, (e as Error).message);
              // Fallback: Puppeteer template with stock background
              try {
                const imgResult = await generateStaticNewsCreativeImage({
                  headline:    rephrasedHeadline,
                  channelName: channel.name,
                  handle:      channel.username ?? channel.platformId,
                  logoUrl:     resolvedLogoUrl,
                  template:    creativeSpec.template as any,
                  bgSeed:      seed,
                  ...(brandColor && { brandColor }),
                });
                backgroundImageUrl = `data:${imgResult.mimeType};base64,${imgResult.imageBase64}`;
              } catch { /* total fallback failure */ }
            }

            return {
              channelId:    channel.id,
              channelName:  channel.name,
              username:     channel.username ?? channel.platformId,
              platform:     channel.platform,
              avatar:       channel.avatar,
              caption,
              hashtags,
              cta,
              creativeSpec,
              onImageText:  rephrasedHeadline,
              logoUsed:     resolvedLogoUrl,
              approved:     false,
              scheduleTime: null as string | null,
              backgroundImageUrl,
            };
          })
        );
        results.push(...batchResults);
      }

      return { results };
    }),

  // ── Update brand profile for a channel ──────────────────────────────────
  updateChannelProfile: orgProcedure
    .input(
      z.object({
        channelId:        z.string(),
        logo_path:        z.string().optional(),
        font_family:      z.string().optional(),
        brand_palette:    z.string().optional(),
        caption_style:    z.string().optional(),
        template_type:    z.string().optional(),
        logo_position:    z.string().optional(),
        username_position:z.string().optional(),
        watermark_mode:   z.boolean().optional(),
        cta_style:        z.string().optional(),
        hashtag_style:    z.array(z.string()).optional(),
        language_style:   z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND" });

      const { channelId, ...profileFields } = input;
      const existing = (channel.metadata as any) ?? {};
      const updated = { ...existing, ...Object.fromEntries(Object.entries(profileFields).filter(([, v]) => v !== undefined)) };

      await ctx.prisma.channel.update({
        where: { id: channelId },
        data:  { metadata: updated },
      });
      return { success: true };
    }),

  // ── Bulk publish approved payloads ────────────────────────────────────────
  bulkPublish: orgProcedure
    .input(
      z.object({
        headline: z.string(),
        payloads: z.array(
          z.object({
            channelId:        z.string(),
            caption:          z.string(),
            hashtags:         z.array(z.string()),
            cta:              z.string(),
            scheduleTime:     z.string().nullable(),
            backgroundImageUrl: z.string().nullable().optional(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const created: string[] = [];

      for (const payload of input.payloads) {
        const fullContent = [
          payload.caption,
          payload.cta,
        ].filter(Boolean).join("\n\n");

        const scheduledAt = payload.scheduleTime ? new Date(payload.scheduleTime) : new Date();

        const post = await ctx.prisma.post.create({
          data: {
            organizationId: ctx.organizationId,
            createdById:    ctx.session.user.id,
            content:        fullContent,
            status:         "SCHEDULED",
            scheduledAt,
            aiGenerated:    true,
            targets: {
              create: {
                channelId: payload.channelId,
                status:    "SCHEDULED",
              },
            },
          },
          include: { targets: { include: { channel: true } } },
        });

        // Attach the preview image (from news grid) so the SAME image gets published
        if (payload.backgroundImageUrl) {
          try {
            let imgBuffer: Buffer;
            let mimeType = "image/jpeg";

            if (payload.backgroundImageUrl.startsWith("data:")) {
              // data:image/jpeg;base64,...
              const match = payload.backgroundImageUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                mimeType = match[1] || "image/jpeg";
                imgBuffer = Buffer.from(match[2]!, "base64");
              } else {
                throw new Error("Invalid data URL format");
              }
            } else {
              // External URL — download it
              const resp = await fetch(payload.backgroundImageUrl);
              const arrayBuf = await resp.arrayBuffer();
              imgBuffer = Buffer.from(arrayBuf);
              mimeType = resp.headers.get("content-type") || "image/jpeg";
            }

            // Upload to S3
            const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
            const s3 = new S3Client({
              region: process.env.S3_REGION || "us-east-1",
              endpoint: process.env.S3_ENDPOINT || undefined,
              forcePathStyle: true,
              credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
                secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
              },
            });
            const bucket = process.env.S3_BUCKET || "postautomation-media";
            const ext = mimeType.includes("png") ? "png" : "jpg";
            const key = `newsgrid/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
            await s3.send(new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: imgBuffer!,
              ContentType: mimeType,
            }));
            const publicUrl = process.env.S3_PUBLIC_URL
              ? `${process.env.S3_PUBLIC_URL}/${key}`
              : `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;

            // Create Media record
            const media = await ctx.prisma.media.create({
              data: {
                organizationId: ctx.organizationId,
                uploadedById:   ctx.session.user.id,
                fileName:       `newsgrid-${Date.now()}.${ext}`,
                fileType:       mimeType,
                fileSize:       imgBuffer!.length,
                url:            publicUrl,
              },
            });

            // Attach to post
            await ctx.prisma.postMedia.create({
              data: {
                postId:  post.id,
                mediaId: media.id,
                order:   0,
              },
            });
            console.log(`[NewsGrid] Image attached to post ${post.id}: ${publicUrl}`);
          } catch (imgErr) {
            console.warn(`[NewsGrid] Failed to attach image to post ${post.id}:`, (imgErr as Error).message);
          }
        }

        for (let ti = 0; ti < post.targets.length; ti++) {
          const target = post.targets[ti]!;
          // Stagger jobs by 10s per channel to avoid platform rate limits
          const staggerMs = (created.length * post.targets.length + ti) * 10_000;
          const delayMs = Math.max(0, scheduledAt.getTime() - Date.now()) + staggerMs;
          await postPublishQueue.add(
            `newsgrid-${target.id}-${Date.now()}`,
            {
              postId:         post.id,
              postTargetId:   target.id,
              channelId:      target.channelId,
              platform:       target.channel.platform,
              organizationId: ctx.organizationId,
            },
            { delay: delayMs, attempts: 3, backoff: { type: "exponential", delay: 60_000 } }
          );
        }

        created.push(post.id);
      }

      return { created, count: created.length };
    }),

  // ── Auto-fill form from headline (called on headline change) ─────────────
  prefillFromHeadline: orgProcedure
    .input(z.object({ headline: z.string().min(3) }))
    .mutation(async ({ input }) => {
      const { generateContent } = await import("@postautomation/ai");

      const prompt = [
        `You are a social media newsroom bot. Given this headline, return ONLY a JSON object (no markdown) with:`,
        `"summary": 1-2 sentence news summary (plain text, under 200 chars)`,
        `"hashtags": array of 8 relevant hashtags (strings with # prefix)`,
        `"cta": one short engagement CTA under 10 words`,
        `Headline: "${input.headline}"`,
      ].join("\n");

      let summary = "";
      let hashtags: string[] = [];
      let cta = "";

      try {
        const res = await generateContent({
          provider: "gemini" as any,
          platform: "INSTAGRAM" as any,
          userPrompt: prompt,
          tone: "casual" as any,
        });

        if (res) {
          const jsonMatch = res.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.summary)  summary  = String(parsed.summary);
            if (Array.isArray(parsed.hashtags)) hashtags = parsed.hashtags.map(String);
            if (parsed.cta)      cta      = String(parsed.cta);
          }
        }
      } catch {
        // silent fallback — form stays empty
      }

      return { summary, hashtags, cta };
    }),

  // ── Logo Library ─────────────────────────────────────────────────────────
  getLogos: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.media.findMany({
      where: { organizationId: ctx.organizationId, category: "logo" },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, url: true, channelId: true, createdAt: true },
    });
  }),

  assignLogoToChannel: orgProcedure
    .input(z.object({ mediaId: z.string(), channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Remove previous logo assignment for this channel
      await ctx.prisma.media.updateMany({
        where: { organizationId: ctx.organizationId, category: "logo", channelId: input.channelId },
        data: { channelId: null },
      });
      // Assign new logo
      await ctx.prisma.media.update({
        where: { id: input.mediaId },
        data: { channelId: input.channelId },
      });
      // Also update channel metadata logo_path
      const media = await ctx.prisma.media.findUnique({ where: { id: input.mediaId } });
      if (media) {
        const channel = await ctx.prisma.channel.findFirst({ where: { id: input.channelId, organizationId: ctx.organizationId } });
        if (channel) {
          const existing = (channel.metadata as any) ?? {};
          await ctx.prisma.channel.update({
            where: { id: input.channelId },
            data: { metadata: { ...existing, logo_path: media.url } },
          });
        }
      }
      return { success: true };
    }),

  deleteLogo: orgProcedure
    .input(z.object({ mediaId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.media.delete({ where: { id: input.mediaId } });
      return { success: true };
    }),

  // ── List channels with their brand profiles ──────────────────────────────
  channelsWithProfiles: orgProcedure.query(async ({ ctx }) => {
    const channels = await ctx.prisma.channel.findMany({
      where:   { organizationId: ctx.organizationId, isActive: true },
      orderBy: { name: "asc" },
      select:  { id: true, name: true, username: true, platform: true, avatar: true, metadata: true },
    });
    return channels;
  }),
});
