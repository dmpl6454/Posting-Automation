import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, orgProcedure } from "../trpc";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { pushProgress, finishProgress, scopedProgressId } from "../lib/progress";
import { toFriendlyAIError, isMissingAIKeyError, friendlyAIMessage } from "../lib/ai-errors";
import { requirePlan } from "../middleware/plan-limit.middleware";

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

/**
 * Drop failed (undefined/null) slides from a sparse slide-image array before
 * passing them to the reel stitcher. `slideImages` is indexed by slide position,
 * so a slide whose generation failed leaves a hole — mapping over it directly
 * would crash on `undefined.imageBase64`. Pure + exported for unit testing.
 */
export function compactSlides<T>(slideImages: (T | undefined | null)[]): T[] {
  return slideImages.filter((s): s is T => Boolean(s));
}

/**
 * Whether a creative style needs a (slow) AI-generated photo background.
 *
 * `hook_bars` and `bold_typographic` are TEXT-FIRST styles that render entirely
 * from theme tokens + brand color + typography (Task 1 gave them solid/gradient
 * fallbacks), so we SKIP the `generateImageSafe` call for them — a big latency
 * win. `premium_editorial` and `tweet_card` keep the AI photo background. Any
 * unknown/future style defaults to `true` (safe: render with a background).
 * Pure + exported for unit testing.
 */
export function styleNeedsAiBackground(style: string): boolean {
  return style !== "hook_bars" && style !== "bold_typographic";
}

/**
 * Cap a punchy hook line to ≤7 words and ≤60 visible characters WHILE
 * preserving any `**...**` emphasis markup. A naive substring/word cut could
 * split a `**word**` pair and leave a dangling `**`; this drops any trailing
 * unbalanced marker cleanly so the downstream `renderHighlightMarkup` never
 * sees a half-open span. Pure + exported for unit testing.
 */
