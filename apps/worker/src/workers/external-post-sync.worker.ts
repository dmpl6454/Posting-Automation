import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import {
  QUEUE_NAMES,
  type ExternalPostSyncJobData,
  createRedisConnection,
} from "@postautomation/queue";
import {
  classifyPosts,
  targetsNeedingVideoResolution,
  type PublishedTargetLike,
} from "../lib/external-post-dedup";
import { deriveInsightsHealth, mergeInsightsHealth } from "../lib/channel-insights-health";

/**
 * Ingests posts that exist ON a connected account — including ones published directly on
 * the platform — so Insights reflects the whole account, not just what we sent.
 *
 * Why this matters (measured on prod 2026-08-06): reachable Pages average 17.7 posts since
 * 2026-08-01, while Pages we publish through average 3.7. Roughly 5x the activity was
 * invisible.
 *
 * Shape
 * ─────
 * ONE job per ACCOUNT (not per channel row): 1339 prod channel rows collapse to 524
 * distinct platformIds. The job lists posts once, then fans the rows out to every channel
 * sharing that account, so each org sees its own copy through the ordinary
 * `-> Channel -> organizationId` join that every Insights query already uses.
 *
 * Cost control
 * ────────────
 * - Listing and metric capture are SEPARATE passes. Listing is cheap and always runs;
 *   metrics are fetched only for posts that need them, newest first, hard-capped per run.
 * - `metricsSyncedAt = NULL` means "listed but never measured" ⇒ the read paths render
 *   "—", never a fake 0. A post therefore appears in Insights immediately and gains
 *   numbers on a later pass.
 * - Metrics decay: a post is re-measured only if it is young or its last capture is stale,
 *   so steady-state cost stays flat as the corpus grows.
 */

/** Never list posts older than this — the product floor for this feature. */
const HARD_FLOOR = new Date("2026-08-01T00:00:00.000Z");

/**
 * Max posts whose metrics we capture in ONE job. Bounds Graph + CPU per run.
 * Metrics accrue across runs (a post keeps `metricsSyncedAt = NULL` and renders "—" until
 * measured), so this throttles cost without ever losing a post.
 */
const METRICS_PER_RUN = Number(process.env.EXTERNAL_METRICS_PER_RUN ?? 60);

/**
 * Max listing pages per job, 100 posts/page.
 *
 * ⚠️ This was 4 pages x limit 25 = exactly 100 posts, which made EVERY busy channel
 * report "Posts: 100" — a cap masquerading as a count (observed in prod 2026-08-07:
 * ten channels all showing precisely 100). Listing is the CHEAP half of the sync (one
 * call per 100 posts vs two calls per post for metrics), so paging deeper costs little:
 * 12 x 100 = up to 1,200 posts/run for ~12 calls.
 *
 * A channel busier than that still converges — `since` is pinned to the watermark floor
 * and each run re-lists from the start, so the newest posts are always covered and the
 * cap only defers the long tail.
 */
const MAX_LIST_PAGES = Number(process.env.EXTERNAL_LIST_PAGES ?? 12);
const LIST_PAGE_SIZE = Number(process.env.EXTERNAL_LIST_PAGE_SIZE ?? 100);

/**
 * Re-measure cadence. A post's metrics move fast early then plateau, so spend the budget
 * on young posts instead of re-reading month-old ones every cycle.
 */
function needsMetrics(publishedAt: Date, metricsSyncedAt: Date | null, now: Date): boolean {
  if (!metricsSyncedAt) return true; // never measured — highest priority
  const ageH = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  const sinceH = (now.getTime() - metricsSyncedAt.getTime()) / 3_600_000;
  if (ageH <= 48) return sinceH >= 6; // fresh post: refresh often
  if (ageH <= 24 * 7) return sinceH >= 24; // first week: daily
  return sinceH >= 24 * 7; // older: weekly
}

