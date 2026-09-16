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
 *  - Meta platforms (FACEBOOK/INSTAGRAM/THREADS) — 10s. This is an OWNER-POLICY
 *    default, not a documented Meta limit. Meta's published limits are
 *    per-ACCOUNT / per-PAGE (the Business Use Case rate limits on
 *    developers.facebook.com → Graph API → rate limiting, and the per-account
 *    24-hour cap in the Instagram content-publishing docs), so spacing posts
 *    to DIFFERENT accounts is not required by any documented quota. The
 *    residual risk it guards is Meta's UNDISCLOSED spam classifiers (FB error
 *    368 throttles can last hours), which a burst of near-identical posts from
 *    one app could trip.
 *  - TWITTER bills every post to the operator's shared X app — 10s.
 *  - Other OAuth platforms (LINKEDIN/YOUTUBE/etc.) rate-limit per app but far
 *    less aggressively — 5s.
 *  - Token-based platforms (TELEGRAM/DISCORD/BLUESKY/...) rate-limit per
 *    bot/webhook/account, so cross-channel spacing barely matters — 2s.
 *
 * TUNABLE PER PLATFORM (2026-09-16): `PUBLISH_STAGGER_<PLATFORM>_MS`, e.g.
 * `PUBLISH_STAGGER_INSTAGRAM_MS=5000`. Measured on prod the same day, a ~53
 * channel Instagram video fan-out tails out ~9 minutes on the 10s spacing
 * alone, so the owner wants a lever that needs no code change. The table below
 * stays the default; an override is read at CALL time, parsed strictly
 * (digits only) and clamped to [1s, 60s]. Anything unparseable falls back to
 * the table default — never to 0, which would stack every same-platform
 * target onto the same instant.
 *
 * ⚠️ BOTH containers compute these delays: the WEB container when
 * post.create / post.update enqueue the delayed jobs at save time, and the
 * WORKER in the 30s reconciliation cron (plus autopilot agent runs). An
 * override must therefore be plumbed into BOTH services' `environment:`
 * allowlists in docker-compose.prod.yml, or the two will space the same post
 * differently (harmless for correctness — the jobIds carry no delay, so
 * whichever producer enqueues first wins — but the setting would only half
 * apply).
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

/** Bounds for an env override. The floor keeps same-platform targets apart. */
export const STAGGER_OVERRIDE_MIN_MS = 1_000;
export const STAGGER_OVERRIDE_MAX_MS = 60_000;

type StaggerEnv = Readonly<Record<string, string | undefined>>;

/** Env key that overrides one platform's spacing, e.g. PUBLISH_STAGGER_INSTAGRAM_MS. */
export function staggerEnvKey(platform: string): string {
  return `PUBLISH_STAGGER_${platform}_MS`;
}

/**
 * The spacing (ms) between consecutive same-platform targets: the env override
 * when it is a plain non-negative integer (clamped to
 * [STAGGER_OVERRIDE_MIN_MS, STAGGER_OVERRIDE_MAX_MS]), otherwise the table
 * default. `""` is the common "unset" shape here — compose's explicit
 * `environment:` allowlist delivers `${KEY:-}` as an empty string — so it must
 * mean "use the default", not 0.
 */
export function resolvePlatformStaggerMs(platform: string, env: StaggerEnv = process.env): number {
  // hasOwnProperty, not a bare index: `platform` arrives from job data, and a
  // bare lookup of "constructor"/"__proto__" would return an Object.prototype
  // member instead of falling through to the default.
  const base = Object.prototype.hasOwnProperty.call(PLATFORM_STAGGER_MS, platform)
    ? PLATFORM_STAGGER_MS[platform]!
    : DEFAULT_STAGGER_MS;
  const raw = env[staggerEnvKey(platform)];
  // Strict: digits only. Rejects "", " 5000", "5s", "-5", "1e4", "5000.5".
  if (raw === undefined || !/^\d+$/.test(raw)) return base;
  // A digits-only string is never NaN; at worst it overflows to Infinity,
  // which the clamp turns into the ceiling.
  return Math.min(STAGGER_OVERRIDE_MAX_MS, Math.max(STAGGER_OVERRIDE_MIN_MS, Number(raw)));
}

/**
 * Per-target enqueue delays (ms), staggered within each platform group only.
 * Returns one delay per input target, in input order. No clock, no I/O; the
 * only outside input is the optional env (defaults to process.env) read for
 * per-platform overrides — injectable so tests never mutate process.env.
 */
export function computePublishDelays(
  targets: ReadonlyArray<{ platform: string }>,
  env: StaggerEnv = process.env
): number[] {
  const seenPerPlatform = new Map<string, number>();
  // Resolve each platform's spacing once per call, not once per target.
  const spacingPerPlatform = new Map<string, number>();
  return targets.map((t) => {
    const idx = seenPerPlatform.get(t.platform) ?? 0;
    seenPerPlatform.set(t.platform, idx + 1);
    let spacing = spacingPerPlatform.get(t.platform);
    if (spacing === undefined) {
      spacing = resolvePlatformStaggerMs(t.platform, env);
      spacingPerPlatform.set(t.platform, spacing);
    }
    return idx * spacing;
  });
}
