import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure, isAppAdmin } from "../trpc";
import { agentRunQueue, postPublishQueue } from "@postautomation/queue";
import { requirePlan, enforcePlanLimit } from "../middleware/plan-limit.middleware";
import type { PrismaClient } from "@postautomation/db";
import crypto from "crypto";
import { uploadBase64ToS3, isS3Configured } from "../lib/s3";
import { mediaRequiredBlock } from "../lib/media-required";

/**
 * Throws unless every channelId belongs to the given org.
 * Mirrors the validation block in post.router.ts:create — prevents the Super
 * Agent from targeting another org's channels (IDOR) via AI-supplied IDs.
 * Audit fix 2026-06-06.
 */
export async function assertChannelsOwned(
  prisma: PrismaClient,
  organizationId: string,
  channelIds: string[]
): Promise<void> {
  const ids = [...new Set((channelIds || []).filter(Boolean))];
  if (ids.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Select at least one channel to post to." });
  }
  const owned = await prisma.channel.findMany({
    where: { id: { in: ids }, organizationId },
    select: { id: true },
  });
  if (owned.length !== ids.length) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "One or more selected channels do not belong to your workspace.",
    });
  }
}

/**
 * Throws unless every mediaId belongs to the given org.
 * Prevents the Super Agent from attaching another org's media to a post (IDOR).
 */
export async function assertMediaOwned(
  prisma: PrismaClient,
  organizationId: string,
  mediaIds: string[]
): Promise<void> {
  if (!mediaIds || mediaIds.length === 0) return;
  const owned = await prisma.media.findMany({
    where: { id: { in: mediaIds }, organizationId },
    select: { id: true },
  });
  if (owned.length !== new Set(mediaIds).size) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Some media are not in this organization." });
  }
}

/**
 * Throws BAD_REQUEST when a post would target a media-required platform
 * (Instagram / Facebook) with NO media attached AND AI image generation OFF — a
 * post that can NEVER publish (the publish worker only auto-generates an image
 * when AI is on). Call AFTER assertChannelsOwned. The channel lookup is
 * org-scoped (no cross-org platform leak — IDOR-safe). No-op (and no query) when
 * media is attached, AI is on, or no channels target IG/FB. Deferred from
 * Plan-1 (scheduler-fix): the worker auto-generates UNCONDITIONALLY, so this
 * fires only for the genuinely-doomed `aiEnabled:false + no media` case — never
 * the default (aiEnabled defaults true everywhere it's wired).
 */
export async function assertMediaForPlatforms(
  prisma: PrismaClient,
  organizationId: string,
  channelIds: string[],
  opts: { hasMedia: boolean; aiEnabled: boolean },
): Promise<void> {
  // Fast path: nothing is doomed when media is present or AI will fill the gap.
  if (opts.hasMedia || opts.aiEnabled) return;
  const ids = [...new Set((channelIds || []).filter(Boolean))];
  if (ids.length === 0) return;
  const channels = await prisma.channel.findMany({
    where: { id: { in: ids }, organizationId },
    select: { platform: true },
  });
  const reason = mediaRequiredBlock({
    platforms: channels.map((c) => c.platform),
    hasMedia: opts.hasMedia,
    aiEnabled: opts.aiEnabled,
  });
  if (reason) throw new TRPCError({ code: "BAD_REQUEST", message: reason });
}

/**
 * Assert a payload field is a non-empty string, else throw a clean BAD_REQUEST
 * instead of letting an undefined reach Prisma as an opaque error (audit #11).
 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Missing required "${field}" — ask the agent to include it.` });
  }
  return value;
}

/**
 * A1 idempotency: returns true if a previous executeAction in this thread already
 * recorded a result ChatMessage stamped with this clientActionId. The dedupe is
 * keyed on (threadId + clientActionId) — a NEW action (new message id) is never
 * blocked, and the same button can't double-fire a LIVE post.
 *
 * `ChatMessage.metadata` is `Json?` on Postgres, so the JSON-path filter
 * `metadata: { path: ["executedActionId"], equals: ... }` is supported natively
 * by prisma-client-js.
 */
