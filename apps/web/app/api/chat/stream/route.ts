import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import { streamChatAgent, parseActions, cleanResponseText, fetchTrendingNews, detectTrendingIntent, routeProvider } from "@postautomation/ai";
import type { AIChatMessage, AIProvider } from "@postautomation/ai";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.user.id as string;

  let body: { threadId: string; provider?: AIProvider };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body.threadId) {
    return new Response("threadId is required", { status: 400 });
  }

  // Get user's org
  const membership = await prisma.organizationMember.findFirst({
    where: { userId },
    select: { organizationId: true },
  });

  if (!membership) {
    return new Response("No organization found", { status: 403 });
  }

  // Verify thread belongs to user's org
  const thread = await prisma.chatThread.findFirst({
    where: { id: body.threadId, organizationId: membership.organizationId },
    include: {
      agent: { select: { aiProvider: true, niche: true } },
    },
  });

  if (!thread) {
    return new Response("Thread not found", { status: 404 });
  }

  // Load message history
  const dbMessages = await prisma.chatMessage.findMany({
    where: { threadId: body.threadId },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { role: true, content: true, metadata: true },
  });

  const messages: AIChatMessage[] = dbMessages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  // Load full platform context for the agent
  const [channels, agents, campaigns, listeningQueries, influencers, recentPosts, postStats, org] = await Promise.all([
    prisma.channel.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true, platform: true, username: true },
    }),
    prisma.agent.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true, niche: true, isActive: true, postsPerDay: true, totalPosts: true },
    }),
    prisma.campaign.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true, status: true, _count: { select: { brandTrackers: true } } },
      take: 10,
    }),
    prisma.listeningQuery.findMany({
      where: { organizationId: membership.organizationId, isActive: true },
      select: { id: true, name: true, keywords: true, platforms: true },
      take: 10,
    }),
    prisma.influencer.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true, platform: true, handle: true, status: true, followers: true },
      orderBy: { relevanceScore: "desc" },
      take: 20,
    }),
    prisma.post.findMany({
      where: { organizationId: membership.organizationId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, content: true, status: true, createdAt: true },
    }),
    Promise.all([
      prisma.post.count({ where: { organizationId: membership.organizationId } }),
      prisma.post.count({ where: { organizationId: membership.organizationId, status: "PUBLISHED" } }),
      prisma.post.count({ where: { organizationId: membership.organizationId, status: "SCHEDULED" } }),
    ]),
    prisma.organization.findUnique({
      where: { id: membership.organizationId },
      select: { name: true, logo: true },
    }),
  ]);

  // Detect trending news intent from the last user message
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  let trendingNews: Array<{ title: string; source: string; link: string; summary: string }> | undefined;

  if (lastUserMessage) {
    const trendingIntent = detectTrendingIntent(lastUserMessage.content);
    if (trendingIntent) {
      try {
        const headlines = await fetchTrendingNews(trendingIntent.topic, 10, trendingIntent.region);
        trendingNews = headlines.map((h) => ({
          title: h.title,
          source: h.source,
          link: h.link,
          summary: h.summary,
        }));
      } catch (error) {
        console.error("[Chat] Failed to fetch trending news:", error);
      }
    }
  }

  // Provider priority: explicit client request > agent preference > smart router
  let provider: AIProvider;
  if (body.provider) {
    provider = body.provider;
  } else if (thread.agent?.aiProvider) {
    provider = thread.agent.aiProvider as AIProvider;
  } else {
    const lastAssistantMsg = dbMessages
      .filter((m) => m.role === "assistant")
      .pop();
    const lastMeta = lastAssistantMsg?.metadata as Record<string, unknown> | null;
    provider = await routeProvider(
      lastUserMessage?.content ?? "",
      {
        threadHistory: messages.slice(-6),
        hasAttachments: false,
        agentNiche: thread.agent?.niche || undefined,
        lastProvider: (lastMeta?.provider as AIProvider) ?? undefined,
      }
    );
    console.log(`[Chat] Smart router selected provider: ${provider}`);
  }

  // Stream response
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Ordered by reliability — only the first non-failed provider is tried (max 1 fallback)
  const FALLBACK_PRIORITY: AIProvider[] = ["openai", "anthropic", "grok", "deepseek", "gemini", "gemma4"];

  const streamResponse = async () => {
    let fullResponse = "";
    let usedProvider = provider;

    const attemptStream = async (p: AIProvider): Promise<boolean> => {
      try {
        for await (const chunk of streamChatAgent(p, messages, {
          channels: channels.map((ch) => ({
            id: ch.id,
            name: ch.name || ch.username || "Unknown",
            platform: ch.platform,
            username: ch.username || undefined,
          })),
          agents,
          campaigns: campaigns.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            brandCount: c._count.brandTrackers,
          })),
          listeningQueries: listeningQueries.map((q) => ({
            id: q.id,
            query: `${q.name}: ${q.keywords.join(", ")}`,
            platforms: q.platforms,
            mentionCount: 0,
          })),
          influencers,
          recentPosts: recentPosts.map((p) => ({
            id: p.id,
            content: p.content,
            status: p.status,
            createdAt: p.createdAt.toISOString(),
          })),
          stats: {
            totalPosts: postStats[0],
            published: postStats[1],
            scheduled: postStats[2],
            connectedChannels: channels.length,
          },
          trendingNews,
          orgLogo: org?.logo || undefined,
          orgName: org?.name || undefined,
        })) {
          fullResponse += chunk;
          const data = `data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`;
          await writer.write(encoder.encode(data));
        }
        usedProvider = p;
        return true;
      } catch (error: any) {
        // If we already wrote chunks, this is a mid-stream failure — don't retry
        if (fullResponse.length > 0) {
          throw error;
        }
        console.error(`[Chat] Provider ${p} failed pre-stream:`, error.message);
        return false;
      }
    };

    try {
      // Try the routed provider first
      let success = await attemptStream(provider);

      // If pre-stream failure, try fallback (max 1 fallback)
      if (!success) {
        const fallback = FALLBACK_PRIORITY.find((p) => p !== provider);
        if (fallback) {
          console.log(`[Chat] Falling back from ${provider} to ${fallback}`);
          success = await attemptStream(fallback);
        }
      }

      if (!success) {
        throw new Error("All providers failed");
      }

      // Parse any actions from the response
      const action = parseActions(fullResponse);
      const displayText = cleanResponseText(fullResponse);

      // Save assistant message to DB (include provider in metadata for thread continuity)
      await prisma.chatMessage.create({
        data: {
          threadId: body.threadId,
          role: "assistant",
          content: displayText,
          metadata: JSON.parse(JSON.stringify({
            ...(action ? { action } : {}),
            provider: usedProvider,
          })),
        },
      });

      // Send completion event with action if present
      const doneData = `data: ${JSON.stringify({
        type: "done",
        action: action || null,
        displayText,
      })}\n\n`;
      await writer.write(encoder.encode(doneData));
    } catch (error: any) {
      const errData = `data: ${JSON.stringify({
        type: "error",
        message: error.message || "Failed to generate response",
      })}\n\n`;
      try {
        await writer.write(encoder.encode(errData));
      } catch {
        // Writer may be closed
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed
      }
    }
  };

  // Start streaming in background
  streamResponse();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
