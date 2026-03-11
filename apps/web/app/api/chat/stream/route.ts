import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";
import { streamChatAgent, parseActions, cleanResponseText } from "@postautomation/ai";
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
      agent: { select: { aiProvider: true } },
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
    select: { role: true, content: true },
  });

  const messages: AIChatMessage[] = dbMessages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  // Load org context
  const [channels, agents] = await Promise.all([
    prisma.channel.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true, platform: true, username: true },
    }),
    prisma.agent.findMany({
      where: { organizationId: membership.organizationId },
      select: { id: true, name: true, niche: true, isActive: true },
    }),
  ]);

  const provider: AIProvider =
    body.provider || (thread.agent?.aiProvider as AIProvider) || "anthropic";

  // Stream response
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const streamResponse = async () => {
    let fullResponse = "";

    try {
      for await (const chunk of streamChatAgent(provider, messages, {
        channels: channels.map((ch) => ({
          id: ch.id,
          name: ch.name || ch.username || "Unknown",
          platform: ch.platform,
        })),
        agents,
      })) {
        fullResponse += chunk;
        const data = `data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`;
        await writer.write(encoder.encode(data));
      }

      // Parse any actions from the response
      const action = parseActions(fullResponse);
      const displayText = cleanResponseText(fullResponse);

      // Save assistant message to DB
      await prisma.chatMessage.create({
        data: {
          threadId: body.threadId,
          role: "assistant",
          content: displayText,
          metadata: action ? JSON.parse(JSON.stringify({ action })) : undefined,
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
