import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { agentRunQueue } from "@postautomation/queue";

export const chatRouter = createRouter({
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
        actionType: z.enum(["create_agent", "generate_content", "schedule_post", "update_agent", "generate_news_image"]),
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
          const p = input.payload as any;
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
          const p = input.payload as any;
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
                  status: "PENDING",
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
          const p = input.payload as any;

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

        default:
          throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown action type" });
      }
    }),
});