export async function isActionAlreadyExecuted(
  prisma: PrismaClient,
  threadId: string,
  clientActionId: string | undefined
): Promise<boolean> {
  if (!clientActionId) return false;
  const dupe = await prisma.chatMessage.findFirst({
    where: {
      threadId,
      metadata: { path: ["executedActionId"], equals: clientActionId },
    },
    select: { id: true },
  });
  return dupe !== null;
}

/**
 * Upload generated image bytes to S3 and create the backing Media row with the
 * S3 PUBLIC URL (not a multi-MB data: URL). Fix N2: storing a data URL broke
 * later publishes (providers `fetch(media.url)` expecting an HTTP URL) and
 * bloated the Postgres text column. Mirrors repurpose.router's upload pattern.
 * If S3 is unconfigured the upload fails loudly — we never fall back to a data URL.
 */
export async function storeGeneratedNewsImage(
  prisma: PrismaClient,
  args: {
    organizationId: string;
    uploadedById: string;
    imageBase64: string;
    mimeType: string;
    width?: number;
    height?: number;
  }
): Promise<{ mediaId: string; url: string }> {
  // Pre-flight S3 config so a missing credential surfaces a clear, actionable
  // message instead of an opaque AWS SDK error that reaches the chat UI as a
  // bare "Upload failed" (Bug #1, 2026-06-24). Without keys, uploadBase64ToS3
  // signs the request with "" and the bucket rejects it.
  if (!isS3Configured()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Image storage isn't configured (missing S3 credentials), so the generated image can't be saved. Ask the operator to set S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY.",
    });
  }

  const ext = args.mimeType.includes("png") ? "png" : "jpg";
  const contentType = args.mimeType.includes("png") ? "image/png" : "image/jpeg";
  const key = `chat-news/news-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;

  let url: string;
  try {
    url = await uploadBase64ToS3({ base64: args.imageBase64, mimeType: contentType, key });
  } catch (err: any) {
    // The raw S3 error is opaque ("Upload failed"); wrap it so the operator
    // sees the real cause (bucket missing, endpoint unreachable, bad creds).
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Could not save the generated image to storage: ${err?.message ?? "unknown S3 error"}`,
    });
  }
  const fileSize = Buffer.from(args.imageBase64, "base64").length;

  const media = await prisma.media.create({
    data: {
      organizationId: args.organizationId,
      uploadedById: args.uploadedById,
      fileName: `news-${Date.now()}.${ext}`,
      fileType: contentType,
      fileSize,
      url,
      width: args.width,
      height: args.height,
    },
  });

  return { mediaId: media.id, url };
}

// Fix #33: export supported actions so UI can derive the capability list from backend truth
export const SUPPORTED_ACTIONS = [
  { action: "create_agent",             label: "Set up autopilot agents",       description: "Create an AI agent that auto-publishes on a schedule", color: "text-yellow-500" },
  { action: "generate_content",         label: "Generate AI content",            description: "Use AI to draft posts, captions, and copy", color: "text-purple-500" },
  { action: "schedule_post",            label: "Schedule a post",                description: "Queue a post for a specific date/time", color: "text-blue-500" },
  { action: "bulk_schedule",            label: "Bulk schedule posts",            description: "Schedule multiple posts at once from a CSV or list", color: "text-blue-400" },
  { action: "publish_now",              label: "Create & publish posts",         description: "Immediately publish a post to selected channels", color: "text-blue-500" },
  { action: "update_agent",             label: "Update an agent",                description: "Change an existing autopilot agent's settings", color: "text-yellow-400" },
  { action: "generate_news_image",      label: "Create images & carousels",     description: "Generate branded news images for your channels", color: "text-green-500" },
  { action: "create_campaign",          label: "Create campaigns & trackers",    description: "Track hashtags, keywords, or competitors", color: "text-red-500" },
  { action: "create_brand_tracker",     label: "Track brands & competitors",     description: "Monitor brand mentions and competitor activity", color: "text-red-400" },
  { action: "create_listening_query",   label: "Monitor social mentions",        description: "Listen for brand or keyword mentions across platforms", color: "text-cyan-500" },
  { action: "update_influencer",        label: "Manage brand outreach",          description: "Update influencer or outreach contact details", color: "text-pink-500" },
  { action: "trigger_agent_run",        label: "Fetch trending news",            description: "Run an agent to discover trends and generate drafts for review", color: "text-orange-500" },
  { action: "get_analytics",            label: "Get analytics",                  description: "Fetch engagement and performance data for your posts", color: "text-indigo-500" },
] as const;

