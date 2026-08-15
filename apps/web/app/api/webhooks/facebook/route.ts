import { NextResponse } from "next/server";
import crypto from "crypto";
import { enqueueFacebookFeedAnalytics } from "@postautomation/api/src/lib/fb-webhook-analytics";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Facebook Graph API webhook receiver.
 *
 * Registered on app 298449321694397 for topics:
 *   - `page`, fields: `feed`  (post/comment/reaction events on connected Pages)
 *
 * Two flows:
 *   GET  — Meta's one-time verification handshake. Returns `hub.challenge`
 *          as text/plain if `hub.verify_token` matches our shared secret.
 *   POST — Event delivery. HMAC-SHA256 signature is verified with the app
 *          secret before any processing. We ack 200 immediately and enqueue
 *          analytics-sync jobs in the background — Meta retries on non-2xx
 *          and disables subscriptions on repeated failure, so keeping this
 *          fast is essential.
 *
 * ⚠️ Cross-package import: apps/web has no direct dep on @postautomation/queue,
 * so the enqueue is bridged via @postautomation/api/src/lib/fb-webhook-analytics
 * (same pattern as avatar-cache enqueue in oauth/callback/[provider]/route.ts).
 */

const VERIFY_TOKEN = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!VERIFY_TOKEN) {
    console.error("[fb-webhook] FACEBOOK_WEBHOOK_VERIFY_TOKEN not configured");
    return new NextResponse("Not configured", { status: 500 });
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[fb-webhook] Subscription verified");
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  console.warn(`[fb-webhook] Verification rejected — mode=${mode}`);
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256") || "";

  if (!APP_SECRET) {
    console.error("[fb-webhook] FACEBOOK_CLIENT_SECRET not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  // SECURITY: verify HMAC-SHA256 signature. Without this anyone can forge
  // webhook events against our public endpoint.
  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(rawBody)
    .digest("hex");

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    console.warn(`[fb-webhook] Invalid signature`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Ack fast, process asynchronously. Errors during processing are logged
  // but do not affect the ack — Meta disables subscriptions on repeated
  // non-2xx, so the ack ordering matters.
  processEventsInBackground(payload).catch((err) => {
    console.error(`[fb-webhook] Background processing error:`, err);
  });

  return NextResponse.json({ ok: true });
}

async function processEventsInBackground(payload: any): Promise<void> {
  if (payload.object !== "page") {
    console.log(`[fb-webhook] Ignoring non-page event (object=${payload.object})`);
    return;
  }

  for (const entry of payload.entry || []) {
    const pageId = entry.id as string;
    const changes = (entry.changes || []) as Array<{ field: string; value: any }>;

    for (const change of changes) {
      try {
        if (change.field === "feed") {
          const fbPostId = change.value?.post_id as string | undefined;
          if (!fbPostId) continue;

          const { queued, reason } = await enqueueFacebookFeedAnalytics({
            pageId,
            fbPostId,
            item: change.value?.item,
            verb: change.value?.verb,
          });

          if (queued) {
            console.log(
              `[fb-webhook] Queued analytics-sync for ${fbPostId} ` +
                `(item=${change.value?.item}, verb=${change.value?.verb})`
            );
          } else if (reason !== "not_our_post") {
            console.warn(`[fb-webhook] Skipped ${fbPostId}: ${reason}`);
          }
        } else {
          console.log(`[fb-webhook] Unhandled field: ${change.field}`);
        }
      } catch (err) {
        console.error(`[fb-webhook] Error processing ${change.field} for page ${pageId}:`, err);
      }
    }
  }
}
