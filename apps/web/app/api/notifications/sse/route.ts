import { auth } from "~/lib/auth";
import { prisma } from "@postautomation/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const userId = session.user.id as string;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let isClosed = false;

  const poll = async () => {
    while (!isClosed) {
      try {
        const notifications = await prisma.notification.findMany({
          where: {
            userId,
            isRead: false,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        });

        const data = `data: ${JSON.stringify(notifications)}\n\n`;
        await writer.write(encoder.encode(data));
      } catch {
        // Connection may have been closed by the client
        isClosed = true;
        break;
      }

      // Wait 5 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    try {
      await writer.close();
    } catch {
      // Writer may already be closed
    }
  };

  // Start polling in the background
  poll();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
