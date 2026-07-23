// ── Snapchat: follower counts + Spotlight engagement ─────────────────────────
//
// Two zero-key scrapers, both fail-open:
//   A) scrapeSnapchatFollowers(handle, profileUrl) — the creator's follower count
//      ONLY. Reached via the /t/<code> share link (redirects to /p/<uuid>), whose
//      JSON-LD FollowAction + inline "subscriberCount":"N" carry the count.
//   B) scrapeSnapchatSpotlightEngagement(spotlightId) — views/comments/shares +
//      caption of a public /spotlight/<id> (embedded in a __NEXT_DATA__ blob).
//
// ⚠️⚠️ FOLLOWER COUNT IS THE ONLY SCRAPEABLE METRIC FROM A PROFILE/STORY PAGE.
//   On a /p/<uuid>/<storyId> Story page, per-post engagement is served as SENTINELS
//   ("viewCount":"-1", "shareCount":"0", plus a literal "{viewCount}" UI template) —
//   there is NO real WatchAction/ViewAction/LikeAction. NEVER parse views/likes from a
//   Story page or key a metric on viewCount/shareCount there (same trap as FB play_count).
//   Per-post engagement is ONLY reachable from the DIFFERENT /spotlight/<id> page (B).
//
// ⚠️ Snapchat exposes NO public like metric for Spotlight → `likes` is ALWAYS null.
// ⚠️ A /spotlight/<id> page is a FEED — read stories[0] ONLY (the URL's spotlight);
//    stories[1..24] are recommended NEIGHBORS. Never first-match viewCount.

import {
  FetchFn, ScraperOptions, resolveOptions, GOOGLEBOT_UA, parseCount,
  FollowerResult, EngagementResult,
} from "./shared";

const MIN_PAGE_LEN = 10_000;
const MIN_SPOTLIGHT_HTML_LEN = 50_000;

// ─────────────────────────────────────────────────────────────────────────────
// A) Follower count
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a subscriber count out of a Snapchat public-profile HTML page. Pure —
 *  exported for unit tests. Strategy order: __NEXT_DATA__ → JSON-LD FollowAction →
 *  og:description → inline "subscriberCount"/"followerCount". */
export function parseSnapchatProfileHtml(html: string): number | null {
  if (!html || html.length < MIN_PAGE_LEN) return null;

  // 1) __NEXT_DATA__ inline JSON
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
  if (nextData) {
    try {
      const p = JSON.parse(nextData[1]);
      for (const c of [
        p?.props?.pageProps?.userProfile?.subscriberCount,
        p?.props?.pageProps?.profile?.subscriberCount,
        p?.props?.pageProps?.snapchatUser?.subscriberCount,
        p?.props?.pageProps?.userProfile?.followerCount,
        p?.props?.pageProps?.profile?.followerCount,
      ]) {
        if (typeof c === "number" && c > 0) return c;
        if (typeof c === "string") { const n = parseCount(c); if (n && n > 0) return n; }
      }
    } catch { /* fall through */ }
  }

  // 2) JSON-LD FollowAction. The real /p/<uuid> page nests the stat under mainEntity
  //    and its interactionType is an OBJECT ({"@type":"FollowAction"}), not a string.
  const isFollowType = (t: unknown): boolean => {
    if (typeof t === "string") return t.toLowerCase().includes("follow");
    if (t && typeof t === "object") {
      const at = (t as any)["@type"];
      return typeof at === "string" && at.toLowerCase().includes("follow");
    }
    return false;
  };
  const fromStats = (stats: unknown): number | null => {
    if (!Array.isArray(stats)) return null;
    for (const s of stats) {
      const c = s?.userInteractionCount;
      const n = typeof c === "number" ? c : typeof c === "string" ? parseCount(c) : null;
      if (n && n > 0 && isFollowType(s?.interactionType)) return n;
    }
    return null;
  };
  for (const block of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const ld = JSON.parse(block[1]);
      const top = fromStats(ld?.interactionStatistic); if (top) return top;
      const main = fromStats(ld?.mainEntity?.interactionStatistic); if (main) return main;
      for (const src of [ld, ld?.mainEntity]) {
        const v = src?.subscriberCount ?? src?.followerCount ?? src?.numberOfSubscribers;
        if (typeof v === "number" && v > 0) return v;
        if (typeof v === "string") { const n = parseCount(v); if (n && n > 0) return n; }
      }
    } catch { /* ignore */ }
  }

  // 3) og:description "N Subscribers" (+ Hindi अनुयायी/सदस्य)
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i);
  if (ogDesc) {
    const desc = ogDesc[1];
    const m = desc.match(/([\d,.]+[KkMmBb]?)\s*[Ss]ubscribers?/)
      ?? desc.match(/([\d,.]+[KkMmBb]?)\s*(?:अनुयायी|सदस्य)/);
    if (m) { const n = parseCount(m[1]); if (n && n > 0) return n; }
  }

  // 4) inline patterns (value may be quoted or bare; the \d requirement skips the
  //    Hindi UI-template decoys like "{subscriberCount} फ़ॉलोअर").
  for (const re of [
    /"subscriberCount"\s*:\s*"?(\d+)"?/,
    /"followerCount"\s*:\s*"?(\d+)"?/,
    /"subscriber_count"\s*:\s*"?(\d+)"?/,
    /"follower_count"\s*:\s*"?(\d+)"?/,
    /([\d,.]+[KkMmBb]?)\s*[Ss]ubscribers?/,
    /([\d,.]+[KkMmBb]?)\s*[Ff]ollowers?/,
  ]) {
    const m = html.match(re);
    if (m) { const n = parseCount(m[1]); if (n && n > 0) return n; }
  }
  return null;
}

