// ── Instagram: follower counts + public captions ─────────────────────────────
//
// TWO paths:
//   A) scrapeInstagramFollowers(username) — zero-key hit of Instagram's OWN public
//      web endpoint (`web_profile_info`) using the public web App-ID. No login. IG
//      rate-limits this aggressively from a datacenter IP (429/401) — the scraper
//      backs off once, then marks itself rate-limited for the rest of the batch so
//      it stops hammering. Good for a handful of accounts; not for thousands/run.
//   B) fetchPublicInstagramFollowerMap / fetchPublicInstagramCaptions — the Meta
//      Graph API `business_discovery` edge. ToS-compliant, reads ANY public
//      business/creator account by username using ONE of your OWN connected IG
//      nodes as the "requesting" node. Needs a Meta System-User token. This is the
//      durable path if you have Graph access; the scrape is the fallback if you don't.
//
// ⚠️ business_discovery is a TWO-STEP call and the field shape is a live-only gotcha:
//   Step 1: find ONE administered IG node id (me/accounts?fields=instagram_business_account)
//   Step 2: GET /{ourIgId}?fields=business_discovery.username({handle}){followers_count,…}
//   NEVER use the nested `instagram_business_account{id}` sub-selection — the live
//   Graph API returns only `{id}` for the BARE field and 500s intermittently for the
//   nested form. Always live-probe a new Graph fetcher against the real token; mocks
//   cannot catch a field-shape lie.

import {
  FetchFn, ScraperOptions, resolveOptions, sleep, FollowerResult,
} from "./shared";
import { graphFetch, GraphOptions } from "./meta-graph";

// ─────────────────────────────────────────────────────────────────────────────
// A) Zero-key public web endpoint
// ─────────────────────────────────────────────────────────────────────────────

/** Shared per-run flag so once IG rate-limits us we stop trying for the rest of the
 *  batch. Reset it between runs by constructing a fresh IgScraper (below) or calling
 *  resetInstagramRateLimit(). Module-level state mirrors the original app. */
let igRateLimited = false;
export function resetInstagramRateLimit(): void { igRateLimited = false; }

/**
 * Scrape one public IG account's follower count via `web_profile_info`.
 * Zero-key. Fail-open → null. Marks the whole run rate-limited on a 2nd 429/401 so
 * the caller stops hammering (call resetInstagramRateLimit() before a new batch).
 *
 * @param opts.backoffMs  delay after the first 429/401 before one retry (default 30s)
 */
export async function scrapeInstagramFollowers(
  username: string,
  opts?: ScraperOptions & { backoffMs?: number },
): Promise<number | null> {
  if (igRateLimited) return null;
  const { fetchImpl, onUsage, logger } = resolveOptions(opts);
  const backoffMs = opts?.backoffMs ?? 30_000;
  onUsage({ provider: "instagram", operation: "ig-web-profile", calls: 1, units: 1 });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        { headers: { "User-Agent": "Instagram 275.0.0.27.98", "X-IG-App-ID": "936619743392459" } },
      );
      if (res.status === 429 || res.status === 401) {
        if (attempt === 0) {
          logger?.log(`[ig-scraper] rate limited for ${username}, waiting ${backoffMs}ms…`);
          await sleep(backoffMs);
          continue;
        }
        logger?.log(`[ig-scraper] still blocked — marking IG rate-limited for this run`);
        igRateLimited = true;
        return null;
      }
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      const n = data?.data?.user?.edge_followed_by?.count;
      return typeof n === "number" && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Convenience wrapper: username → FollowerResult (scrape path). */