export function capHookLine(raw: string): string {
  let out = raw.trim().split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
  if (out.length > 60) {
    out = out.slice(0, 60).replace(/\s+\S*$/, "").trim();
  }
  // Drop a dangling (odd) `**` marker so highlight spans stay balanced.
  const markers = out.match(/\*\*/g) || [];
  if (markers.length % 2 === 1) {
    const lastIdx = out.lastIndexOf("**");
    out = (out.slice(0, lastIdx) + out.slice(lastIdx + 2)).trim();
  }
  return out.trim();
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
      try {
        const { repurposeContent } = await import("@postautomation/ai");
        const result = await repurposeContent({
          originalContent: input.originalContent,
          targetPlatforms: input.targetPlatforms,
          provider: input.provider,
        });
        return { platformContent: result };
      } catch (e) {
        // ADD-5: friendly "AI Provider Not Configured" instead of raw 500.
        throw toFriendlyAIError(e);
      }
    }),

  /** Extract content from a URL */
  extractUrl: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input }) => {
      try {
        const { extractUrlContent } = await import("@postautomation/ai");
        const content = await extractUrlContent(input.url);
        return content;
      } catch (e) {
        throw toFriendlyAIError(e);
      }
    }),

  /** Repurpose from URL — generates caption + media (static/carousel/reel) */
  repurposeFromUrl: orgProcedure
    .input(
      z.object({
        url: z.string().url(),
        progressId: z.string().optional(),
        format: z.enum(["static", "carousel", "reel", "ai_video", "seedance_video"]),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        // Default to OpenAI for TEXT generation: the Google-family providers
        // (gemini/gemma4) share the project that is currently on a billing
        // hold (403 "Lightning dunning"), which would kill caption generation
        // before any media work. OpenAI is the verified-working default.
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"]).default("openai"),
        channelName: z.string().optional().default(""),
        channelHandle: z.string().optional().default(""),
        logoUrl: z.string().optional().default(""),
        creativeStyle: z
          .enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"])
          .default("premium_editorial"),
        logoPosition: z.enum(["top-left", "top-right"]).default("top-right"),
        accentColor: z.string().nullish(),
        theme: z.enum(["dark", "light", "gradient"]).default("light"),
        voiceOver: z.boolean().default(false),
        voiceType: z.enum(["nova", "shimmer", "alloy", "echo", "fable", "onyx"]).default("nova"),
        bgMusic: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Seedance & AI video are Pro/Enterprise only. Use the shared plan helper
      // so superadmins (ctx.isSuperAdmin) bypass the gate — matching every
      // other plan gate in the codebase. The previous hand-rolled
      // `org.plan === "FREE"||"STARTER"` check was the SOLE gate that ignored
      // isSuperAdmin, which wrongly blocked tabish@dashmani.com (a superadmin
      // whose personal org is on FREE) from AI video.
      if (input.format === "seedance_video" || input.format === "ai_video") {
        await requirePlan(
          ctx.organizationId,
          "PROFESSIONAL",
          "AI video generation",
          ctx.isSuperAdmin,
        );
      }

      const {
        extractUrlContent,
        repurposeContent,
        generateReelVideo,
        generateContent,
        generateSpeech,
        generateVoiceOverScript,
        generateImage: generateGeminiImage,
        generateImageSafe,
        enforceNoHashtags,
        generateVideo: generateVeo3Video,
        buildVideoPrompt,
        generateSeedanceVideo,
        buildSeedancePrompt,
        overlayLogoOnImage,
        generateStyledCreativeImage,
        launchCreativeBrowser,
        extractDominantColor,
        isPublicImageUrl,
      } = await import("@postautomation/ai");

      const userId = (ctx.session.user as any).id as string;
      const organizationId = ctx.organizationId;

      // Text-provider resilience: caption/brief generation is a hard
      // requirement for the whole flow. If the chosen provider fails (e.g. the
      // Google-family gemini/gemma4 providers share a billing-held project →
      // 403), retry once with OpenAI before giving up. Mirrors the image
      // fallback philosophy so a single provider outage never kills repurpose.
      async function repurposeContentResilient(
        args: Parameters<typeof repurposeContent>[0],
      ): Promise<Awaited<ReturnType<typeof repurposeContent>>> {
        try {
          return await repurposeContent(args);
        } catch (e) {
          if (args.provider === "openai") throw e; // already on the fallback
          console.warn(`[Repurpose] Caption gen via ${args.provider} failed (${(e as Error).message.slice(0, 80)}), retrying with OpenAI`);
          return await repurposeContent({ ...args, provider: "openai" });
        }
      }
      async function generateContentResilient(
        args: Parameters<typeof generateContent>[0],
      ): Promise<string> {
        try {
          return await generateContent(args);
        } catch (e) {
          if (args.provider === "openai") throw e;
          console.warn(`[Repurpose] generateContent via ${args.provider} failed (${(e as Error).message.slice(0, 80)}), retrying with OpenAI`);
          return await generateContent({ ...args, provider: "openai" });
        }
      }

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

      // SSRF chokepoint: `resolvedLogoUrl` is user-influenced (input.logoUrl /
      // template logoMedia.url / channel avatar) and is fetched + rendered
      // server-side downstream (reference fetch, extractDominantColor,
      // buildHeadlineCreative, applyLogoOverlay → overlayLogoOnImage). Validate
      // ONCE here so every downstream use is safe. Logos may live on external
      // public CDNs, so the looser `isPublicImageUrl` (public hosts allowed,
      // private/loopback/metadata/internal blocked) is used — NOT the strict S3
      // allowlist (which would silently drop legit external logos). A blocked
      // URL degrades gracefully to the no-logo path.
      if (resolvedLogoUrl && !isPublicImageUrl(resolvedLogoUrl)) {
        console.warn("[repurpose] logo URL blocked (private/internal host) — dropping logo");
        resolvedLogoUrl = "";
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

      // Resolve a brand accent color from the logo once (reused by every
      // headline creative). Falls back to the template default on failure.
      let resolvedBrandColor: string | null = input.accentColor || null;
      if (!resolvedBrandColor && resolvedLogoUrl) {
        try {
          resolvedBrandColor = await extractDominantColor(resolvedLogoUrl);
          if (resolvedBrandColor) console.log(`[Repurpose] Brand color from logo: ${resolvedBrandColor}`);
        } catch {
          /* use template default */
        }
      }

      // Fetch the brand logo once as a reference image so Gemini can style the
      // AI background to match the brand (B4). Gemini-only — the OpenAI fallback
      // ignores it; the logo is baked deterministically by the template either
      // way. A fetch failure degrades silently to no-reference.
      // NOTE: `resolvedLogoUrl` was validated at the SSRF chokepoint above
      // (`isPublicImageUrl`) and cleared if it pointed at a private/internal
      // host, so it is safe to fetch here when truthy. A fetch failure degrades
      // silently to the no-reference path.
      const brandReferenceImages: Array<{ base64: string; mimeType?: string }> = [];
      if (resolvedLogoUrl) {
        try {
          const r = await fetch(resolvedLogoUrl);
          if (r.ok) {
            const mime = r.headers.get("content-type") || "image/png";
            const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
            if (b64.length > 0) brandReferenceImages.push({ base64: b64, mimeType: mime });
          }
        } catch (e) {
          console.warn(`[Repurpose] Logo reference fetch failed (continuing without):`, (e as Error).message);
        }
      }

      /**
       * Build a branded "static news creative": deterministic headline text +
       * logo/handle baked onto the image via the Puppeteer news-card template
       * (matches the company's static-post format). The AI image is used only
       * as the background photo. If AI background generation fails (e.g. the
       * Google billing hold), the template still renders with a stock
       * background — so a branded creative is ALWAYS produced, never nothing.
       */
      async function buildHeadlineCreative(
        bgPrompt: string,
        headline: string,
        category: string,
        hookLine?: string,
        // Carousel extras (C4): all slides render through this branded template so
        // the whole set is one consistent visual. `slideRole`/`body` select the
        // layout; `browser` lets the carousel reuse ONE Puppeteer instance across
        // every slide instead of cold-booting Chrome per slide.
        extra?: {
          slideRole?: "cover" | "body" | "cta";
          body?: string;
          // Pass-through shared browser. Typed off launchCreativeBrowser's return
          // so the api package never names "puppeteer" directly (it isn't a dep).
          browser?: Awaited<ReturnType<typeof launchCreativeBrowser>>;
        },
      ): Promise<{ imageBase64: string; mimeType: string; bgSource: "ai" | "stock" }> {
        // Try to generate a relevant AI background (no text — the template
        // bakes the headline). generateImageSafe now has a working OpenAI
        // fallback, so this succeeds even while Gemini billing is on hold.
        let backgroundImageUrl: string | undefined;
        let bgSource: "ai" | "stock" = "stock";
        // Brand-style conditioning: pass the channel logo as a reference image so
        // Gemini (Nano Banana) styles the AI BACKGROUND to match the brand. This
        // is Gemini-only — the OpenAI fallback ignores references (it has no
        // image-input path), and the logo itself is always baked deterministically
        // by the template regardless. A fetch failure just degrades to no-reference.
        const referenceImages = brandReferenceImages;
        // Text-first styles (hook_bars / bold_typographic) render entirely from
        // theme + brand color + typography — skip the slow AI background entirely
        // (a big latency win) and pass NO bgImageUrl. premium_editorial and
        // tweet_card keep the AI photo background. CTA slides are a centered
        // call-to-action on the brand background — never an AI photo.
        if (extra?.slideRole !== "cta" && styleNeedsAiBackground(input.creativeStyle)) {
          // Theme-aware lighting descriptor for the background photo. The old
          // unconditional "Dark/moody … white text stays readable" suffix is now
          // conditioned on the theme so a light/gradient creative gets a matching
          // bright/vibrant background.
          const themeBgDescriptor =
            input.theme === "light"
              ? "bright, airy, well-lit, clean"
              : input.theme === "gradient"
                ? "vibrant, colorful, dramatic lighting"
                : "dark, moody, dramatic";
          try {
            const bg = await generateImageSafe({
              prompt: `${bgPrompt}\n\nIMPORTANT: produce a clean BACKGROUND photo only — NO text, words, letters, numbers, logos, or watermarks. ${themeBgDescriptor} tones.`,
              aspectRatio: "3:4",
              title: headline,
              topic: category || "news",
              ...(referenceImages.length ? { referenceImages } : {}),
            });
            backgroundImageUrl = `data:${bg.mimeType};base64,${bg.imageBase64}`;
            bgSource = "ai";
          } catch (e) {
            console.warn(`[Repurpose] AI background failed, using stock template bg:`, (e as Error).message);
          }
        }
        const creative = await generateStyledCreativeImage({
          style: input.creativeStyle,
          headline,
          channelName: displayName,
          handle,
          logoUrl: resolvedLogoUrl || null,
          logoPosition: input.logoPosition,
          theme: input.theme,
          ...(extra?.slideRole ? { slideRole: extra.slideRole } : {}),
          ...(extra?.body !== undefined ? { body: extra.body } : {}),
          ...(extra?.browser ? { browser: extra.browser } : {}),
          ...(hookLine ? { hookLine } : {}),
          ...(backgroundImageUrl ? { bgImageUrl: backgroundImageUrl } : {}),
          ...(resolvedBrandColor ? { brandColor: resolvedBrandColor } : {}),
        });
        return { imageBase64: creative.imageBase64, mimeType: creative.mimeType, bgSource };
      }

      // Progress tracking — fire-and-forget, never blocks.
      // Scope the client-supplied id by the authenticated userId so the Redis
      // keys/channels are per-user (closes a cross-tenant IDOR — the reader in
      // apps/web/app/api/progress/route.ts scopes by session.user.id identically).
      const pid = input.progressId ? scopedProgressId(userId, input.progressId) : undefined;
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
      let extracted;
      try {
        extracted = await extractUrlContent(input.url);
      } catch (e) {
        // Surface a clear, actionable error for the two failure modes here:
        // a missing AI key (→ friendly "not configured") or an unreachable /
        // unparseable URL — instead of a raw 500 (ADD-5 / repurpose e2e).
        if (isMissingAIKeyError(e)) throw toFriendlyAIError(e);
        progress("Extracting content from URL", "error", (e as Error).message);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Couldn't read that URL. Make sure it's a public, reachable page. (${(e as Error).message})`,
        });
      }
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

        const briefResponse = await generateContentResilient({
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
      let platformContent: Awaited<ReturnType<typeof repurposeContent>>;
      try {
        platformContent = await repurposeContentResilient({
          originalContent: sourceText,
          targetPlatforms: input.targetPlatforms,
          provider: input.provider,
        });
      } catch (e) {
        // Core caption generation is required for the whole flow — if the AI
        // provider isn't configured (even after the OpenAI fallback), fail
        // with the friendly message rather than a raw 500 (ADD-5).
        progress("Generating captions", "error", friendlyAIMessage(e));
        throw toFriendlyAIError(e);
      }
      progress("Generating captions for " + input.targetPlatforms.length + " platforms", "done", Object.keys(platformContent).join(", "));

      // 4. Generate media based on format
      const displayName = channelName || extracted.siteName || "Channel";
      const handle = channelHandle || displayName;

      // Cap headlines so the template's word-count font sizing stays readable
      // (≥16 words renders at 40px). Applies to all formats.
      const capHeadline = (text: string): string => {
        const words = text.trim().split(/\s+/);
        let out = words.slice(0, 12).join(" ");
        if (out.length > 80) out = out.slice(0, 80).replace(/\s+\S*$/, "");
        return out.trim();
      };

      let mediaUrls: string[] = [];
      let mediaType = "image/jpeg";
      const perPlatformMedia: Record<string, { url: string; mediaId: string }> = {};
      // Ordered slide media IDs for carousel posts (post.create needs real
      // Media rows, not raw S3 urls). Empty for non-carousel formats.
      const carouselMediaIds: string[] = [];

      if (input.format === "static") {
        // Build ONE branded headline creative (deterministic headline + logo/
        // handle baked on via the news-card template — the company's static
        // format) and reuse it for every selected platform. The format is
        // identical per platform; only the caption text differs, so a single
        // 1080×1350 render is correct and avoids N redundant Puppeteer passes.
        const contentSummary = extracted.body.slice(0, 600) || extracted.description || extracted.title;
        const category = /CATEGORY:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || extracted.type || "news";

        // Headline for the baked overlay: prefer the AI-derived SUBJECT over a
        // generic site/listing <title>. Feeding a homepage/section URL (e.g.
        // indianexpress.com) yields a useless page title like "Latest News
        // Today, Breaking News ... | The Indian Express"; the content brief's
        // SUBJECT (e.g. "India's GDP and Economic Growth") is far better. Use
        // the title only when it looks like a real, specific headline.
        const briefSubject = /SUBJECT:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || "";
        const looksGenericTitle =
          /\|\s*\w|breaking news|top headlines|latest news|home\s*[-|]|homepage/i.test(extracted.title) ||
          extracted.title.length > 90;
        const headlineForCreative =
          looksGenericTitle && briefSubject && briefSubject.length > 3
            ? briefSubject.replace(/\s*[-–—,]\s*(bollywood actor|politician|.*)$/i, "").trim() || briefSubject
            : extracted.title;
        if (headlineForCreative !== extracted.title) {
          console.log(`[Repurpose] Using AI subject as headline ("${headlineForCreative}") instead of generic title ("${extracted.title.slice(0, 50)}...")`);
        }

        let headlineForCreativeFinal = headlineForCreative;
        if (extracted.type === "social") {
          // Social captions are not article titles — synthesize a concise headline
          // from the caption/body rather than dumping the raw caption (which may be
          // a long emoji-laden sentence) into the headline slot.
          try {
            const synth = await generateContentResilient({
              provider: input.provider,
              platform: "INSTAGRAM",
              userPrompt: `Write ONE concise, punchy news-style headline (max 10 words, no hashtags, no emojis) summarizing this social post. Return ONLY the headline text.\n\nPost: ${(extracted.body || extracted.description || extracted.title).slice(0, 800)}`,
              tone: "professional",
            });
            const cleaned = synth.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
            if (cleaned.length > 3) headlineForCreativeFinal = cleaned;
          } catch (e) {
            console.warn(`[Repurpose] Social headline synthesis failed, using extracted title:`, (e as Error).message);
          }
        }
        headlineForCreativeFinal = capHeadline(headlineForCreativeFinal);

        const bgPrompt = `Create a cinematic, high-quality BACKGROUND photo for a social post about:

${contentBrief}

Topic: "${headlineForCreativeFinal}"
Context: ${contentSummary.slice(0, 400)}

Use the SUBJECT and CONTEXT above to depict exactly who/what this is about (e.g. "Imran Khan, Bollywood actor" → Bollywood/film imagery, NOT politics). Photorealistic or editorial illustration, dramatic lighting, strong mood, relevant to the topic.`;

        // Hook line for the `hook_bars` style ONLY — a short punchy hook with one
        // or two **brand-highlighted** words that renderHighlightMarkup turns into
        // accent-color spans. This adds one AI text call, strictly gated on the
        // style so no other style pays for it. Never fails the whole repurpose:
        // on any error we fall back to no hook line.
        let hookLine: string | undefined;
        if (input.creativeStyle === "hook_bars") {
          try {
            const rawHook = await generateContentResilient({
              provider: input.provider,
              platform: "INSTAGRAM",
              userPrompt: `Write a 4-7 word punchy hook for a social post about: ${headlineForCreativeFinal}. Wrap ONE or TWO key words in **double asterisks** for emphasis. Output ONLY the hook line, no quotes.`,
              tone: "professional",
            });
            const trimmedHook = rawHook.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
            if (trimmedHook.length > 0) hookLine = capHookLine(trimmedHook);
          } catch (e) {
            console.warn(`[Repurpose] Hook line generation failed, rendering without hook:`, (e as Error).message);
          }
        }

        try {
          progress("Generating creative");
          console.log(`[Repurpose] Building branded headline creative (category=${category})...`);
          const creative = await buildHeadlineCreative(bgPrompt, headlineForCreativeFinal, category, hookLine);

          const { url, mediaId } = await uploadAndCreateMedia(
            creative.imageBase64,
            creative.mimeType,
            "static",
          );
          mediaUrls.push(url);
          mediaType = creative.mimeType.includes("png") ? "image/png" : "image/jpeg";
          // Same creative for every platform (caption differs per platform).
          for (const platform of input.targetPlatforms) {
            perPlatformMedia[platform] = { url, mediaId };
          }
          progress(
            "Generating creative",
            "done",
            creative.bgSource === "ai" ? "Uploaded to S3" : "Uploaded to S3 (stock background — AI image unavailable)",
          );
          console.log(`[Repurpose] Static creative uploaded: ${url} (mediaId: ${mediaId}, bg: ${creative.bgSource})`);
        } catch (e) {
          // The template renderer itself failed (Puppeteer/asset issue). This
          // is the genuine no-image case — surface it loudly (Fix 4) but with
          // a sanitized message (no raw provider internals / project IDs).
          progress("Generating creative", "error", friendlyAIMessage(e));
          console.error(`[Repurpose] Static creative FAILED:`, (e as Error).message);
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
          const kpResponse = await generateContentResilient({
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
          progress("Extracting key points for video scenes", "error", friendlyAIMessage(e));
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
            prompt: enforceNoHashtags(
              `Create a cinematic vertical still frame for a social media video about: "${extracted.title}". ${input.theme} theme, dark background, dramatic lighting, bold white text overlay, modern design. 9:16 portrait vertical.`
            ),
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
          progress("Generating AI video with Veo3 Ultra (1-3 min)", "error", friendlyAIMessage(e));
          progress("Falling back to slideshow reel");
          console.error(`[Repurpose] Veo3 generation failed, falling back to slideshow reel:`, (e as Error).message);

          // Fallback: generate slideshow reel from images (same as "reel" format)
          try {
            const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
            for (const point of keyPoints.slice(0, 6)) {
              try {
                const img = await generateGeminiImage({
                  prompt: enforceNoHashtags(
                    `Create a professional social media slide. Text: "${point}". ${input.theme} theme, cinematic, bold typography, relevant visual background. 4:5 portrait.`
                  ),
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
          const kpResponse = await generateContentResilient({
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
          progress("Extracting key points for video scenes", "error", friendlyAIMessage(e));
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
            // Live progress so the UI never looks frozen during the long poll.
            onProgress: ({ elapsedSeconds, status }) =>
              progress("Generating AI video with Seedance 2.0 (30s-3min)", "running", `${elapsedSeconds}s — ${status}`),
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
          progress("Generating AI video with Seedance 2.0 (30s-3min)", "error", friendlyAIMessage(e));
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
          const slideResponse = await generateContentResilient({
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
        const coverHeadline = capHeadline(extracted.title);
        const allSlides = [
          { type: "cover", title: coverHeadline, body: extracted.description?.slice(0, 100) || "" },
          ...slideData.map((d, i) => ({ type: "content", title: d.title, body: d.body })),
          { type: "cta", title: "Follow for More", body: "" },
        ];

        progress(`Generating ${allSlides.length} carousel slides`);
        console.log(`[Repurpose] Generating ${allSlides.length} AI carousel slides...`);

        // ── ALL slides through ONE branded template + ONE browser (C4/N13) ──
        // Every slide — cover, content (body), cta — now renders through
        // buildHeadlineCreative → the branded Puppeteer template. Previously the
        // cover used the template while body/cta slides used a raw AI image +
        // logo watermark, so slide 1 looked branded and slides 2+ looked like a
        // different design entirely. Routing all slides through the same template
        // (with slideRole selecting the layout) makes the carousel one set.
        //
        // We also launch ONE browser for the whole carousel and pass it to every
        // generateStyledCreativeImage call — instead of cold-booting Chrome per
        // slide (7+ launches per carousel → 1).
        const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
        const BATCH_SIZE = 3;
        const DELAY_BETWEEN_BATCHES = 3000; // 3s between batches
        const category = /CATEGORY:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || extracted.type || "news";

        const carouselBrowser = await launchCreativeBrowser();
        try {
          for (let batchStart = 0; batchStart < allSlides.length; batchStart += BATCH_SIZE) {
            if (batchStart > 0) {
              await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES));
            }

            const batchEnd = Math.min(batchStart + BATCH_SIZE, allSlides.length);
            const batchPromises = allSlides.slice(batchStart, batchEnd).map(async (slideMeta, batchIdx) => {
              const slideIdx = batchStart + batchIdx;
              const slideRole: "cover" | "body" | "cta" =
                slideMeta.type === "cover" ? "cover" : slideMeta.type === "cta" ? "cta" : "body";
              // Per-slide error isolation: one bad slide must NOT abort the
              // carousel or kill the shared browser — skip it (null) and keep
              // going, exactly like the previous resilience.
              try {
                const headline = slideMeta.title;
                const bgPrompt = `Cinematic background photo for: "${slideMeta.title}". ${contentBrief}`;
                const creative = await buildHeadlineCreative(
                  bgPrompt,
                  headline,
                  category,
                  undefined,
                  {
                    slideRole,
                    ...(slideRole === "body" ? { body: slideMeta.body } : {}),
                    browser: carouselBrowser,
                  },
                );
                return { slideIdx, imageBase64: creative.imageBase64, mimeType: creative.mimeType };
              } catch (e) {
                console.warn(`[Repurpose] Slide ${slideIdx + 1} (${slideRole}) failed:`, (e as Error).message);
                return null;
              }
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
        } finally {
          await carouselBrowser.close().catch(() => {});
        }

        // Upload all successfully generated slides to S3 AND create a Media row
        // per slide so post.create can attach them (carousel publish fix).
        for (let i = 0; i < slideImages.length; i++) {
          const slide = slideImages[i];
          if (!slide) continue;
          const ext = slide.mimeType.includes("png") ? "png" : "jpg";
          const contentType = slide.mimeType.includes("png") ? "image/png" : "image/jpeg";
          const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
          const buf = Buffer.from(slide.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
          const slideUrl = getPublicUrl(key);
          uploadedUrls.push(slideUrl);
          const media = await ctx.prisma.media.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: `carousel-${Date.now()}-${i}.${ext}`,
              fileType: contentType,
              fileSize: buf.length,
              url: slideUrl,
            },
          });
          carouselMediaIds.push(media.id);
        }

        progress(`Generating ${allSlides.length} carousel slides`, "done", `${uploadedUrls.length} uploaded`);
        console.log(`[Repurpose] ${uploadedUrls.length}/${allSlides.length} carousel slides uploaded`);

        if (carouselMediaIds.length > 0) {
          const first = { url: uploadedUrls[0]!, mediaId: carouselMediaIds[0]! };
          for (const platform of input.targetPlatforms) {
            perPlatformMedia[platform] = first;
          }
        }

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
              slideImages: compactSlides(slideImages).map((s) => ({
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
            const videoUrl = getPublicUrl(videoKey);
            mediaUrls = [videoUrl];
            mediaType = "video/mp4";
            // The publishable asset is the VIDEO, not the slide images. Create a
            // Media row for it and make it the sole attachable media so the UI
            // (which prefers carouselMediaIds) attaches the reel video — NOT the
            // N intermediate slide images. On reel failure we fall through to the
            // catch and keep the slide carouselMediaIds (degrades to a carousel).
            const videoMedia = await ctx.prisma.media.create({
              data: {
                organizationId,
                uploadedById: userId,
                fileName: `reel-${Date.now()}.mp4`,
                fileType: "video/mp4",
                fileSize: videoBuf.length,
                url: videoUrl,
                duration: slideImages.length * 3,
              },
            });
            carouselMediaIds.length = 0;
            carouselMediaIds.push(videoMedia.id);
            for (const platform of input.targetPlatforms) {
              perPlatformMedia[platform] = { url: videoUrl, mediaId: videoMedia.id };
            }
            progress("Stitching reel video from slides", "done", "Video uploaded");
            console.log(`[Repurpose] Reel video uploaded: ${mediaUrls[0]}`);
          } catch (e) {
            progress("Stitching reel video from slides", "error", friendlyAIMessage(e));
            console.warn(`[Repurpose] Reel generation failed, falling back to carousel:`, (e as Error).message);
            mediaUrls = uploadedUrls;
          }
        } else {
          mediaUrls = uploadedUrls;
        }
      }

      // Fail loudly (Fix 4): every format is expected to produce at least one
      // media asset. If captions generated but ALL media generation failed,
      // do NOT report a false success — the previous behaviour returned an
      // empty mediaUrls with a green "done" status, so the UI silently showed
      // captions and nothing else. Surface it as a real failure instead.
      const mediaFailed = mediaUrls.length === 0;
      if (pid) {
        finishProgress(
          pid,
          mediaFailed ? "error" : "done",
          mediaFailed
            ? `Captions generated, but ${input.format} media could not be produced — check the activity log above for the provider error.`
            : `${Object.keys(platformContent).length} captions, ${mediaUrls.length} media`,
        ).catch(() => {});
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
        mediaMap: perPlatformMedia,
        carouselMediaIds,
        mediaType,
        format: input.format,
        // Truthful signal for the UI: captions exist but no media was produced.
        mediaFailed,
      };
    }),
});