export function createExternalPostSyncWorker() {
  const worker = new Worker<ExternalPostSyncJobData>(
    QUEUE_NAMES.EXTERNAL_POST_SYNC,
    async (job: Job<ExternalPostSyncJobData>) => {
      const { platform, platformId, candidateChannelIds, targetChannelIds } = job.data;
      const since = new Date(job.data.since);
      const windowStart = since > HARD_FLOOR ? since : HARD_FLOOR;
      const now = new Date();

      const provider: any = getSocialProvider(platform as any);
      if (typeof provider?.listRecentPosts !== "function") {
        console.warn(`[ExternalSync] ${platform} has no listRecentPosts — skipping`);
        return null;
      }

      // ── 1. Pick a working token. Candidates are pre-ranked (healthiest first).
      //    ⚠️ Only DIRECT channel.findUnique auto-decrypts accessToken; reading a channel
      //    through a relation yields "enc:v1:" ciphertext and every Graph call 400s.
      let listing: any = null;
      let usedChannelId: string | null = null;
      let lastDegraded: any;

      for (const channelId of candidateChannelIds) {
        const channel = await prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel || channel.disconnectedAt) continue;

        const tokens = {
          accessToken: channel.accessToken,
          refreshToken: channel.refreshToken ?? undefined,
          metadata: (channel.metadata ?? undefined) as Record<string, unknown> | undefined,
        };
        // IG posts are addressed by the IG user id, which is stored in metadata.
        const accountId =
          platform === "INSTAGRAM"
            ? ((channel.metadata as any)?.igUserId ?? platformId)
            : platformId;

        const page = await provider.listRecentPosts(tokens, accountId, {
          since: windowStart,
          limit: LIST_PAGE_SIZE,
        });

        if (page?.degraded) {
          lastDegraded = page.degraded;
          // Record the verdict against the channel we actually tried, so the reconnect
          // banner names a real channel rather than a whole account.
          await writeHealth(channelId, channel.metadata, page.degraded, now);
          continue; // fall through to the next candidate token
        }

        listing = { page, tokens, accountId, channel };
        usedChannelId = channelId;
        // A successful listing is positive evidence this channel is healthy.
        await writeHealth(channelId, channel.metadata, undefined, now);
        break;
      }

      if (!listing) {
        console.warn(
          `[ExternalSync] ${platform}:${platformId} — no working token among ${candidateChannelIds.length} candidate(s)` +
            (lastDegraded ? ` (${lastDegraded.reason})` : "")
        );
        return { listed: 0, reachable: false };
      }

      // ── 2. Page through the listing (bounded).
      const listed: Array<{
        platformPostId: string;
        publishedAt: Date;
        permalink?: string;
        message?: string;
        mediaType?: string;
        productType?: string;
      }> = [...listing.page.posts];
      let cursor = listing.page.nextCursor;
      for (let i = 1; i < MAX_LIST_PAGES && cursor; i++) {
        const next = await provider.listRecentPosts(listing.tokens, listing.accountId, {
          since: windowStart,
          limit: LIST_PAGE_SIZE,
          cursor,
        });
        if (next?.degraded || !next?.posts?.length) break;
        listed.push(...next.posts);
        cursor = next.nextCursor;
      }
      if (cursor) {
        console.log(`[ExternalSync] ${platform}:${platformId} — listing capped at ${MAX_LIST_PAGES} pages`);
      }
      if (!listed.length) return { listed: 0, reachable: true };

      // ── 3. Dedup against posts WE published, across ALL channel rows for this account.
      const targets = await prisma.postTarget.findMany({
        where: {
          channelId: { in: targetChannelIds },
          status: "PUBLISHED",
          publishedId: { not: null },
          publishedAt: { gte: windowStart },
        },
        select: { id: true, publishedId: true, channelId: true, metadata: true },
      });

      const targetLike: PublishedTargetLike[] = targets.map((t) => ({
        id: t.id,
        publishedId: t.publishedId,
        resolvedPostId: (t.metadata as any)?.resolvedPostId ?? null,
      }));

      // Resolve bare FB Video-node ids -> "{pageId}_{post_id}". Without this a video we
      // published is never matched and would double-count. Bounded per run.
      if (platform === "FACEBOOK" && typeof provider.resolveVideoPostId === "function") {
        const listedIds = new Set(listed.map((p) => p.platformPostId));
        const need = targetsNeedingVideoResolution(targetLike, listedIds, platformId, 10);
        for (const t of need) {
          const resolved = await provider.resolveVideoPostId(listing.tokens, t.publishedId!, platformId);
          if (!resolved) continue;
          t.resolvedPostId = resolved;
          // Persist so the call is never repeated for this target.
          const row = targets.find((x) => x.id === t.id);
          await prisma.postTarget.update({
            where: { id: t.id },
            data: {
              metadata: { ...((row?.metadata as any) ?? {}), resolvedPostId: resolved },
            },
          }).catch(() => undefined);
        }
      }

      const classified = classifyPosts(listed, targetLike, platformId);
      const targetIdByPost = new Map(classified.map((c) => [c.platformPostId, c.postTargetId]));

      // ── 4. Fan out: upsert one row per (channel, post) for EVERY channel on this
      //    account, so each org sees it through its own channel.
      const bySummary = new Map(listed.map((p) => [p.platformPostId, p]));
      for (const channelId of targetChannelIds) {
        for (const p of listed) {
          const summary = bySummary.get(p.platformPostId)!;
          await prisma.externalPost.upsert({
            where: { channelId_platformPostId: { channelId, platformPostId: p.platformPostId } },
            // Metrics are deliberately NOT written here — an insert with metricsSyncedAt
            // NULL renders "—" everywhere, never a fake 0.
            create: {
              channelId,
              platform: platform as any,
              platformPostId: p.platformPostId,
              publishedAt: summary.publishedAt,
              permalink: summary.permalink ?? null,
              message: summary.message ?? null,
              mediaType: summary.mediaType ?? null,
              productType: summary.productType ?? null,
              postTargetId: targetIdByPost.get(p.platformPostId) ?? null,
            },
            update: {
              // Re-classify on every pass: a post may be matched to its PostTarget only
              // after a later video-id resolution.
              postTargetId: targetIdByPost.get(p.platformPostId) ?? null,
              permalink: summary.permalink ?? null,
              mediaType: summary.mediaType ?? null,
              productType: summary.productType ?? null,
            },
          });
        }
      }

      // ── 5. Metrics pass — ONE capture per platform post, then copy to every channel row.
      //    Reading once per account (not once per org) is what keeps this affordable.
      const canonicalChannelId = usedChannelId!;
      const due = await prisma.externalPost.findMany({
        where: { channelId: canonicalChannelId, publishedAt: { gte: windowStart } },
        orderBy: { publishedAt: "desc" },
        select: { platformPostId: true, publishedAt: true, metricsSyncedAt: true, productType: true },
      });

      const toMeasure = due.filter((p) => needsMetrics(p.publishedAt, p.metricsSyncedAt, now)).slice(0, METRICS_PER_RUN);
      let measured = 0;

      for (const p of toMeasure) {
        let analytics: any = null;
        try {
          analytics = await provider.getPostAnalytics(listing.tokens, p.platformPostId);
        } catch (err: any) {
          console.warn(`[ExternalSync] metrics failed ${p.platformPostId}: ${err.message}`);
          continue;
        }
        if (!analytics) continue;

        // ⚠️ metricsAvailable must be stored EXACTLY as the provider declared it. An
        // omitted key reads as AVAILABLE downstream, so dropping this makes a metric we
        // were never allowed to read display as a confident 0.
        const metricData = {
          impressions: analytics.impressions ?? 0,
          clicks: analytics.clicks ?? 0,
          likes: analytics.likes ?? 0,
          comments: analytics.comments ?? 0,
          shares: analytics.shares ?? 0,
          reach: analytics.reach ?? 0,
          metricsAvailable: (analytics.metricsAvailable ?? null) as any,
          metricsSource: analytics.source ?? "api",
          degraded: (analytics.degraded ?? null) as any,
          metricsSyncedAt: new Date(),
        };

        await prisma.externalPost.updateMany({
          where: { channelId: { in: targetChannelIds }, platformPostId: p.platformPostId },
          data: metricData,
        });
        measured++;
      }

      console.log(
        `[ExternalSync] ${platform}:${platformId} listed=${listed.length} channels=${targetChannelIds.length} measured=${measured}`
      );
      return { listed: listed.length, measured, reachable: true };
    },
    {
      connection: createRedisConnection(),
      // Deliberately low: this box is a 4-core Linode shared with Postgres and MinIO, and
      // this work is never user-facing. Meta is NOT the constraint — per-page Business
      // Use Case quota measured at 1% after a real listing call.
      concurrency: Number(process.env.EXTERNAL_SYNC_CONCURRENCY ?? 2),
      limiter: { max: 4, duration: 1000 },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[ExternalSync] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

/**
 * Record whether this channel can serve Insights, reusing the existing verdict logic so
 * the reconnect banner covers external sync too. Best-effort — a health write must never
 * fail a sync job.
 */
async function writeHealth(
  channelId: string,
  metadata: unknown,
  degraded: { reason: string; missingScopes?: string[]; detail?: string } | undefined,
  now: Date
): Promise<void> {
  try {
    const health = deriveInsightsHealth(degraded ?? undefined, now);
    const merged = mergeInsightsHealth(metadata, health, now);
    if (merged) {
      await prisma.channel.update({ where: { id: channelId }, data: { metadata: merged as any } });
    }
  } catch (err: any) {
    console.warn(`[ExternalSync] health write failed for ${channelId}: ${err.message}`);
  }
}
