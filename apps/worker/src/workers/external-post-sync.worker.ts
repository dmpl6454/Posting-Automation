import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  getSocialProvider,
  isFacebookVideoLike,
  type ExternalPostSummary,
} from "@postautomation/social";
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
import { stepScrapeBudget, shouldDeferUnmeasured } from "../lib/scrape-budget";

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
 * Max posts whose metrics we capture in ONE job.
 *
 * Unlike the listing, this one is a genuine throttle — metrics cost TWO Graph calls per
 * post, so measuring 5,000 posts in one run would be 10,000 calls on a 4-core box.
 *
 * It is safe to throttle here precisely BECAUSE an unmeasured post is never misreported:
 * it keeps `metricsSyncedAt = NULL`, renders "—" (not a fake 0), and contributes to
 * NEITHER side of the engagement-rate ratio. So the post COUNT is always complete and
 * truthful immediately, while the numbers fill in over subsequent passes, newest first.
 * A cap that changes a displayed value is a bug; a cap that only defers one is a budget.
 */
const METRICS_PER_RUN = Number(process.env.EXTERNAL_METRICS_PER_RUN ?? 150);

/**
 * Reel-scrape budget, SEPARATE from METRICS_PER_RUN.
 *
 * A scrape costs ~2.1s of wall time (measured on prod: 50/50 success, avg
 * 2130ms) against ~0.3s for a Graph call, on a 4-core box shared with Postgres
 * and MinIO. This is a budget that DEFERS a value — an unscraped post keeps
 * `metricsSyncedAt = NULL`, renders "—" (never a fake 0), and stays at the front
 * of the next run's queue — which is what makes it safe.
 *
 * ⚠️ `EXTERNAL_VIEW_SCRAPE_ENABLED` defaults ON because the failure mode is
 * fail-open: a blocked IP degrades to exactly today's behavior (impressions
 * declared false ⇒ "—"), never to a wrong number. Ship it `false` in .env.prod
 * and flip it after the canary.
 */
const SCRAPE_PER_RUN = Number(process.env.EXTERNAL_SCRAPE_PER_RUN ?? 40);
const SCRAPE_ENABLED = process.env.EXTERNAL_VIEW_SCRAPE_ENABLED !== "false";
/** Consecutive misses that trip the per-run circuit breaker (soft IP ban). */
const SCRAPE_BREAKER_MISSES = Number(process.env.EXTERNAL_SCRAPE_BREAKER_MISSES ?? 5);

/**
 * Listing runs to EXHAUSTION — it pages until Meta stops returning a cursor.
 *
 * ⚠️ There must be NO cap that silently truncates a channel's post count. The first
 * version used 4 pages x limit 25 = exactly 100, and every busy channel reported
 * "Posts: 100" — a cap masquerading as a count (observed in prod 2026-08-07: ten
 * different channels all showing precisely 100). A displayed number must be the truth,
 * not a ceiling.
 *
 * Affordable because listing is the CHEAP half of the sync: ONE call returns 100 posts,
 * versus TWO calls per post for metrics. Even a 5,000-post channel costs 50 listing
 * calls, ~1% of a Page's Business-Use-Case budget (measured `call_count: 1` after a real
 * listing call). The window is also bounded at 2026-08-01, so this is not "all history".
 *
 * LIST_PAGE_HARD_STOP is a RUNAWAY GUARD, not a product cap — it only trips on a
 * pathological account (>500k posts in the window) or a Graph cursor that fails to
 * terminate. Reaching it is logged loudly as an anomaly, never silently.
 */
const LIST_PAGE_SIZE = Number(process.env.EXTERNAL_LIST_PAGE_SIZE ?? 100);
const LIST_PAGE_HARD_STOP = Number(process.env.EXTERNAL_LIST_PAGE_HARD_STOP ?? 5000);

