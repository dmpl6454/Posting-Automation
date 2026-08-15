import { NextResponse } from "next/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Instagram Graph API webhook receiver.
 *
 * Registered on app 298449321694397 for topic:
 *   - `instagram`, fields: `story_insights`  (real-time story metrics)
 *
 * WHY A SEPARATE ROUTE FROM /api/webhooks/facebook
 * ------------------------------------------------
 * Meta sends different `object` values per topic (`page` for FB, `instagram`
 * for IG), so both COULD share one endpoint. Splitting the URLs makes the
 * subscription config in Meta's dashboard easier to read and lets us have
 * distinct verify tokens per topic if we ever want to. Currently they share
 * FACEBOOK_WEBHOOK_VERIFY_TOKEN — Meta's docs treat the verify token as an
 * arbitrary shared secret, and having one less env var is worth the naming
 * asymmetry.
 *
 * WHY story_insights ONLY (for now)
 * ---------------------------------
 *   comments        — needs instagram_manage_comments (REJECTED — pending Tier 3 resubmission)
 *   mentions        — needs instagram_manage_comments (same)
 *   messages        — Messenger API territory, out of scope
 *   story_insights  — needs instagram_manage_insights (APPROVED)
 *
 * story_insights is the only IG field we can subscribe to today with the
 * permissions we have. The payload is the metrics themselves (impressions,
 * reach, taps_forward, replies, etc.) — we log for now while we design how
 * to fit story-level data into the existing analytics tables.
 */

const VERIFY_TOKEN = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;
const APP_SECRET = process.env.FACEBOOK_CLIENT_SECRET;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!VERIFY_TOKEN) {
    console.error("[ig-webhook] FACEBOOK_WEBHOOK_VERIFY_TOKEN not configured");
    return new NextResponse("Not configured", { status: 500 });
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[ig-webhook] Subscription verified");
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  console.warn(`[ig-webhook] Verification rejected — mode=${mode}`);
  return new NextResponse("Forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256") || "";

  if (!APP_SECRET) {
    console.error("[ig-webhook] FACEBOOK_CLIENT_SECRET not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  // SECURITY: verify HMAC-SHA256 signature. Same secret (App Secret) works
  // for both FB and IG webhook topics — Meta signs all events for a given
  // app with the same key regardless of topic.
  const expected = "sha256=" + crypto
    .createHmac("sha256", APP_SECRET)
    .update(rawBody)
    .digest("hex");

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    console.warn(`[ig-webhook] Invalid signature`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  processEventsInBackground(payload).catch((err) => {
    console.error(`[ig-webhook] Background processing error:`, err);
  });

  return NextResponse.json({ ok: true });
}

async function processEventsInBackground(payload: any): Promise<void> {
  if (payload.object !== "instagram") {
    console.log(`[ig-webhook] Ignoring non-instagram event (object=${payload.object})`);
    return;
  }

  for (const entry of payload.entry || []) {
    const igUserId = entry.id as string;
    const changes = (entry.changes || []) as Array<{ field: string; value: any }>;

    for (const change of changes) {
      try {
        if (change.field === "story_insights") {
          // Meta sends the metrics directly in the value. Shape (per docs):
          //   {media_id, impressions, reach, taps_forward, taps_back,
          //    exits, replies}
          // For now we log the raw event — persisting to AnalyticsSnapshot
          // needs a story-tracking data model that doesn't exist yet
          // (stories are ephemeral and aren't tracked as PostTargets).
          const v = change.value || {};
          console.log(
            `[ig-webhook] STORY INSIGHTS ig_user=${igUserId} ` +
              `media=${v.media_id} imp=${v.impressions} reach=${v.reach} ` +
              `taps_fwd=${v.taps_forward} exits=${v.exits} replies=${v.replies}`
          );
        } else {
          console.log(`[ig-webhook] Unhandled field: ${change.field}`);
        }
      } catch (err) {
        console.error(`[ig-webhook] Error processing ${change.field} for ig_user ${igUserId}:`, err);
      }
    }
  }
}
