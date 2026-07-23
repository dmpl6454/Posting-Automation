// ── YouTube: follower/subscriber counts ──────────────────────────────────────
//
// TWO independent paths, pick per your setup:
//   A) scrapeYouTubeSubscribers(channelUrl)  — zero-key HTML scrape of a channel
//      page. Reads the channel's OWN count from the `accessibilityLabel` in the
//      page header. No API key, no quota, but brittle to YouTube layout changes.
//   B) fetchYouTubeSubscriberCounts(accounts, {apiKey}) — the OFFICIAL YouTube
//      Data API v3. Robust and exact, but needs an API key and respects a
//      10,000-unit/day quota (search.list costs 100 units — expensive; channels
//      .list costs 1). Prefer this if you have a key.
//
// Both are fail-open: a miss yields null / an absent entry, never a throw.

import {
  FetchFn, ScraperOptions, resolveOptions, parseCount, FollowerResult,
} from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// A) Zero-key HTML scrape
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "553 thousand subscribers" / "1.08 million" / "1.4M" → integer, or null. */
export function parseYouTubeSubscribers(text: string): number | null {
  const m = text.match(/([\d,.]+)\s*(thousand|million|billion|lakh|crore|K|M|B)?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || "").toLowerCase();
  if (u === "thousand" || u === "k") n *= 1_000;
  else if (u === "lakh") n *= 100_000;
  else if (u === "million" || u === "m") n *= 1_000_000;
  else if (u === "crore") n *= 10_000_000;
  else if (u === "billion" || u === "b") n *= 1_000_000_000;
  return Math.round(n);
}

/** Extract a channel's subscriber count from its rendered HTML. Pure — exported for
 *  unit tests with a captured fixture.
 *
 *  The channel's OWN count lives in pageHeaderRenderer → contentMetadataViewModel as
 *  an `accessibilityLabel` mentioning "subscribers". That is the ONLY such label on
 *  the page — the related-channels sidebar uses `subscriberCountText` instead (which
 *  is a DIFFERENT channel's number). So we anchor on the accessibilityLabel first. */
export function parseYouTubeChannelHtml(html: string): number | null {
  const accLabel = html.match(/"accessibilityLabel":"([^"]*\bsubscribers?\b[^"]*)"/i);
  if (accLabel) return parseYouTubeSubscribers(accLabel[1]);
  // Fallback (older layouts). On the current layout this may be a sidebar channel's
  // count, so it's only a "better than null" guard — prefer the accessibilityLabel.
  const fallback = html.match(
    /"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/,
  );
  if (fallback) return parseYouTubeSubscribers(fallback[1]);
  return null;
}

/** Scrape a channel's subscriber count from its public page URL (e.g.
 *  https://www.youtube.com/@Handle or /channel/UC…). Fail-open → null on any miss. */
