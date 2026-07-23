// ── Facebook: follower counts + per-reel engagement ──────────────────────────
//
// Two scrapers, both zero-key, both fail-open:
//   A) scrapeFacebookFollowers(profileUrl, handle) — follower/like count of a Page
//      or profile. Numeric-ID profiles (facebook.com/profile.php?id=<n>) resolve via
//      the lightweight MOBILE site with a mobile-Safari UA (un-walled, og:description
//      carries the count). Vanity slugs resolve via www.facebook.com with a Googlebot
//      UA. Indian Pages localise the number to Devanagari digits — decoded here.
//   B) scrapeFacebookReelEngagement(reelId) — views/likes/comments + caption of ANY
//      public reel. A logged-out Googlebot-UA GET of /reel/<id> returns the full HTML
//      with engagement embedded as JSON. Verified 40/40 first-try from a datacenter IP.
//
// ⚠️ TARGET-SCOPING is the #1 gotcha (learned the hard way — the "7476 likes on 46
// different reels" bug). A reel page is a FEED carrying ~22 recommended reels, so
// feed-wide JSON keys CANNOT be first-matched:
//   • views    = `video_view_count`  — appears EXACTLY ONCE (only the target has it).
//                Verified vs Graph post_video_views 5/5 EXACT. NEVER use `play_count`
//                (that's carousel noise; unstable across fetches).
//   • comments = `total_comment_count` — single-occurrence = the target's.
//   • likes    = parsed from the og:title share-preview ("… · 264 प्रतिक्रिया | …"),
//                NOT the loose `reaction_count` (appears ~22× → wrong reel). Null when
//                og:title has no reactions segment — honest null beats a carousel guess.
//
// If you administer the Page, the Meta Graph /insights path (see meta-graph.ts) is
// exact + free for THOSE reels — use it first, fall back to this scraper for the
// external majority you don't administer.

import {
  FetchFn, ScraperOptions, resolveOptions, GOOGLEBOT_UA,
  devanagariToAscii, decodeHtmlEntities, parseCount, FollowerResult, EngagementResult,
} from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// A) Follower / like count
// ─────────────────────────────────────────────────────────────────────────────

// A real page is tens of KB; a login-wall / checkpoint / error shell can be served
// with HTTP 200 but is far shorter. Reject on length BEFORE parsing.
const MIN_MOBILE_FB_HTML_LEN = 20_000;

/** Pull a handle/slug out of a profile URL. facebook.com/pages/name/id → "name". */
function extractFbSlug(profileUrl: string, handle: string): string {
  try {
    const url = new URL(profileUrl.split("?")[0].replace(/\/$/, ""));
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "pages" && parts.length >= 2) return parts[1];
    return parts[parts.length - 1] || "";
  } catch {
    return handle.replace(/^@/, "").split("?")[0];
  }
}