/** Ordered candidate profile URLs. The stored profile_url (/t/ or /p/) is tried
 *  FIRST — that's where the count lives; /add/<handle> 404s for most real accounts. */
export function snapchatCandidateUrls(handle: string, profileUrl?: string | null): string[] {
  const urls: string[] = [];
  const p = (profileUrl || "").trim();
  if (/^https?:\/\//i.test(p)) urls.push(p);
  const clean = (handle || "").replace(/^@/, "").split("?")[0].trim();
  if (clean) {
    urls.push(`https://www.snapchat.com/add/${encodeURIComponent(clean)}`);
    urls.push(`https://story.snapchat.com/@${encodeURIComponent(clean)}`);
  }
  return Array.from(new Set(urls));
}

/**
 * Scrape a Snapchat account's follower count. Pass the stored `profileUrl` (a /t/ or
 * /p/ link) — it is tried first. Fail-open: { followers: null } on any miss (caller
 * keeps the existing value); { followers: null, walled: true } on a hard block.
 */
export async function scrapeSnapchatFollowers(
  handle: string,
  profileUrl?: string | null,
  opts?: ScraperOptions,
): Promise<FollowerResult> {
  const { fetchImpl, onUsage, timeoutMs, logger } = resolveOptions(opts);
  onUsage({ provider: "snapchat", operation: "sc-follower-scrape", calls: 1, units: 1 });

  const urls = snapchatCandidateUrls(handle, profileUrl);
  if (urls.length === 0) { logger?.log(`[sc-scraper] ${handle || "(no handle)"}: no candidate URL — skip`); return { followers: null }; }

  let sawWall = false;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": GOOGLEBOT_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { if (res.status === 404) continue; sawWall = true; continue; }
      if (/\/login|\/signup|\/accounts\/login/i.test(res.url)) { sawWall = true; continue; }
      const html = await res.text();
      const followers = parseSnapchatProfileHtml(html);
      if (followers !== null) { logger?.log(`[sc-scraper] ${handle}: ${followers} (via ${url} → ${res.url})`); return { followers }; }
    } catch {
      clearTimeout(timer);
    }
  }
  logger?.log(`[sc-scraper] ${handle}: no count found (${urls.length} tried${sawWall ? ", saw wall" : ""})`);
  return sawWall ? { followers: null, walled: true } : { followers: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Spotlight engagement
// ─────────────────────────────────────────────────────────────────────────────

/** Map a string stat → positive integer; the -1 Story sentinel and any non-positive
 *  / non-numeric value → null (an empty string is "no data", not 0). */
function toCount(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Parse a /spotlight/<id> page's __NEXT_DATA__ and read spotlightStories[0] ONLY.
 *  Pure + synchronous — exported for unit tests. `likes` is always null. */
export function parseSnapchatSpotlightHtml(html: string): Omit<EngagementResult, "walled"> {
  const EMPTY = { views: null, likes: null, comments: null, shares: null, caption: null };
  if (!html || html.length < MIN_SPOTLIGHT_HTML_LEN) return { ...EMPTY };
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m || !m[1]) return { ...EMPTY };
  let data: any;
  try { data = JSON.parse(m[1]); } catch { return { ...EMPTY }; }

  const stories = data?.props?.pageProps?.spotlightFeed?.spotlightStories;
  if (!Array.isArray(stories) || stories.length === 0) return { ...EMPTY };

  const meta = stories[0]?.metadata ?? {};       // index 0 = the URL's spotlight
  const stats = meta.engagementStats ?? {};
  const vmeta = meta.videoMetadata ?? {};
  const caption =
    (typeof vmeta.embeddedTextCaption === "string" && vmeta.embeddedTextCaption.trim()) ||
    (typeof vmeta.description === "string" && vmeta.description.trim()) || null;

  return {
    views: toCount(stats.viewCount),
    likes: null,                                  // Snapchat has no public like metric
    comments: toCount(stats.commentCount),
    shares: toCount(stats.shareCount),
    caption: caption || null,
  };
}

/**
 * Fetch + parse one public Spotlight's engagement by its id. Fail-open → all-null
 * (walled:true on a block) on any non-200, login redirect, short body, missing blob,
 * parse miss, or timeout.
 */
export async function scrapeSnapchatSpotlightEngagement(
  spotlightId: string,
  opts?: ScraperOptions,
): Promise<EngagementResult> {
  const EMPTY: EngagementResult = { views: null, likes: null, comments: null, shares: null, caption: null };
  if (!spotlightId || !/^[A-Za-z0-9_-]{8,}$/.test(spotlightId)) return { ...EMPTY };
  const { fetchImpl, onUsage, timeoutMs } = resolveOptions(opts);
  onUsage({ provider: "snapchat", operation: "sc-spotlight-scraper", calls: 1, units: 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://www.snapchat.com/spotlight/${spotlightId}`, {
      headers: { "User-Agent": GOOGLEBOT_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ...EMPTY, walled: true };
    if (/accounts\.snapchat\.com|\/login|\/checkpoint/i.test(res.url)) return { ...EMPTY, walled: true };
    const html = await res.text();
    return { ...parseSnapchatSpotlightHtml(html) };
  } catch {
    return { ...EMPTY, walled: true };
  } finally {
    clearTimeout(timer);
  }
}