export async function scrapeInstagramFollowerResult(
  username: string, opts?: ScraperOptions & { backoffMs?: number },
): Promise<FollowerResult> {
  return { followers: await scrapeInstagramFollowers(username, opts) };
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Meta Graph API — business_discovery
// ─────────────────────────────────────────────────────────────────────────────

export interface IgPublicCounts { followers: number | null; mediaCount: number | null }
export interface IgPublicMedia { shortcode: string; caption: string | null; permalink: string; timestamp?: string }

// Only page a few IG nodes to find ONE that works — we just need a single
// "requesting" node for business_discovery.
const IG_DISCOVERY_PAGE_LIMIT = 5;

/** Find ONE administered IG business-account id to act as the business_discovery
 *  requesting node. Returns null if none / rate-limited. Uses the BARE
 *  `instagram_business_account` field (the nested `{id}` form 500s live). */
async function discoverOneIgNode(g: GraphOptions): Promise<string | null> {
  const res = await graphFetch(
    `me/accounts?fields=instagram_business_account&limit=${IG_DISCOVERY_PAGE_LIMIT}`, g,
  );
  const pages = res.data?.data;
  if (!Array.isArray(pages)) return null;
  for (const p of pages) {
    const igId = p?.instagram_business_account?.id;
    if (typeof igId === "string" && igId) return igId; // first one wins
  }
  return null;
}

/**
 * Follower + media counts for public IG accounts we DON'T administer, by username,
 * via the business_discovery edge. Fail-open: returns a (possibly empty) map; a
 * miss on any handle just omits it. Rate-limit → early return of what we have.
 */
export async function fetchPublicInstagramFollowerMap(
  handles: string[],
  opts: GraphOptions,
): Promise<Map<string, IgPublicCounts>> {
  const map = new Map<string, IgPublicCounts>();
  if (handles.length === 0) return map;
  const ourIgId = await discoverOneIgNode(opts);
  if (!ourIgId) return map; // no requesting node → can't use business_discovery

  for (const handle of handles) {
    const clean = handle.replace(/^@/, "").trim();
    if (!clean) continue;
    const fields = `business_discovery.username(${clean}){followers_count,media_count}`;
    const res = await graphFetch(`${ourIgId}?fields=${encodeURIComponent(fields)}`, opts);
    // A rate-limit (code 4/17/32) → stop early, keep what we have.
    if (res.rateLimited) break;
    const disc = res.data?.business_discovery;
    if (disc) {
      map.set(clean.toLowerCase(), {
        followers: typeof disc.followers_count === "number" ? disc.followers_count : null,
        mediaCount: typeof disc.media_count === "number" ? disc.media_count : null,
      });
    }
  }
  return map;
}

/**
 * Recent public captions for external IG accounts by username, via the
 * business_discovery.media edge. Fail-open. Permalink shortcode == the post id you
 * key on. `limit` caps posts per account (default 50, the edge's page size).
 */
export async function fetchPublicInstagramCaptions(
  handles: string[],
  opts: GraphOptions & { mediaLimit?: number },
): Promise<Map<string, IgPublicMedia[]>> {
  const out = new Map<string, IgPublicMedia[]>();
  if (handles.length === 0) return out;
  const ourIgId = await discoverOneIgNode(opts);
  if (!ourIgId) return out;
  const mediaLimit = opts.mediaLimit ?? 50;

  for (const handle of handles) {
    const clean = handle.replace(/^@/, "").trim();
    if (!clean) continue;
    const inner = `media.limit(${mediaLimit})`;
    const fields = `business_discovery.username(${clean}){${inner}{caption,permalink,timestamp}}`;
    const res = await graphFetch(`${ourIgId}?fields=${encodeURIComponent(fields)}`, opts);
    if (res.rateLimited) break;
    const media = res.data?.business_discovery?.media?.data;
    if (!Array.isArray(media)) continue;
    const posts: IgPublicMedia[] = [];
    for (const m of media) {
      const permalink: string = m?.permalink ?? "";
      const shortcode = (permalink.match(/\/(?:p|reel|tv)\/([^/?]+)/) || [])[1] ?? "";
      if (!shortcode) continue;
      posts.push({
        shortcode,
        caption: typeof m?.caption === "string" ? m.caption : null,
        permalink,
        timestamp: m?.timestamp,
      });
    }
    out.set(clean.toLowerCase(), posts);
  }
  return out;
}