export async function scrapeYouTubeSubscribers(
  channelUrl: string,
  opts?: ScraperOptions,
): Promise<number | null> {
  const { fetchImpl, onUsage, timeoutMs } = resolveOptions(opts);
  onUsage({ provider: "youtube", operation: "yt-channel-scrape", calls: 1, units: 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(channelUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseYouTubeChannelHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B) Official YouTube Data API v3 (needs an API key)
// ─────────────────────────────────────────────────────────────────────────────
//
// Resolution cascade (proven live):
//   1. Channel ID known (handle is UC… OR profileUrl has /channel/UC…) →
//      channels.list?id=  (1 unit; batched 50/call). Empty items = deleted → skip.
//   2. Handle, no channel ID → channels.list?forHandle= (1 unit). NOTE: forHandle
//      OFTEN returns empty even for real channels → fall through to 3.
//   3. Last resort: search.list?q= (100 units!) → items[0].snippet.channelId →
//      channels.list?id= (1 unit). Capped via maxSearchLookups (default 25) to
//      protect the daily 10,000-unit quota.
//
// subscriberCount is a STRING in the API — always parseInt. hiddenSubscriberCount
// === true → skip (don't return 0).

const YT_BASE = "https://www.googleapis.com/youtube/v3";
const BATCH_SIZE = 50; // channels.list?id= hard cap
const DEFAULT_MAX_SEARCH_LOOKUPS = 25;

export interface YtAccountRef {
  /** Your own account id — passed through so you can map results back. */
  id: string;
  /** May be a UC… id, an @Handle, or a display name. */
  handle: string;
  /** May contain /channel/UC… or /@Handle. */
  profileUrl: string;
}

export interface YtFollowerResult {
  accountId: string;
  subscribers: number;
}

interface YtStats { subscriberCount?: string; hiddenSubscriberCount?: boolean }
interface YtChannelItem { id: string; statistics?: YtStats }
interface YtChannelsResponse { items?: YtChannelItem[] }
interface YtSearchResponse { items?: Array<{ snippet?: { channelId?: string } }> }

const isChannelId = (s: string) => /^UC[\w-]{20,}$/.test(s);
const channelIdFromUrl = (u: string) => (u.match(/\/channel\/(UC[\w-]+)/) || [])[1] ?? null;
const stripAt = (h: string) => h.replace(/^@/, "");

function extractSubscribers(stats: YtStats | null): number | null {
  if (!stats) return null;
  if (stats.hiddenSubscriberCount === true) return null; // hidden — don't return 0
  if (stats.subscriberCount == null) return null;
  const n = parseInt(stats.subscriberCount, 10);
  return Number.isFinite(n) ? n : null;
}

async function ytFetch(
  url: string, fetchImpl: FetchFn, timeoutMs: number, onUsage: ScraperOptions["onUsage"],
): Promise<Response | null> {
  const isSearch = /\/search\?/.test(url);
  const op = isSearch ? "youtube-search" : url.includes("/channels?") ? "youtube-channels" : "youtube-other";
  onUsage?.({ provider: "youtube", operation: op, calls: 1, units: isSearch ? 100 : 1 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { signal: controller.signal }); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

async function channelsById(
  ids: string[], apiKey: string, fetchImpl: FetchFn, timeoutMs: number, onUsage: ScraperOptions["onUsage"],
): Promise<Map<string, YtStats | null>> {
  const out = new Map<string, YtStats | null>();
  const url = `${YT_BASE}/channels?part=statistics&id=${encodeURIComponent(ids.join(","))}&key=${apiKey}`;
  const res = await ytFetch(url, fetchImpl, timeoutMs, onUsage);
  if (!res) { ids.forEach((id) => out.set(id, null)); return out; }
  let data: YtChannelsResponse;
  try { data = (await res.json()) as YtChannelsResponse; }
  catch { ids.forEach((id) => out.set(id, null)); return out; }
  const byId = new Map((data.items ?? []).map((it) => [it.id, it] as const));
  for (const id of ids) { const it = byId.get(id); out.set(id, it ? it.statistics ?? {} : null); }
  return out;
}

/**
 * Resolve current subscriber counts via the official Data API v3.
 * Fail-open: never throws; unresolvable accounts (deleted, hidden subs, quota
 * exhausted, missing key, network error) are simply absent from the result array.
 */
export async function fetchYouTubeSubscriberCounts(
  accounts: YtAccountRef[],
  opts: ScraperOptions & { apiKey?: string; maxSearchLookups?: number },
): Promise<YtFollowerResult[]> {
  const apiKey = opts.apiKey ?? process.env.YOUTUBE_API_KEY;
  if (!apiKey) return []; // no key → no network
  const { fetchImpl, onUsage, timeoutMs } = resolveOptions(opts);
  const maxSearch = opts.maxSearchLookups ?? DEFAULT_MAX_SEARCH_LOOKUPS;
  const results: YtFollowerResult[] = [];

  // Partition: known-channel-ID (batch) vs needs-resolution (per-account).
  const withId: Array<{ acc: YtAccountRef; channelId: string }> = [];
  const needResolve: YtAccountRef[] = [];
  for (const acc of accounts) {
    if (isChannelId(acc.handle)) { withId.push({ acc, channelId: acc.handle }); continue; }
    const fromUrl = channelIdFromUrl(acc.profileUrl);
    if (fromUrl) { withId.push({ acc, channelId: fromUrl }); continue; }
    needResolve.push(acc);
  }

  // Step 1: batch channels.list?id=
  const chanToAcc = new Map(withId.map(({ acc, channelId }) => [channelId, acc.id] as const));
  const allIds = withId.map((x) => x.channelId);
  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batch = allIds.slice(i, i + BATCH_SIZE);
    const statsMap = await channelsById(batch, apiKey, fetchImpl, timeoutMs, onUsage);
    for (const [channelId, stats] of statsMap) {
      const accountId = chanToAcc.get(channelId);
      if (!accountId) continue;
      const subs = extractSubscribers(stats);
      if (subs != null) results.push({ accountId, subscribers: subs });
    }
  }

  // Steps 2+3: forHandle, then (capped) search.list
  let searchUsed = 0;
  for (const acc of needResolve) {
    const handle = stripAt(acc.handle);
    // Step 2: forHandle
    const fhUrl = `${YT_BASE}/channels?part=statistics&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;
    const fhRes = await ytFetch(fhUrl, fetchImpl, timeoutMs, onUsage);
    let resolved = false;
    if (fhRes) {
      try {
        const d = (await fhRes.json()) as YtChannelsResponse;
        const item = d.items?.[0];
        if (item) {
          const subs = extractSubscribers(item.statistics ?? {});
          if (subs != null) results.push({ accountId: acc.id, subscribers: subs });
          resolved = true; // found (even if hidden → intentionally absent)
        }
      } catch { /* fall through */ }
    }
    if (resolved) continue;
    // Step 3: search.list (expensive — respect the cap)
    if (searchUsed >= maxSearch) continue;
    searchUsed++;
    const sUrl = `${YT_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&maxResults=1&key=${apiKey}`;
    const sRes = await ytFetch(sUrl, fetchImpl, timeoutMs, onUsage);
    if (!sRes) continue;
    let channelId: string | null = null;
    try { channelId = ((await sRes.json()) as YtSearchResponse).items?.[0]?.snippet?.channelId ?? null; }
    catch { continue; }
    if (!channelId) continue;
    const statsMap = await channelsById([channelId], apiKey, fetchImpl, timeoutMs, onUsage);
    const subs = extractSubscribers(statsMap.get(channelId) ?? null);
    if (subs != null) results.push({ accountId: acc.id, subscribers: subs });
  }

  return results;
}

/** Convenience wrapper: single channel URL → FollowerResult (scrape path). */
export async function scrapeYouTubeFollowers(
  channelUrl: string, opts?: ScraperOptions,
): Promise<FollowerResult> {
  const n = await scrapeYouTubeSubscribers(channelUrl, opts);
  return { followers: n };
}