/**
 * One-shot backfill floor. Any capture taken BEFORE this instant is eligible for
 * re-measurement regardless of the decay cadence below.
 *
 * This is the entire backfill mechanism — no new job, no new column, no new state
 * to reconcile. `metricsSyncedAt` is already the progress marker: a re-measured
 * row moves past the floor and stops matching, so the sweep converges
 * monotonically and is safe to re-run or interrupt.
 *
 * Set it to the deploy time of a capability change (e.g. the media-view metrics)
 * so existing rows pick up newly-available metrics instead of waiting out the
 * weekly decay. UNSET IT once the sweep is clean, or every run re-measures
 * everything forever.
 *
 * Invalid/absent values disable the floor rather than throwing — a malformed env
 * var must not take the sync down.
 */
const RECAPTURE_BEFORE = (() => {
  const raw = process.env.EXTERNAL_RECAPTURE_BEFORE;
  if (!raw) return null;
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) {
    console.warn(`[ExternalSync] ignoring unparseable EXTERNAL_RECAPTURE_BEFORE=${JSON.stringify(raw)}`);
    return null;
  }
  console.log(`[ExternalSync] recapture floor active: re-measuring captures older than ${t.toISOString()}`);
  return t;
})();

/**
 * Re-measure cadence. A post's metrics move fast early then plateau, so spend the budget
 * on young posts instead of re-reading month-old ones every cycle.
 */
