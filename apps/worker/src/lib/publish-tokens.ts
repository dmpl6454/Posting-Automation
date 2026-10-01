/**
 * The tokens object the publish worker hands to provider.publishPost.
 *
 * Mastodon, self-hosted WordPress and Discord webhooks decide WHERE to send the
 * post from the channel's own stored metadata (tokens.metadata): the instance
 * URL, the site URL + kind, the webhook kind. The worker used to build
 * `{ accessToken, refreshToken }` only (2026-10-01), so:
 *  - Mastodon posted to mastodon.social with a token from another instance —
 *    that token was disclosed to a third party, and the post failed;
 *  - self-hosted WordPress took the WordPress.com path and always failed;
 *  - Discord webhooks took the bot path and always failed.
 *
 * ⚠️ The metadata comes from the CHANNEL row only, never from the merged
 * provider metadata: post.metadata is client passthrough, so a client could
 * otherwise name its own siteUrl.
 *
 * ⚠️ Only these three platforms get it, so every other provider (including the
 * frozen Facebook/Instagram publish paths) receives exactly the object it
 * received before. Their providers contact the user's own server through
 * userHostFetch (packages/social/src/utils/user-host-fetch.ts) — threading the
 * metadata without that would have switched an SSRF on.
 */
import { createHash } from "node:crypto";

export const CHANNEL_ROUTED_PLATFORMS: ReadonlySet<string> = new Set(["MASTODON", "WORDPRESS", "DISCORD"]);

export interface PublishTokens {
  accessToken: string;
  refreshToken?: string;
  metadata?: Record<string, unknown>;
}

export function buildPublishTokens(
  platform: string,
  accessToken: string,
  refreshToken: string | undefined,
  channelMetadata: unknown,
): PublishTokens {
  const tokens: PublishTokens = { accessToken, refreshToken };
  if (
    CHANNEL_ROUTED_PLATFORMS.has(platform) &&
    channelMetadata &&
    typeof channelMetadata === "object" &&
    !Array.isArray(channelMetadata)
  ) {
    tokens.metadata = channelMetadata as Record<string, unknown>;
  }
  return tokens;
}

/**
 * Mastodon's Idempotency-Key for this target: the same for every attempt at the
 * same content, so a repeat within about an hour returns the post the instance
 * already made. Changes when the content or media change, so an edited post is
 * a new post. Undefined for every other platform.
 */
export function publishIdempotencyKey(
  platform: string,
  postTargetId: string,
  content: string,
  mediaUrls: readonly string[] | undefined,
): string | undefined {
  if (platform !== "MASTODON") return undefined;
  const digest = createHash("sha256").update(JSON.stringify([content, mediaUrls ?? []])).digest("hex");
  return `pa-${postTargetId}-${digest.slice(0, 16)}`;
}
