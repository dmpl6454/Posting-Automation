/**
 * SSE endpoint for streaming progress updates to the frontend.
 * Usage: GET /api/progress?id=<progressId>
 *
 * Subscribes to Redis pub/sub channel "progress-notify:{id}" and
 * also fetches any already-pushed steps on connect (catch-up).
 */

import { auth } from "~/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new Response("Missing id param", { status: 400 });
  }

  // Scope the client-supplied id by the authenticated userId so the Redis
  // keys/channels are per-user. The repurpose id is low-entropy
  // (`rep-<ts>-<6char>`); without this, any signed-in user could read another
  // user's repurpose progress stream by guessing the id (cross-tenant IDOR).
  // The repurpose writer in packages/api/src/routers/repurpose.router.ts scopes
  // identically via scopedProgressId(userId, id) → `${userId}:${id}`, so the
  // keys match for the legitimate owner and diverge (→ empty) for any other user.
  //
  // The other consumer of this route is the post-publish progress flow
  // (apps/web/app/dashboard/posts/[id]/page.tsx), whose id is a server-issued
  // PostTarget cuid published by the worker to the UNSCOPED channel
  // (apps/worker/src/workers/post-publish.worker.ts). Those ids are not the
  // low-entropy client ids called out in the finding, so we only userId-scope
  // the `rep-` namespace and leave the worker/posts flow on its existing key.
  const scoped = id.startsWith("rep-") ? `${session.user.id}:${id}` : id;

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  let IORedis: any;
  try {
    IORedis = (await import("ioredis")).default;
  } catch {
    return new Response("Redis not available", { status: 503 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let closed = false;

  const sub = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const reader = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

  const send = async (data: string) => {
    if (closed) return;
    try {
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    } catch {
      closed = true;
    }
  };

  const cleanup = async () => {
    closed = true;
    try { sub.disconnect(); } catch {}
    try { reader.disconnect(); } catch {}
    try { await writer.close(); } catch {}
  };

  // On client disconnect
  request.signal.addEventListener("abort", () => cleanup());

  // Start streaming
  (async () => {
    try {
      // 1. Send any already-pushed steps (catch-up)
      const existing = await reader.lrange(`progress:${scoped}`, 0, -1);
      for (const entry of existing) {
        await send(entry);
        const parsed = JSON.parse(entry);
        if (parsed.step === "__finished__") {
          await cleanup();
          return;
        }
      }

      // 2. Subscribe for new steps
      await sub.subscribe(`progress-notify:${scoped}`);

      sub.on("message", async (_channel: string, message: string) => {
        await send(message);
        try {
          const parsed = JSON.parse(message);
          if (parsed.step === "__finished__") {
            await cleanup();
          }
        } catch {}
      });

      // 3. Timeout after 5 minutes
      setTimeout(() => cleanup(), 5 * 60 * 1000);
    } catch {
      await cleanup();
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
