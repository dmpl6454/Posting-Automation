// ── X / Twitter: follower counts (anonymous guest-token GraphQL) ─────────────
//
// X's own embedded-tweet web client uses an ANONYMOUS "guest token" flow — no login:
//   1. POST /1.1/guest/activate.json with the public web-client bearer → {guest_token}.
//   2. GET the UserByScreenName GraphQL query with that bearer + x-guest-token header
//      → data.user.result.legacy.followers_count. A dead/renamed/suspended handle
//      returns {"data":{}} (HTTP 200) — the "not found" case, never a crash.
//   3. One guest token is reusable for ~150 calls — activate ONCE per batch, reuse.
//
// ⚠️⚠️ BOTH the bearer AND the GraphQL query id rotate periodically on X's side. If
// this starts failing across the board it is almost certainly NOT a code bug — re-probe
// live (twitter.com devtools → network tab) and update the two constants below.
//
// Fail-open: any miss / activation failure yields a smaller/empty map, never a throw.

import { FetchFn, ScraperOptions, resolveOptions, sleep } from "./shared";

// X's public logged-out web-client bearer (read-only, no user auth).
const TWITTER_PUBLIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// GraphQL query id for UserByScreenName. Rotates independently of the bearer.
const USER_BY_SCREEN_NAME_QUERY_ID = "G3KGOASz96M-Qu0nwmGXNg";

// Minimal feature-flag blob the endpoint expects (forgiving as long as screen_name +
// withSafetyModeUserFields are present in `variables`).
const GRAPHQL_FEATURES = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: false,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

/**
 * Pure extractor for the UserByScreenName response body (already-parsed JSON).
 * Never throws — any missing/malformed path returns null. Exported for unit tests.
 * Handles success, {"data":{}} (dead handle → null), and a soft errors[] array
 * present alongside a populated legacy.followers_count (count still extracted).
 */
export function parseTwitterFollowersResponse(json: unknown): number | null {
  if (json == null || typeof json !== "object") return null;
  const data = (json as any).data;
  if (data == null || typeof data !== "object") return null;
  const user = (data as any).user;
  if (user == null || typeof user !== "object") return null;
  const result = (user as any).result;
  if (result == null || typeof result !== "object") return null;
  const legacy = (result as any).legacy;
  if (legacy == null || typeof legacy !== "object") return null;
  const n = (legacy as any).followers_count;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function activateGuestToken(fetchImpl: FetchFn, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://api.twitter.com/1.1/guest/activate.json", {
      method: "POST",
      headers: { Authorization: `Bearer ${TWITTER_PUBLIC_BEARER}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { guest_token?: string };
    return data.guest_token ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOneHandle(handle: string, guestToken: string, fetchImpl: FetchFn, timeoutMs: number): Promise<number | null> {
  const variables = JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true });
  const features = JSON.stringify(GRAPHQL_FEATURES);
  const url =
    `https://twitter.com/i/api/graphql/${USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName` +
    `?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${TWITTER_PUBLIC_BEARER}`, "x-guest-token": guestToken },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseTwitterFollowersResponse(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve X/Twitter follower counts for a batch of handles. Fail-open: any failure
 * yields a smaller/empty map (keyed lowercased handle → count), never a throw.
 * @param opts.delayMs  polite delay between per-handle calls (default 500ms; 0 in tests)
 */
export async function fetchTwitterFollowerMap(
  handles: string[],
  opts?: ScraperOptions & { delayMs?: number },
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (handles.length === 0) return map;
  const { fetchImpl, timeoutMs, logger } = resolveOptions(opts);
  const delayMs = opts?.delayMs ?? 500;

  const guestToken = await activateGuestToken(fetchImpl, timeoutMs);
  if (!guestToken) { logger?.error("[x-scraper] guest-token activation failed — skipping run"); return map; }

  for (const handle of handles) {
    try {
      const followers = await fetchOneHandle(handle, guestToken, fetchImpl, timeoutMs);
      if (followers != null) { logger?.log(`[x-scraper] x/${handle}: ${followers}`); map.set(handle.toLowerCase(), followers); }
    } catch (e) {
      logger?.error(`[x-scraper] lookup failed for ${handle}:`, e);
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  return map;
}
