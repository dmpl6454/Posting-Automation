-- Facebook video-view recovery (2026-08-08).
--
-- Facebook reports a post's view count ONLY on the Video/Reel node; the
-- feed-post insights edge returns post_video_views = 0 for every video
-- (measured 40/40 on prod). Persist the node id resolved during listing so the
-- lookup happens once per post rather than once per metrics pass.
--
-- All three columns are NULLABLE and additive: existing rows are unaffected and
-- read paths ignore them, so this migration is safe to apply ahead of the code.
ALTER TABLE "ExternalPost" ADD COLUMN IF NOT EXISTS "resolvedVideoId" TEXT;
ALTER TABLE "ExternalPost" ADD COLUMN IF NOT EXISTS "videoResolvedAt" TIMESTAMP(3);
ALTER TABLE "ExternalPost" ADD COLUMN IF NOT EXISTS "isReel" BOOLEAN;