export function needsMetrics(
  publishedAt: Date,
  metricsSyncedAt: Date | null,
  now: Date,
  recaptureBefore: Date | null = RECAPTURE_BEFORE
): boolean {
  if (!metricsSyncedAt) return true; // never measured — highest priority
  // Backfill floor wins over the decay cadence: a capture taken before a
  // capability change is stale in a way its AGE cannot express.
  if (recaptureBefore && metricsSyncedAt < recaptureBefore) return true;
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
        // 🔴 Deliberately NO positive health write here.
        //
        // `listRecentPosts` hits /{page}/published_posts, which needs NONE of the
        // three insight scopes (read_insights / pages_read_user_content /
        // instagram_manage_insights). So a channel that cannot read a single
        // insight still lists posts fine — and stamping `insightsHealth: ok` from
        // that success cleared the reconnect banner every 2 hours, for exactly the
        // channels that most needed it.
        //
        // Worse, `healthVerdictChanged` returns false for a repeated identical
        // `needs_reconnect`, so `checkedAt` never refreshed while the condition
        // persisted — the verdict could be cleared by a listing but not re-armed
        // by an unchanged failure.
        //
        // A positive verdict is written ONLY from the metrics pass below, which
        // actually exercises the insight edges. A negative verdict from listing
        // (the `page.degraded` branch above) is still recorded, because a failed
        // LISTING is real evidence of a broken token.
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
      // Typed from the provider's own summary so new fields (videoId/isReel)
      // flow through automatically — a hand-copied shape here silently drops
      // them, which is exactly what happened when the video id was added.
      const listed: ExternalPostSummary[] = [...listing.page.posts];
      // Page to EXHAUSTION — stop only when Meta stops handing back a cursor. Guard
      // against a non-terminating cursor with a seen-set (a repeated cursor means the
      // API is looping) plus a runaway ceiling.
      let cursor = listing.page.nextCursor;
      const seenCursors = new Set<string>();
      let pages = 1;
      while (cursor && pages < LIST_PAGE_HARD_STOP) {
        if (seenCursors.has(cursor)) {
          console.warn(`[ExternalSync] ${platform}:${platformId} — cursor repeated, stopping to avoid a loop`);
          break;
        }
        seenCursors.add(cursor);

        const next = await provider.listRecentPosts(listing.tokens, listing.accountId, {
          since: windowStart,
          limit: LIST_PAGE_SIZE,
          cursor,
        });
        if (next?.degraded || !next?.posts?.length) break;
        listed.push(...next.posts);
        cursor = next.nextCursor;
        pages++;
      }
      if (cursor) {
        // Only reachable on a pathological account. Loud, because a truncated count is
        // exactly the "cap displayed as a count" failure this design exists to prevent.
        console.error(
          `[ExternalSync] ⚠️ ${platform}:${platformId} — hit the ${LIST_PAGE_HARD_STOP}-page RUNAWAY GUARD after ${listed.length} posts; the count for this channel is INCOMPLETE`
        );
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
              ...(summary.videoId
                ? { resolvedVideoId: summary.videoId, videoResolvedAt: new Date() }
                : {}),
              ...(summary.isReel ? { isReel: true } : {}),
            },
            update: {
              // Re-classify on every pass: a post may be matched to its PostTarget only
              // after a later video-id resolution.
              postTargetId: targetIdByPost.get(p.platformPostId) ?? null,
              permalink: summary.permalink ?? null,
              // ⚠️ Only write these when the listing actually supplied them.
              // The old unconditional `?? null` let ONE attachment-less listing
              // response null a known-video row, permanently demoting it out of
              // the video-recovery path.
              ...(summary.mediaType ? { mediaType: summary.mediaType } : {}),
              ...(summary.productType ? { productType: summary.productType } : {}),
              ...(summary.videoId
                ? { resolvedVideoId: summary.videoId, videoResolvedAt: new Date() }
                : {}),
              ...(summary.isReel ? { isReel: true } : {}),
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
        select: {
          platformPostId: true,
          publishedAt: true,
          metricsSyncedAt: true,
          productType: true,
          mediaType: true,
          permalink: true,
          resolvedVideoId: true,
          isReel: true,
          postTargetId: true,
        },
      });

      // Newest-first within each bucket, but NON-VIDEO posts are measured first.
      //
      // Why: a video row usually already carries a recovered view count, while a
      // photo/album/status/link row has NOTHING (measured on prod 2026-08-11:
      // 2,672 non-video FB rows, zero with impressions). Non-video captures are
      // also strictly cheaper — no video-node fetch, no scrape, no scrape budget —
      // so front-loading them converts the most "—" cells per unit of budget.
      // METRICS_PER_RUN still caps the run; this only reorders within the cap, and
      // an unmeasured row keeps metricsSyncedAt NULL so it stays at the front of
      // the next run (a cap that DEFERS a value, never one that changes it).
      // ⚠️ Bucket with isFacebookVideoLike — never a bare mediaType equality
      // check. mediaType carries two Meta vocabularies (media_type ∪
      // status_type), so comparing it to the single literal "video" silently
      // treats `added_video` as non-video and would spend the cheap front of the
      // budget on real videos. external-video-budget.test.ts forbids that
      // comparison at the source level and caught exactly this mistake here.
      const eligible = due.filter((p) => needsMetrics(p.publishedAt, p.metricsSyncedAt, now));
      const videoLikeRow = (p: (typeof eligible)[number]) =>
        isFacebookVideoLike({
          mediaType: p.mediaType,
          permalink: p.permalink,
          videoId: p.resolvedVideoId,
        }) || p.productType === "REELS";
      const toMeasure = [
        ...eligible.filter((p) => !videoLikeRow(p)),
        ...eligible.filter((p) => videoLikeRow(p)),
      ].slice(0, METRICS_PER_RUN);
      let measured = 0;
      // Scrape budget for this run. Separate from METRICS_PER_RUN because a
      // scrape costs ~2.1s of wall time (measured) against ~0.3s for a Graph
      // call, and the box is 4 cores shared with Postgres and MinIO.
      let scrapeBudget = SCRAPE_ENABLED ? SCRAPE_PER_RUN : 0;
      let consecutiveScrapeMisses = 0;
      // Insights health, derived from the METRICS pass rather than the listing.
      //   undefined = no capture ran, so we learned nothing -> write nothing
      //   null      = at least one clean capture -> healthy
      //   object    = every capture degraded -> that verdict
      // Leaving it `undefined` when nothing was measured is deliberate: silence is
      // "no new evidence", which must not overwrite a standing verdict either way.
      let insightVerdict: { reason: string; missingScopes?: string[]; detail?: string } | null | undefined;

      for (const p of toMeasure) {
        // Only FACEBOOK posts that could carry a view count take the recovery
        // path. `postTargetId != null` rows are app-published and are read
        // through PostTarget, so scraping them is pure waste.
        const videoLike =
          platform === "FACEBOOK" &&
          p.postTargetId === null &&
          isFacebookVideoLike({
            mediaType: p.mediaType,
            permalink: p.permalink,
            videoId: p.resolvedVideoId,
          });

        // This row needs a view count that only the Video node or the scraper
        // could historically supply.
        //
        // ⚠️ Do NOT skip it up-front when the scrape budget is gone. That guard
        // predates FB_MEDIA_VIEW_METRICS_ENABLED: the feed capture now usually
        // carries a real `post_media_view` number, so skipping would throw away
        // a good measurement to protect a fallback that is no longer needed.
        // The deferral it existed for is preserved below — after the capture,
        // where we can see whether anything usable actually came back.
        const wantsScrape = videoLike && (p.isReel === true || !p.resolvedVideoId);
        const scrapeAllowed = scrapeBudget > 0;

        let analytics: any = null;
        try {
          analytics = videoLike
            ? await provider.getExternalPostAnalytics(listing.tokens, p.platformPostId, {
                pageId: platformId,
                videoId: p.resolvedVideoId,
                isReel: p.isReel === true,
                allowScrape: scrapeAllowed,
              })
            : await provider.getPostAnalytics(listing.tokens, p.platformPostId);
        } catch (err: any) {
          console.warn(`[ExternalSync] metrics failed ${p.platformPostId}: ${err.message}`);
          continue;
        }
        if (!analytics) continue;

        // 🔴 Budget and breaker accounting keys off whether a scrape ACTUALLY
        // RAN — never off `source !== "scrape"`, which is also what a clean API
        // success looks like.
        //
        // That conflation stalled the pipeline: when the media-view metrics went
        // live (2026-08-11 11:35 UTC) the provider began returning early with
        // `source: "api"` whenever `post_media_view` yielded a positive count, so
        // five consecutive SUCCESSES tripped the 5-miss breaker, zeroed the
        // budget, and the old up-front guard then skipped every remaining reel in
        // the account. Scrape-sourced captures went 1,824/h → 0 inside the hour
        // and 94.3% of FB reels went unmeasured, with the backlog growing daily.
        const step = stepScrapeBudget(
          { budget: scrapeBudget, consecutiveMisses: consecutiveScrapeMisses },
          analytics,
          SCRAPE_BREAKER_MISSES
        );
        scrapeBudget = step.budget;
        consecutiveScrapeMisses = step.consecutiveMisses;
        if (step.tripped) {
          console.warn(
            `[ExternalSync] ${platform}:${platformId} — ${step.consecutiveMisses} consecutive scrape misses, stopping scrapes for this run`
          );
        }

        // The deferral the old up-front `continue` protected, now applied where
        // it can be decided on evidence: only leave the row unmeasured when it
        // WANTED a view count, no scrape was available to fetch one, AND the API
        // supplied none either. Stamping metricsSyncedAt on a valueless capture
        // would hide the post behind needsMetrics for up to a week; leaving it
        // keeps it at the front of the next run (a cap that DEFERS a value,
        // never one that changes it).
        if (
          shouldDeferUnmeasured(
            wantsScrape,
            scrapeAllowed,
            analytics.metricsAvailable?.impressions
          )
        ) {
          continue;
        }

        // Health evidence from a call that ACTUALLY exercised the insight edges.
        // The listing pass deliberately writes no positive verdict (it needs none
        // of the insight scopes), so this is the only place a channel can be
        // declared healthy. First capture wins for the negative case; a single
        // clean capture proves the scopes work.
        if (insightVerdict === undefined) {
          insightVerdict = analytics.degraded ?? null;
        } else if (insightVerdict !== null && !analytics.degraded) {
          insightVerdict = null; // a later clean capture clears an earlier failure
        }

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

      // Write the insights verdict ONCE per run, from real insight-edge evidence.
      // `undefined` (nothing measured) writes nothing — see the declaration above.
      if (insightVerdict !== undefined && usedChannelId) {
        await writeHealth(usedChannelId, listing.channel.metadata, insightVerdict ?? undefined, now);
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