export const chatRouter = createRouter({
  // Fix #33: expose capabilities so the UI doesn't maintain a separate hardcoded list
  capabilities: orgProcedure.query(() => {
    return SUPPORTED_ACTIONS.map(({ action, label, description, color }) => ({
      action,
      label,
      description,
      color,
    }));
  }),

  listThreads: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.chatThread.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        agent: { select: { id: true, name: true, isActive: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { content: true, role: true, createdAt: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  }),

  getThread: orgProcedure
    .input(
      z.object({
        id: z.string(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const thread = await ctx.prisma.chatThread.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          agent: { select: { id: true, name: true, isActive: true, aiProvider: true } },
        },
      });

      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      const messages = await ctx.prisma.chatMessage.findMany({
        where: { threadId: input.id },
        orderBy: { createdAt: "asc" },
        take: input.limit,
        include: {
          attachments: {
            include: {
              media: {
                select: { id: true, url: true, thumbnailUrl: true, fileName: true, fileType: true },
              },
            },
          },
        },
      });

      return { ...thread, messages };
    }),

  createThread: orgProcedure
    .input(
      z.object({
        agentId: z.string().optional(),
        title: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;

      return ctx.prisma.chatThread.create({
        data: {
          organizationId: ctx.organizationId,
          agentId: input.agentId,
          title: input.title || "New Chat",
          createdById: userId,
        },
      });
    }),

  deleteThread: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.prisma.chatThread.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }
      await ctx.prisma.chatThread.delete({ where: { id: input.id } });
      return { success: true };
    }),

  sendMessage: orgProcedure
    .input(
      z.object({
        threadId: z.string(),
        content: z.string().min(1),
        attachmentMediaIds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify thread belongs to org
      const thread = await ctx.prisma.chatThread.findFirst({
        where: { id: input.threadId, organizationId: ctx.organizationId },
      });
      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      const message = await ctx.prisma.chatMessage.create({
        data: {
          threadId: input.threadId,
          role: "user",
          content: input.content,
          attachments: input.attachmentMediaIds
            ? {
                create: input.attachmentMediaIds.map((mediaId) => ({
                  mediaId,
                })),
              }
            : undefined,
        },
        include: {
          attachments: {
            include: {
              media: {
                select: { id: true, url: true, thumbnailUrl: true, fileName: true, fileType: true },
              },
            },
          },
        },
      });

      // Update thread title from first message if default
      if (thread.title === "New Chat") {
        const title = input.content.slice(0, 50) + (input.content.length > 50 ? "..." : "");
        await ctx.prisma.chatThread.update({
          where: { id: input.threadId },
          data: { title, updatedAt: new Date() },
        });
      } else {
        await ctx.prisma.chatThread.update({
          where: { id: input.threadId },
          data: { updatedAt: new Date() },
        });
      }

      return message;
    }),

  // Execute an action suggested by the AI (create agent, schedule post, etc.)
  executeAction: orgProcedure
    .input(
      z.object({
        threadId: z.string(),
        actionType: z.enum([
          "create_agent", "generate_content", "schedule_post", "bulk_schedule",
          "publish_now", "update_agent", "generate_news_image", "create_campaign",
          "create_brand_tracker", "create_listening_query", "update_influencer",
          "trigger_agent_run", "get_analytics",
        ]),
        payload: z.record(z.unknown()),
        // A1: optional per-message id from the client. When set, the
        // post-creating cases (publish_now/schedule_post/bulk_schedule) dedupe
        // on (threadId + clientActionId) so re-clicking the same action button
        // can't create duplicate LIVE posts (no server idempotency before this).
        clientActionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.prisma.chatThread.findFirst({
        where: { id: input.threadId, organizationId: ctx.organizationId },
      });
      if (!thread) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
      }

      switch (input.actionType) {
        case "create_agent": {
          // RBAC: autopilot is an admin-only feature area — the Super Agent chat
          // must not be a side door into it for USER-role accounts. All other
          // action types (schedule/publish/analytics/news-image) stay USER.
          if (process.env.RBAC_DISABLED !== "true" && !isAppAdmin(ctx.session?.user)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Creating autopilot agents requires an admin role.",
            });
          }
          await requirePlan(ctx.organizationId, "STARTER", "Autopilot agents", ctx.isSuperAdmin);
          const p = input.payload as any;
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
          const agent = await ctx.prisma.agent.create({
            data: {
              organizationId: ctx.organizationId,
              name: p.name || "My AI Agent",
              aiProvider: p.aiProvider || "anthropic",
              niche: p.niche || "",
              topics: p.topics || [],
              tone: p.tone || "professional",
              frequency: p.frequency || "daily",
              postsPerDay: p.postsPerDay || 1,
              cronExpression:
                p.frequency === "weekdays"
                  ? "0 9 * * 1-5"
                  : p.frequency === "weekly"
                    ? "0 9 * * 1"
                    : "0 9 * * *",
              channelIds: p.channelIds || [],
            },
          });

          // Link thread to the new agent
          await ctx.prisma.chatThread.update({
            where: { id: input.threadId },
            data: { agentId: agent.id, title: agent.name },
          });

          // Add system message
          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Agent "${agent.name}" created successfully and is now active.`,
              metadata: { type: "agent_created", agentId: agent.id },
            },
          });

          return { type: "agent_created", agentId: agent.id, name: agent.name };
        }

        case "generate_content": {
          const p = input.payload as any;
          // Content is already in the AI message, just acknowledge
          return { type: "content_generated", platform: p.platform, content: p.content };
        }

        case "schedule_post": {
          // A1: short-circuit if this exact action button was already executed.
          if (await isActionAlreadyExecuted(ctx.prisma, input.threadId, input.clientActionId)) {
            return { type: "already_executed" };
          }
          await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
          const p = input.payload as any;
          requireText(p.content, "content");
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
          const mediaIds: string[] = Array.isArray(p.mediaIds) ? p.mediaIds : [];
          await assertMediaOwned(ctx.prisma, ctx.organizationId, mediaIds);
          // Block a media-less IG/FB schedule only when AI is OFF (default true →
          // dormant; the worker auto-generates when on). aiEnabled defaults true.
          await assertMediaForPlatforms(ctx.prisma, ctx.organizationId, p.channelIds || [], {
            hasMedia: mediaIds.length > 0,
            aiEnabled: p.aiImages !== false,
          });
          const userId = (ctx.session.user as any).id;
          const post = await ctx.prisma.post.create({
            data: {
              organizationId: ctx.organizationId,
              createdById: userId,
              content: p.content,
              status: "SCHEDULED",
              scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : new Date(Date.now() + 3600000),
              aiGenerated: true,
              targets: {
                create: (p.channelIds || []).map((channelId: string) => ({
                  channelId,
                  status: "SCHEDULED",
                })),
              },
              ...(mediaIds.length && {
                mediaAttachments: {
                  create: mediaIds.map((mediaId: string, index: number) => ({ mediaId, order: index })),
                },
              }),
            },
          });

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Post scheduled for ${post.scheduledAt?.toLocaleString() || "soon"}.`,
              metadata: { type: "post_scheduled", postId: post.id, executedActionId: input.clientActionId },
            },
          });

          return { type: "post_scheduled", postId: post.id };
        }

        case "bulk_schedule": {
          // A1: short-circuit if this exact action button was already executed.
          if (await isActionAlreadyExecuted(ctx.prisma, input.threadId, input.clientActionId)) {
            return { type: "already_executed" };
          }
          const p = input.payload as any;
          const userId = (ctx.session.user as any).id;
          const posts = p.posts || [];

          if (!posts.length) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "No posts provided" });
          }

          const createdPosts = [];
          for (const item of posts) {
            requireText(item.content, "content");
            await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
            await assertChannelsOwned(ctx.prisma, ctx.organizationId, item.channelIds || []);
            const itemMediaIds: string[] = Array.isArray(item.mediaIds) ? item.mediaIds : [];
            await assertMediaOwned(ctx.prisma, ctx.organizationId, itemMediaIds);
            await assertMediaForPlatforms(ctx.prisma, ctx.organizationId, item.channelIds || [], {
              hasMedia: itemMediaIds.length > 0,
              aiEnabled: item.aiImages !== false,
            });
            const post = await ctx.prisma.post.create({
              data: {
                organizationId: ctx.organizationId,
                createdById: userId,
                content: item.content,
                status: "SCHEDULED",
                scheduledAt: item.scheduledAt ? new Date(item.scheduledAt) : new Date(Date.now() + 3600000),
                aiGenerated: true,
                targets: {
                  create: (item.channelIds || []).map((channelId: string) => ({
                    channelId,
                    status: "SCHEDULED",
                  })),
                },
                ...(itemMediaIds.length && {
                  mediaAttachments: {
                    create: itemMediaIds.map((mediaId: string, index: number) => ({ mediaId, order: index })),
                  },
                }),
              },
            });
            createdPosts.push(post);
          }

          const summary = createdPosts
            .map((p) => `• "${p.content.slice(0, 50)}..." → ${p.scheduledAt?.toLocaleString() || "soon"}`)
            .join("\n");

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `${createdPosts.length} posts scheduled:\n${summary}`,
              metadata: { type: "bulk_scheduled", postIds: createdPosts.map((p) => p.id), executedActionId: input.clientActionId },
            },
          });

          return { type: "bulk_scheduled", count: createdPosts.length, postIds: createdPosts.map((p) => p.id) };
        }

        case "publish_now": {
          // A1: short-circuit if this exact action button was already executed —
          // re-clicking "Publish now" must NOT create a second LIVE post.
          if (await isActionAlreadyExecuted(ctx.prisma, input.threadId, input.clientActionId)) {
            return { type: "already_executed" };
          }
          await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
          const p = input.payload as any;
          requireText(p.content, "content");
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
          const mediaIds: string[] = Array.isArray(p.mediaIds) ? p.mediaIds : [];
          await assertMediaOwned(ctx.prisma, ctx.organizationId, mediaIds);
          // publish_now goes LIVE immediately — block a media-less IG/FB post when
          // AI is off (it can never succeed). aiEnabled defaults true (dormant).
          await assertMediaForPlatforms(ctx.prisma, ctx.organizationId, p.channelIds || [], {
            hasMedia: mediaIds.length > 0,
            aiEnabled: p.aiImages !== false,
          });
          const userId = (ctx.session.user as any).id;

          // Create post and immediately queue for publishing
          const post = await ctx.prisma.post.create({
            data: {
              organizationId: ctx.organizationId,
              createdById: userId,
              content: p.content,
              status: "SCHEDULED",
              scheduledAt: new Date(), // now
              aiGenerated: true,
              targets: {
                create: (p.channelIds || []).map((channelId: string) => ({
                  channelId,
                  status: "SCHEDULED",
                })),
              },
              ...(mediaIds.length && {
                mediaAttachments: {
                  create: mediaIds.map((mediaId: string, index: number) => ({ mediaId, order: index })),
                },
              }),
            },
            include: { targets: { include: { channel: true } } },
          });

          // Queue each target for immediate publishing
          for (const target of post.targets) {
            await postPublishQueue.add(
              `chat-publish-${target.id}`,
              {
                postId: post.id,
                postTargetId: target.id,
                channelId: target.channelId,
                platform: target.channel.platform,
                organizationId: ctx.organizationId,
              },
              // B4: match compose (post.router.ts) — retry transient publish
              // failures instead of failing on the first hiccup.
              { delay: 0, attempts: 3, backoff: { type: "exponential", delay: 30000 } }
            );
          }

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Post published to ${post.targets.map((t) => t.channel.name || t.channel.platform).join(", ")}.`,
              metadata: { type: "post_published", postId: post.id, executedActionId: input.clientActionId },
            },
          });

          return { type: "post_published", postId: post.id };
        }

        case "update_agent": {
          const p = input.payload as any;
          if (!thread.agentId) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "No agent linked to this thread" });
          }
          const updated = await ctx.prisma.agent.update({
            // Org-scope the where clause (N7): the thread is org-scoped but the
            // agent record was not re-validated, so an AI-driven action could
            // mutate another org's agent. Prisma throws P2025 if the agent is
            // not in this org — the desired deny.
            where: { id: thread.agentId, organizationId: ctx.organizationId },
            data: {
              ...(p.name && { name: p.name }),
              ...(p.niche && { niche: p.niche }),
              ...(p.topics && { topics: p.topics }),
              ...(p.tone && { tone: p.tone }),
              ...(p.frequency && { frequency: p.frequency }),
              ...(p.postsPerDay && { postsPerDay: p.postsPerDay }),
            },
          });
          return { type: "agent_updated", agentId: updated.id };
        }

        case "generate_news_image": {
          await enforcePlanLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin);
          const p = input.payload as any;
          requireText(p.headline, "headline");

          // Dynamically import directly from the file to avoid pulling in LangChain + full AI package
          const { generateNewsImage } = await import("@postautomation/ai/src/tools/news-image-generator");

          const style = p.imageStyle === "ai_generated" ? "ai_generated" : "news_card";
          const platform = (p.platform || "twitter").toLowerCase() as "instagram" | "twitter" | "linkedin" | "facebook";

          // Get org logo if includeLogo is true and not explicitly provided
          let logoUrl = p.logoUrl;
          if (p.includeLogo !== false && !logoUrl) {
            const org = await ctx.prisma.organization.findUnique({
              where: { id: ctx.organizationId },
              select: { logo: true },
            });
            logoUrl = org?.logo || undefined;
          }

          const imageResult = await generateNewsImage(style, {
            headline: p.headline || "Trending News",
            source: p.source || "News",
            sourceUrl: p.sourceUrl,
            logoUrl,
            platform,
          });

          // Upload image bytes to S3 and store the public URL (NOT a data URL):
          // social providers fetch(media.url) on publish, and a data URL bloats
          // the Postgres text column. Fix N2.
          const { mediaId, url: imageUrl } = await storeGeneratedNewsImage(ctx.prisma, {
            organizationId: ctx.organizationId,
            uploadedById: (ctx.session.user as any).id,
            imageBase64: imageResult.imageBase64,
            mimeType: imageResult.mimeType,
            width: imageResult.width,
            height: imageResult.height,
          });
          const media = { id: mediaId };

          // Attach to a system message in the thread
          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `News image generated (${style === "news_card" ? "branded card" : "AI illustration"}).`,
              metadata: JSON.parse(JSON.stringify({
                type: "news_image_generated",
                mediaId: media.id,
                style,
                headline: p.headline,
              })),
              attachments: {
                create: { mediaId: media.id },
              },
            },
          });

          return {
            type: "news_image_generated",
            mediaId: media.id,
            imageUrl,
            style,
            content: p.content,
          };
        }

        case "create_campaign": {
          const p = input.payload as any;
          const campaign = await ctx.prisma.campaign.create({
            data: {
              organizationId: ctx.organizationId,
              name: p.name || "New Campaign",
              description: p.description || undefined,
              hashtags: p.hashtags || [],
              goalType: p.goalType || undefined,
              status: "ACTIVE",
            },
          });

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Campaign "${campaign.name}" created and is now active.`,
              metadata: { type: "campaign_created", campaignId: campaign.id },
            },
          });

          return { type: "campaign_created", campaignId: campaign.id, name: campaign.name };
        }

        case "create_brand_tracker": {
          const p = input.payload as any;
          // Verify an AI-supplied campaignId belongs to this org before
          // associating it (N8): otherwise a cross-org campaign could be linked
          // / leaked onto the new BrandTracker. Absent campaignId is fine.
          if (p.campaignId) {
            const camp = await ctx.prisma.campaign.findFirst({
              where: { id: p.campaignId, organizationId: ctx.organizationId },
            });
            if (!camp) {
              throw new TRPCError({ code: "FORBIDDEN", message: "Campaign not found in this workspace" });
            }
          }
          const brand = await ctx.prisma.brandTracker.create({
            data: {
              organizationId: ctx.organizationId,
              brandName: p.brandName || "Unknown Brand",
              description: p.description || undefined,
              campaignId: p.campaignId || undefined,
              twitterHandle: p.twitterHandle || undefined,
              instagramHandle: p.instagramHandle || undefined,
              facebookPageId: p.facebookPageId || undefined,
              linkedinHandle: p.linkedinHandle || undefined,
              tiktokHandle: p.tiktokHandle || undefined,
              websiteUrl: p.websiteUrl || undefined,
            },
          });

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Now tracking brand "${brand.brandName}". Content sync will begin in the next cycle.`,
              metadata: { type: "brand_tracker_created", brandId: brand.id },
            },
          });

          return { type: "brand_tracker_created", brandId: brand.id, brandName: brand.brandName };
        }

        case "create_listening_query": {
          const p = input.payload as any;
          const queryText = p.query || p.keywords?.join(", ") || "";
          const keywords = p.keywords || (p.query ? p.query.split(",").map((k: string) => k.trim()) : []);
          const listeningQuery = await ctx.prisma.listeningQuery.create({
            data: {
              organizationId: ctx.organizationId,
              name: p.name || queryText.slice(0, 50) || "New Query",
              keywords,
              platforms: p.platforms || ["TWITTER", "REDDIT"],
            },
          });

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Listening query "${listeningQuery.name}" created. Monitoring ${listeningQuery.platforms.join(", ")} for: ${listeningQuery.keywords.join(", ")}. First results will appear after the next sync cycle.`,
              metadata: { type: "listening_created", queryId: listeningQuery.id },
            },
          });

          return { type: "listening_created", queryId: listeningQuery.id };
        }

        case "update_influencer": {
          const p = input.payload as any;
          if (!p.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Influencer ID required" });

          // IDOR fix (audit 2026-06-19 / H7): org-scope the write so an AI-supplied
          // id cannot mutate another org's influencer. Mirrors
          // campaign.router.ts:updateInfluencer (updateMany + count check + scoped re-fetch).
          const updated = await ctx.prisma.influencer.updateMany({
            where: { id: p.id, organizationId: ctx.organizationId },
            data: {
              ...(p.status && { status: p.status }),
              ...(p.notes && { notes: p.notes }),
              ...(p.contactEmail && { contactEmail: p.contactEmail }),
            },
          });
          if (updated.count === 0) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Influencer not found" });
          }
          const influencer = await ctx.prisma.influencer.findFirstOrThrow({
            where: { id: p.id, organizationId: ctx.organizationId },
          });

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Influencer "${influencer.name}" updated to status: ${influencer.status}.`,
              metadata: { type: "influencer_updated", influencerId: influencer.id },
            },
          });

          return { type: "influencer_updated", influencerId: influencer.id, status: influencer.status };
        }

        case "trigger_agent_run": {
          const p = input.payload as any;
          if (!p.agentId) throw new TRPCError({ code: "BAD_REQUEST", message: "Agent ID required" });

          const agent = await ctx.prisma.agent.findFirst({
            where: { id: p.agentId, organizationId: ctx.organizationId },
          });
          if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });

          await agentRunQueue.add(
            `chat-trigger-${agent.id}`,
            { agentId: agent.id, organizationId: ctx.organizationId },
            { removeOnComplete: true, removeOnFail: 100 },
          );

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Agent "${agent.name}" triggered manually. It will discover trends and generate drafts shortly — they'll appear in Autopilot → Review Queue for your approval before publishing (unless the agent's account group has review skipping enabled).`,
              metadata: { type: "agent_triggered", agentId: agent.id },
            },
          });

          return { type: "agent_triggered", agentId: agent.id, agentName: agent.name };
        }

        case "get_analytics": {
          const [totalPosts, published, scheduled, channels, recentPosts, publishedTargets] = await Promise.all([
            ctx.prisma.post.count({ where: { organizationId: ctx.organizationId } }),
            ctx.prisma.post.count({ where: { organizationId: ctx.organizationId, status: "PUBLISHED" } }),
            ctx.prisma.post.count({ where: { organizationId: ctx.organizationId, status: "SCHEDULED" } }),
            ctx.prisma.channel.count({ where: { organizationId: ctx.organizationId, isActive: true } }),
            ctx.prisma.post.findMany({
              where: { organizationId: ctx.organizationId },
              orderBy: { createdAt: "desc" },
              take: 5,
              select: { id: true, content: true, status: true, createdAt: true },
            }),
            ctx.prisma.postTarget.findMany({
              where: { post: { organizationId: ctx.organizationId }, status: "PUBLISHED" },
              select: { id: true },
            }),
          ]);

          // Engagement summary so chat matches the dashboard — sum the latest
          // AnalyticsSnapshot per published target (same source as analytics.engagement).
          let engagement = { impressions: 0, likes: 0, comments: 0, shares: 0, reach: 0 };
          const targetIds = publishedTargets.map((t) => t.id);
          if (targetIds.length > 0) {
            const rows: Array<{ impressions: bigint; likes: bigint; comments: bigint; shares: bigint; reach: bigint }> =
              await (ctx.prisma.$queryRawUnsafe as any)(
                `SELECT
                  COALESCE(SUM(a.impressions), 0) as impressions,
                  COALESCE(SUM(a.likes), 0) as likes,
                  COALESCE(SUM(a.comments), 0) as comments,
                  COALESCE(SUM(a.shares), 0) as shares,
                  COALESCE(SUM(a.reach), 0) as reach
                FROM "AnalyticsSnapshot" a
                INNER JOIN (
                  SELECT "postTargetId", MAX("snapshotAt") as max_snapshot
                  FROM "AnalyticsSnapshot"
                  WHERE "postTargetId" = ANY($1::text[])
                  GROUP BY "postTargetId"
                ) latest ON a."postTargetId" = latest."postTargetId" AND a."snapshotAt" = latest.max_snapshot`,
                targetIds
              );
            const r = rows[0];
            engagement = {
              impressions: Number(r?.impressions ?? 0),
              likes: Number(r?.likes ?? 0),
              comments: Number(r?.comments ?? 0),
              shares: Number(r?.shares ?? 0),
              reach: Number(r?.reach ?? 0),
            };
          }

          const summary = `📊 Dashboard Summary:\n- Total posts: ${totalPosts}\n- Published: ${published}\n- Scheduled: ${scheduled}\n- Active channels: ${channels}\n\nEngagement (all published posts):\n- Impressions: ${engagement.impressions}\n- Likes: ${engagement.likes}\n- Comments: ${engagement.comments}\n- Shares: ${engagement.shares}\n- Reach: ${engagement.reach}\n\nRecent posts:\n${recentPosts.map((p) => `  • [${p.status}] ${p.content.slice(0, 60)}...`).join("\n")}`;

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: summary,
              metadata: { type: "analytics_fetched" },
            },
          });

          return { type: "analytics_fetched", totalPosts, published, scheduled, channels, engagement };
        }

        default:
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown action type" });
      }
    }),
});
