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
        provider:    z.enum(["openai","anthropic","gemini","grok","deepseek"]).default("gemini"),
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

            // Generate AI background image via Gemini, then composite with Puppeteer
            const { generateStaticNewsCreativeImage } = await import("@postautomation/ai");
            let backgroundImageUrl: string | null = null;
            let aiBgDataUrl: string | undefined;
            try {
              const { generateImage: genGeminiImg } = await import("@postautomation/ai");
              const bgPrompt = `Create a high-quality cinematic background photo for a news post about: "${rephrasedHeadline}". Dramatic, visually striking, suitable as background for text overlay. No text in image. Dark moody tones, editorial photography style.`;
              const bgRes = await genGeminiImg({ prompt: bgPrompt, aspectRatio: "3:4" });
              aiBgDataUrl = `data:${bgRes.mimeType};base64,${bgRes.imageBase64}`;
              console.log(`[NewsGrid] Gemini bg generated for "${rephrasedHeadline.slice(0, 40)}..."`);
            } catch (e) {
              console.warn(`[NewsGrid] Gemini bg failed, using stock fallback:`, (e as Error).message);
            }

            try {
              const imgResult = await generateStaticNewsCreativeImage({
                headline:    rephrasedHeadline,
                channelName: channel.name,
                handle:      channel.username ?? channel.platformId,
                logoUrl:     resolvedLogoUrl,
                template:    creativeSpec.template as any,
                bgSeed:      seed,
                backgroundImageUrl: aiBgDataUrl,
              });
              backgroundImageUrl = `data:${imgResult.mimeType};base64,${imgResult.imageBase64}`;
            } catch {
              // image generation failed — frontend will show fallback
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
            channelId:   z.string(),
            caption:     z.string(),
            hashtags:    z.array(z.string()),
            cta:         z.string(),
            scheduleTime:z.string().nullable(),
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
          payload.hashtags.join(" "),
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

        for (const target of post.targets) {
          const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
          await postPublishQueue.add(
            `newsgrid-${target.id}-${Date.now()}`,
            {
              postId:         post.id,
              postTargetId:   target.id,
              channelId:      target.channelId,
              platform:       target.channel.platform,
              organizationId: ctx.organizationId,
            },
            { delay: delayMs, attempts: 3, backoff: { type: "exponential", delay: 30000 } }
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