async function getHtml(url: string, ua: string, fetchImpl: FetchFn, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrape a Facebook Page/profile follower (or like) count. Fail-open → null.
 * @param profileUrl  the stored profile URL (may be facebook.com/profile.php?id=<n>
 *                    or a vanity /slug)
 * @param handle      fallback slug if the URL has none
 */
export async function scrapeFacebookFollowers(
  profileUrl: string,
  handle: string,
  opts?: ScraperOptions,
): Promise<number | null> {
  const { fetchImpl, onUsage, timeoutMs } = resolveOptions(opts);
  onUsage({ provider: "facebook", operation: "fb-follower-scrape", calls: 1, units: 1 });

  // 1) Numeric-ID profiles: the mobile site (mobile-Safari UA) is un-walled and its
  //    og:description carries the count. Require the number to be ANCHORED to
  //    likes/followers/people — an unanchored number on a walled page must never be
  //    mistaken for a follower count.
  const numericId = (profileUrl.match(/profile\.php\?id=(\d+)/) || [])[1];
  if (numericId) {
    const html = await getHtml(
      `https://m.facebook.com/profile.php?id=${numericId}&locale=en_US`,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      fetchImpl, timeoutMs,
    );
    if (html && html.length >= MIN_MOBILE_FB_HTML_LEN) {
      const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
      if (ogDesc) {
        const decoded = devanagariToAscii(decodeHtmlEntities(ogDesc[1]));
        const anchored = decoded.match(/([\d,]+)\s*(?:likes|followers|people)/i);
        if (anchored) {
          const n = parseCount(anchored[1]);
          if (n && n > 0) return n;
        }
      }
    }
  }

  // 2) Vanity slug: www.facebook.com with a Googlebot UA is the only reliable
  //    logged-out path (default UAs get a login wall / HTTP 400).
  const slug = extractFbSlug(profileUrl, handle);
  if (!slug) return null;
  const html = await getHtml(`https://www.facebook.com/${encodeURIComponent(slug)}`, GOOGLEBOT_UA, fetchImpl, timeoutMs);
  if (!html) return null;

  // og:description first (Indian pages encode the count in Devanagari digits).
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  if (ogDesc) {
    const decoded = devanagariToAscii(decodeHtmlEntities(ogDesc[1]));
    const numMatch = decoded.match(/([\d,]+)/);
    if (numMatch) {
      const n = parseCount(numMatch[1]);
      if (n && n > 0) return n;
    }
  }
  // Inline JSON / text patterns for English pages without an og:description count.
  for (const re of [
    /"follower_count"\s*:\s*(\d+)/,
    /"followers_count"\s*:\s*(\d+)/,
    /(\d[\d,.]*[KkMmBb]?)\s*(?:followers|people follow)/i,
    /(\d[\d,.]*[KkMmBb]?)\s*likes/i,
  ]) {
    const m = html.match(re);
    if (m) {
      const n = parseCount(m[1]);
      if (n && n > 0) return n;
    }
  }
  return null;
}

/** Convenience wrapper → FollowerResult. */
export async function scrapeFacebookFollowerResult(
  profileUrl: string, handle: string, opts?: ScraperOptions,
): Promise<FollowerResult> {
  return { followers: await scrapeFacebookFollowers(profileUrl, handle, opts) };
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Per-reel engagement
// ─────────────────────────────────────────────────────────────────────────────

// A real reel page is ~800KB-1MB; a login wall / error shell is < 50KB.
const MIN_REEL_HTML_LEN = 50_000;

/** Parse a "<number><unit> <keyword>" count out of the (decoded) og:title — the
 *  TARGET reel's own share-preview figure. Handles English K/M/B and Hindi units
 *  ह/हज़ार (1e3), लाख (1e5), कोटी/करोड़ (1e7). Returns a rounded-correct count or null. */
function parseOgTitleCount(ogTitleDecoded: string, keywords: string[]): number | null {
  const t = devanagariToAscii(ogTitleDecoded);
  for (const kw of keywords) {
    const m = t.match(new RegExp(`([\\d.,]+)\\s*(ह|हज़ार|हजार|लाख|कोटी|करोड़|K|M|B|k|m|b)?\\s*${kw}`));
    if (!m) continue;
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mult: Record<string, number> = {
      "ह": 1e3, "हज़ार": 1e3, "हजार": 1e3, "लाख": 1e5, "कोटी": 1e7, "करोड़": 1e7,
      K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9,
    };
    return Math.round(n * (mult[m[2]] ?? 1));
  }
  return null;
}

/** Best caption from the reel HTML: og:description (the name-bearing post body) is
 *  richer than og:title (often just the Page name). Fall back to the og:title tail
 *  after any "N views · M reactions | " engagement prefix. */
function parseFbCaption(html: string): string | null {
  const ogDesc = (html.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || "";
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";
  const desc = decodeHtmlEntities(ogDesc).trim();
  if (desc.length > 3) return desc;
  let title = decodeHtmlEntities(ogTitle).trim();
  if (title.includes(" | ")) {
    const tail = title.split(" | ").slice(1).join(" | ").trim();
    if (tail.length > 0) title = tail;
  }
  return title.length > 3 ? title : null;
}

/** Parse engagement + caption out of a reel page's HTML. Pure + synchronous —
 *  exported for unit tests with captured fixtures. See the TARGET-SCOPING note above. */
export function parseFbReelHtml(html: string): Omit<EngagementResult, "walled" | "shares"> {
  const EMPTY = { views: null, likes: null, comments: null, caption: null };
  if (!html || html.length < MIN_REEL_HTML_LEN) return { ...EMPTY };

  const vm = html.match(/"video_view_count"\s*:\s*(\d+)/);        // single-occ = target
  const views = vm ? Number(vm[1]) : null;

  const cm = html.match(/"total_comment_count"\s*:\s*(\d+)/);     // single-occ = target
  const comments = cm ? Number(cm[1]) : null;

  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";
  const likes = parseOgTitleCount(decodeHtmlEntities(ogTitle), ["प्रतिक्रिया", "reactions", "reaction"]);

  return {
    views: Number.isFinite(views as number) ? views : null,
    likes: Number.isFinite(likes as number) ? likes : null,
    comments: Number.isFinite(comments as number) ? comments : null,
    caption: parseFbCaption(html),
  };
}

/**
 * Fetch + parse one public reel's engagement by its NUMERIC reel id. Fail-open:
 * returns all-null (walled:true on a block) on any non-200, login redirect, short
 * body, timeout, or throw. Opaque /share/ or pfbid ids are not accepted — resolve
 * them to a numeric /reel/<id> first (a single unauthenticated 302 usually works).
 */
export async function scrapeFacebookReelEngagement(
  reelId: string,
  opts?: ScraperOptions,
): Promise<EngagementResult> {
  const EMPTY: EngagementResult = { views: null, likes: null, comments: null, shares: null, caption: null };
  if (!reelId || !/^\d+$/.test(reelId)) return { ...EMPTY };
  const { fetchImpl, onUsage, timeoutMs } = resolveOptions(opts);
  onUsage({ provider: "facebook", operation: "fb-reel-scraper", calls: 1, units: 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://www.facebook.com/reel/${reelId}`, {
      headers: { "User-Agent": GOOGLEBOT_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ...EMPTY, walled: true };
    if (/\/login|\/checkpoint/i.test(res.url)) return { ...EMPTY, walled: true };
    const html = await res.text();
    return { ...parseFbReelHtml(html), shares: null };
  } catch {
    return { ...EMPTY, walled: true };
  } finally {
    clearTimeout(timer);
  }
}
