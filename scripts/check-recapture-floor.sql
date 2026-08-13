-- Is EXTERNAL_RECAPTURE_BEFORE safe to unset yet?
--
-- Usage (from the repo root, against prod):
--   ssh posting-automation "docker exec -i postautomation-postgres-1 \
--     psql -U postautomation postautomation" < scripts/check-recapture-floor.sql
--
-- Replace :FLOOR below with the CURRENT value of EXTERNAL_RECAPTURE_BEFORE, read from
--   ssh posting-automation 'docker exec postautomation-worker-1 env | grep EXTERNAL_RECAPTURE_BEFORE'
-- (psql has no access to the container env, so this cannot be derived automatically.)
--
-- ⚠️ THREE THINGS THIS SCRIPT EXISTS TO STOP YOU GETTING WRONG. All three were got
-- wrong during the 2026-08-13 backfill:
--
--   1. COUNT POSTS, NOT ROWS. EXTERNAL_METRICS_PER_RUN is denominated in POSTS and
--      applied per ACCOUNT, but ExternalPost rows are fanned out to every channel
--      sharing that account ("fetch per ACCOUNT, store per CHANNEL"). Measured
--      fan-out was exactly 4.00-5.00, so a row count overstates the remaining work
--      by that factor and inflates any ETA ~5x.
--
--   2. COMPLETION IS PER-ACCOUNT, NOT AGGREGATE. An account sits in exactly ONE
--      shard, and its shard comes round once per full cycle
--      (EXTERNAL_SYNC_SHARDS x 2h). The finish line is therefore set by
--      max(due_posts) over accounts, not by the total.
--
--   3. THE FLOOR HAS NO PLATFORM PREDICATE. It re-measures every platform, so a
--      floor set to chase one platform's metric generates work everywhere. Check
--      the TARGET platform for completion, and unset promptly -- the rest is waste
--      that competes for the same worker concurrency.
--
-- A separate reason a video row can legitimately never gain views: post_video_views
-- is VIDEO-ONLY and a measured 0 is deliberately suppressed, so judge FB views
-- coverage against a video-only denominator and expect a ceiling near 99%, not 100%.

\set FLOOR '2026-08-13T05:37:00Z'

\echo '=== 1. Remaining work per ACCOUNT on the target platform (POSTS, the unit the cap uses) ==='
\echo '    Safe to unset when max(due_posts) is ~0. One run clears <= EXTERNAL_METRICS_PER_RUN posts.'
SELECT c.platform,
       c."platformId",
       count(DISTINCT c.id)                AS channels,
       count(*)                            AS due_rows,
       count(DISTINCT ep."platformPostId") AS due_posts
FROM "ExternalPost" ep
JOIN "Channel" c ON c.id = ep."channelId"
WHERE (ep."metricsSyncedAt" IS NULL OR ep."metricsSyncedAt" < :'FLOOR'::timestamptz)
GROUP BY 1, 2
ORDER BY due_posts DESC
LIMIT 15;

\echo ''
\echo '=== 2. Totals per platform — shows how much of the floor is work you did NOT want ==='
SELECT c.platform,
       count(*)                            AS due_rows,
       count(DISTINCT ep."platformPostId") AS due_posts,
       count(DISTINCT c."platformId")      AS accounts
FROM "ExternalPost" ep
JOIN "Channel" c ON c.id = ep."channelId"
WHERE (ep."metricsSyncedAt" IS NULL OR ep."metricsSyncedAt" < :'FLOOR'::timestamptz)
GROUP BY 1
ORDER BY due_posts DESC;

\echo ''
\echo '=== 3. FB views coverage against a VIDEO-ONLY denominator (the backfill goal) ==='
\echo '    Non-video rows are 0 BY DESIGN: post_video_views is video-only, and a 0 is suppressed.'
\echo '    Ceiling is ~99%, not 100% — a genuinely 0-view video renders as unknown.'
SELECT (ep."isReel" IS TRUE OR ep."mediaType" IN ('video','added_video')) AS video_like,
       count(*)                                        AS rows,
       count(*) FILTER (WHERE ep.views IS NOT NULL)     AS with_views,
       round(100.0 * count(*) FILTER (WHERE ep.views IS NOT NULL)
             / NULLIF(count(*), 0), 1)                  AS pct
FROM "ExternalPost" ep
JOIN "Channel" c ON c.id = ep."channelId"
WHERE c.platform = 'FACEBOOK' AND ep."publishedAt" >= '2026-08-01'
GROUP BY 1
ORDER BY 1;

\echo ''
\echo '=== 4. Sanity: separate BACKLOG from CEILING ==='
\echo '    Of rows ALREADY swept since the floor, what share gained views? That is the real'
\echo '    ceiling. Raw "% with views" conflates not-yet-swept with genuinely-no-view-count'
\echo '    and read as 63% when the true ceiling was 99.4%.'
SELECT count(*)                                    AS swept_video_rows,
       count(*) FILTER (WHERE ep.views IS NOT NULL) AS got_views,
       round(100.0 * count(*) FILTER (WHERE ep.views IS NOT NULL)
             / NULLIF(count(*), 0), 1)              AS pct
FROM "ExternalPost" ep
JOIN "Channel" c ON c.id = ep."channelId"
WHERE c.platform = 'FACEBOOK'
  AND ep."publishedAt" >= '2026-08-01'
  AND (ep."isReel" IS TRUE OR ep."mediaType" IN ('video','added_video'))
  AND ep."metricsSyncedAt" >= :'FLOOR'::timestamptz;