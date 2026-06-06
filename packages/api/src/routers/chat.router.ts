import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { agentRunQueue, postPublishQueue } from "@postautomation/queue";
import { requirePlan, enforcePlanLimit } from "../middleware/plan-limit.middleware";
import type { PrismaClient } from "@postautomation/db";

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
 * Assert a payload field is a non-empty string, else throw a clean BAD_REQUEST
 * instead of letting an undefined reach Prisma as an opaque error (audit #11).
 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Missing required "${field}" — ask the agent to include it.` });
  }
  return value;
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
  { action: "trigger_agent_run",        label: "Fetch trending news",            description: "Run an agent to discover and post trending topics now", color: "text-orange-500" },
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
          await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
          const p = input.payload as any;
          requireText(p.content, "content");
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
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
            },
          });

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Post scheduled for ${post.scheduledAt?.toLocaleString() || "soon"}.`,
              metadata: { type: "post_scheduled", postId: post.id },
            },
          });

          return { type: "post_scheduled", postId: post.id };
        }

        case "bulk_schedule": {
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
              metadata: { type: "bulk_scheduled", postIds: createdPosts.map((p) => p.id) },
            },
          });

          return { type: "bulk_scheduled", count: createdPosts.length, postIds: createdPosts.map((p) => p.id) };
        }

        case "publish_now": {
          await enforcePlanLimit(ctx.organizationId, "postsPerMonth", ctx.isSuperAdmin);
          const p = input.payload as any;
          requireText(p.content, "content");
          await assertChannelsOwned(ctx.prisma, ctx.organizationId, p.channelIds || []);
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
              { delay: 0 }
            );
          }

          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `Post published to ${post.targets.map((t) => t.channel.name || t.channel.platform).join(", ")}.`,
              metadata: { type: "post_published", postId: post.id },
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
            where: { id: thread.agentId },
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

          // Save image as Media
          const imageBuffer = Buffer.from(imageResult.imageBase64, "base64");
          const fileName = `news-${Date.now()}.png`;

          const dataUrl = `data:${imageResult.mimeType};base64,${imageResult.imageBase64}`;

          const media = await ctx.prisma.media.create({
            data: {
              organizationId: ctx.organizationId,
              uploadedById: (ctx.session.user as any).id,
              fileName,
              fileType: imageResult.mimeType,
              fileSize: imageBuffer.length,
              url: dataUrl,
              width: imageResult.width,
              height: imageResult.height,
            },
          });

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
            imageUrl: dataUrl,
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

          const influencer = await ctx.prisma.influencer.update({
            where: { id: p.id },
            data: {
              ...(p.status && { status: p.status }),
              ...(p.notes && { notes: p.notes }),
              ...(p.contactEmail && { contactEmail: p.contactEmail }),
            },
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
              content: `Agent "${agent.name}" triggered manually. It will discover trends and generate content shortly.`,
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
