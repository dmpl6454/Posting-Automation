/**
 * Platform-aware publish stagger.
 *
 * The scheduled-post cron used to delay every target of a post by
 * `index * 10s` regardless of platform — a 60-channel post published its last
 * channel ~10 minutes after the first even when the channels were spread
 * across many unrelated platforms. Rate limits are (mostly) per-platform-app,
 * not global, so a TELEGRAM target never needed to wait behind 30 FACEBOOK
 * targets.
 *
 * `computePublishDelays` staggers targets ONLY within their own platform
 * group: the first target of every platform gets delay 0 (all platforms start
 * simultaneously at the scheduled time), subsequent same-platform targets are
 * spaced by that platform's stagger interval.
 *
 * Stagger intervals reflect whose quota concurrent posting actually stresses:
 *  - Meta platforms (FACEBOOK/INSTAGRAM/THREADS) share ONE Meta app quota, and
 *    FB error 368 spam throttles can last hours — keep the full 10s spacing.
 *  - TWITTER bills every post to the operator's shared X app — 10s.
 *  - Other OAuth platforms (LINKEDIN/YOUTUBE/etc.) rate-limit per app but far
 *    less aggressively — 5s.
 *  - Token-based platforms (TELEGRAM/DISCORD/BLUESKY/...) rate-limit per
 *    bot/webhook/account, so cross-channel spacing barely matters — 2s.
 */

/** Shared-app platforms where concurrent posting risks hours-long throttles. */
const STAGGER_STRICT_MS = 10_000;
/** OAuth platforms with per-app limits but generous windows. */
const STAGGER_NORMAL_MS = 5_000;
/** Token-based platforms — limits are per bot/webhook/account. */
const STAGGER_LIGHT_MS = 2_000;

export const PLATFORM_STAGGER_MS: Record<string, number> = {
  FACEBOOK: STAGGER_STRICT_MS,
  INSTAGRAM: STAGGER_STRICT_MS,
  THREADS: STAGGER_STRICT_MS,
  TWITTER: STAGGER_STRICT_MS,
  LINKEDIN: STAGGER_NORMAL_MS,
  YOUTUBE: STAGGER_NORMAL_MS,
  PINTEREST: STAGGER_NORMAL_MS,
  REDDIT: STAGGER_NORMAL_MS,
  TIKTOK: STAGGER_NORMAL_MS,
  SNAPCHAT: STAGGER_NORMAL_MS,
  SLACK: STAGGER_LIGHT_MS,
  TELEGRAM: STAGGER_LIGHT_MS,
  DISCORD: STAGGER_LIGHT_MS,
  BLUESKY: STAGGER_LIGHT_MS,
  MASTODON: STAGGER_LIGHT_MS,
  WORDPRESS: STAGGER_LIGHT_MS,
  MEDIUM: STAGGER_LIGHT_MS,
  DEVTO: STAGGER_LIGHT_MS,
};

/** Unknown/future platforms fall back to the middle tier. */
export const DEFAULT_STAGGER_MS = STAGGER_NORMAL_MS;

/**
 * Per-target enqueue delays (ms), staggered within each platform group only.
 * Returns one delay per input target, in input order. Pure — no clock, no I/O.
 */
export function computePublishDelays(
  targets: ReadonlyArray<{ platform: string }>
): number[] {
  const seenPerPlatform = new Map<string, number>();
  return targets.map((t) => {
    const idx = seenPerPlatform.get(t.platform) ?? 0;
    seenPerPlatform.set(t.platform, idx + 1);
    return idx * (PLATFORM_STAGGER_MS[t.platform] ?? DEFAULT_STAGGER_MS);
  });
}
