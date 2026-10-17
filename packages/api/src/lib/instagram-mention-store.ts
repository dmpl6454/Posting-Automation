import { prisma as defaultPrisma } from "@postautomation/db";
import {
  getSocialProvider,
  mentionDedupKey,
  type InstagramMentionEvent,
  type InstagramProvider,
} from "@postautomation/social";
import { metaAppChannelScope } from "./meta-app-scope";

/**
 * Persist the `mentions` events from one Instagram webhook delivery, then look
 * up what was said (2026-10-17).
 *
 * Meta does not store webhook data and has no "list my mentions" endpoint, so
 * these rows are the only record — they are written FIRST, before any Graph
 * call, and a failed detail lookup just leaves the text empty (the reply still
 * works: it needs only the ids).
 *
 * One row per CHANNEL: the same IG account may be connected in several
 * workspaces. Scoped to the Meta app whose secret signed the delivery, so a
 * holder of one app's secret cannot write rows for another app's accounts.
 *
 * NEVER throws — it runs in the webhook route's background task, and Meta
 * retries (then disables the subscription on) non-2xx responses.
 *
 * NOTE for web callers: import via
 * `@postautomation/api/src/lib/instagram-mention-store` (same bridge as
 * fb-webhook-analytics.ts).
 */

/** Detail lookups per delivery — a burst must not become a Graph storm. */
export const MENTION_DETAIL_LOOKUPS_PER_DELIVERY = 25;

export async function storeInstagramMentions(
  events: InstagramMentionEvent[],
  signingAppId: string,
  deps: { prisma?: any; provider?: Pick<InstagramProvider, "getMentionDetails"> } = {}
): Promise<{ stored: number; lookedUp: number }> {
  const prisma = deps.prisma ?? defaultPrisma;
  let stored = 0;
  let lookedUp = 0;
  if (events.length === 0) return { stored, lookedUp };

  try {
    const igUserIds = [...new Set(events.map((e) => e.igUserId))];
    // DIRECT channel.findMany — the shape that auto-decrypts accessToken.
    const channels: Array<{ id: string; organizationId: string; platformId: string; accessToken: string; metadata: unknown }> =
      await prisma.channel.findMany({
        where: {
          platform: "INSTAGRAM",
          platformId: { in: igUserIds },
          disconnectedAt: null,
          ...metaAppChannelScope("INSTAGRAM", signingAppId),
        },
        select: { id: true, organizationId: true, platformId: true, accessToken: true, metadata: true },
      });
    if (channels.length === 0) return { stored, lookedUp };

    const rows = events.flatMap((e) =>
      channels
        .filter((c) => c.platformId === e.igUserId)
        .map((c) => ({
          organizationId: c.organizationId,
          channelId: c.id,
          igUserId: e.igUserId,
          mediaId: e.mediaId,
          commentId: e.commentId,
          dedupKey: mentionDedupKey(e.mediaId, e.commentId),
        }))
    );
    if (rows.length > 0) {
      // Meta retries deliveries for up to 36h — a repeat is a no-op.
      const res = await prisma.instagramMention.createMany({ data: rows, skipDuplicates: true });
      stored = res?.count ?? 0;
    }

    // One lookup per distinct mention, using any channel for that account.
    const provider = deps.provider ?? (getSocialProvider("INSTAGRAM") as InstagramProvider);
    const seen = new Set<string>();
    for (const e of events) {
      const key = `${e.igUserId}|${mentionDedupKey(e.mediaId, e.commentId)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (lookedUp >= MENTION_DETAIL_LOOKUPS_PER_DELIVERY) break;
      const channel = channels.find((c) => c.platformId === e.igUserId);
      if (!channel) continue;
      lookedUp++;
      await fillMentionDetails(prisma, provider, channel, e.igUserId, e.mediaId, e.commentId);
    }
  } catch (err: any) {
    console.error("[ig-mentions] storing a webhook delivery failed:", err?.message ?? err);
  }
  return { stored, lookedUp };
}

/**
 * Look up one mention's text/author/link and write it to every row for that
 * account + mention (all workspaces). Never throws; a failure is recorded.
 */
export async function fillMentionDetails(
  prisma: any,
  provider: Pick<InstagramProvider, "getMentionDetails">,
  channel: { accessToken: string; metadata: unknown },
  igUserId: string,
  mediaId: string,
  commentId: string | null
): Promise<void> {
  const where = { igUserId, dedupKey: mentionDedupKey(mediaId, commentId) };
  try {
    const d = await provider.getMentionDetails(
      { accessToken: channel.accessToken, metadata: (channel.metadata ?? undefined) as any },
      igUserId,
      mediaId,
      commentId
    );
    const at = d.timestamp ? new Date(d.timestamp.replace(/\+0000$/, "Z")) : null;
    await prisma.instagramMention.updateMany({
      where,
      data: {
        text: d.text,
        username: d.username,
        permalink: d.permalink,
        mediaType: d.mediaType,
        mentionedAt: at && !Number.isNaN(at.getTime()) ? at : null,
        detailsError: null,
        detailsFetchedAt: new Date(),
      },
    });
  } catch (err: any) {
    try {
      await prisma.instagramMention.updateMany({
        where,
        data: { detailsError: String(err?.message ?? "Couldn't load this mention.").slice(0, 300), detailsFetchedAt: new Date() },
      });
    } catch {
      /* best-effort */
    }
  }
}
