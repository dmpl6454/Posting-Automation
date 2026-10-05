import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import type { MentionSource } from "@postautomation/db";
import {
  QUEUE_NAMES,
  sentimentAnalysisQueue,
  SENTIMENT_BATCH_SIZE,
  type ListeningSyncJobData,
  type SentimentMentionInput,
  createRedisConnection,
  LISTENING_SYNC_INTERVAL_MS,
} from "@postautomation/queue";
import { hasSurgeBaseline } from "./lib/surge-guard";
import {
  alertOnCooldown,
  ALERT_COOLDOWN_MS,
  candidateIdentities,
  chunk,
  chunkKeywords,
  cleanKeywords,
  linkedInPostUrl,
  matchesAnyKeyword,
  orQuery,
  planMentionBatch,
  rotateWindow,
  uniqueByPlatformId,
} from "../lib/listening-sync-plan";
import {
  YT_UNITS,
  isQuotaError,
  isPerVideoCommentError,
  isYouTubeTurn,
  pickRedditThreads,
  quotaDay,
  readYouTubeListeningConfig,
  redditCommentsFromListing,
  reserveYouTubeUnits,
  youtubeCommentsFromThreads,
  youtubeQuery,
  youtubeStatsById,
  youtubeVideoMention,
  youtubeVideosFromSearch,
  type RedditPostRef,
  type UnitCounter,
} from "../lib/listening-comments";

/**
 * Listening sync (2026-10-04 rewrite — read apps/worker/src/lib/listening-sync-plan.ts first).
 *
 * One job = one ListeningQuery = one sweep of every selected platform. The
 * shape of a run is now:
 *   1. keywords → as FEW requests as each platform allows (OR-combined chunks
 *      for Twitter / Reddit / Google News / TikTok; one posts read per
 *      LinkedIn Page; one hashtag lookup per keyword on ONE Instagram account;
 *      one /tagged read per connected Facebook Page, a rotating window per run)
 *   2. one DB read for what is already stored, one planning pass in memory
 *   3. one createMany per 500 rows — the dedupKey lookup in step 2 is the
 *      idempotency check, not a per-row findFirst
 *   4. sentiment jobs added in BULK, SENTIMENT_BATCH_SIZE mentions per job
 *   5. alerts, with a 24h cooldown per type
 *
 * Fetchers never throw: a platform that fails logs and contributes nothing.
 *
 * ⚠️ (listeningQueryId, dedupKey) is a plain index, not unique — see the
 * schema comment on Mention.dedupKey for why — so two sweeps of the SAME query
 * running at once could each pass step 2 and both insert. The job ids are
 * bucketed (listening-jobs.ts) so that is rare, and `inFlightQueries` below
 * makes it impossible inside one worker process (prod runs exactly one).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface RawMention {
  source: MentionSource;
  /** Platform's own post id — the preferred identity (see mentionDedupKey). */
  platformPostId?: string | null;
  sourceUrl: string | null;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatar: string | null;
  content: string;
  mentionedAt: Date;
  reach: number;
  engagements: number;
  metadata?: Record<string, unknown>;
}

interface ListeningChannel {
  id: string;
  platform: string;
  platformId: string;
  name: string;
  accessToken: string;
}

interface FetchContext {
  keywords: string[];
  language: string;
  organizationId: string;
  /** The query being swept (YouTube spreads its runs by this id). */
  queryId: string;
  /** A person asked for this sweep (Sync Now / a new query), not the cron. */
  interactive: boolean;
  /** Lazily loaded once per job; only the platforms that need a token read it. */
  channels: () => Promise<ListeningChannel[]>;
}

type Fetcher = (ctx: FetchContext) => Promise<RawMention[]>;

const REQUEST_TIMEOUT_MS = 10_000;

/** Count of per-platform requests, for the per-run accounting log. */
let requestCounter = 0;
function timedFetch(input: string, init?: RequestInit): Promise<Response> {
  requestCounter++;
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

// ---------------------------------------------------------------------------
// App-token caches — Reddit and TikTok hand out hour-long client tokens, and
// the old code minted a fresh one PER KEYWORD PER QUERY PER RUN.
// ---------------------------------------------------------------------------
interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();

async function cachedToken(key: string, mint: () => Promise<{ token: string; ttlSec: number } | null>): Promise<string | null> {
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const minted = await mint();
  if (!minted) return null;
  tokenCache.set(key, { token: minted.token, expiresAt: Date.now() + Math.max(60, minted.ttlSec) * 1000 });
  return minted.token;
}

/** Test seam: forget cached app tokens. */
export function __resetListeningTokenCache() {
  tokenCache.clear();
}

// ---------------------------------------------------------------------------
// Platform fetchers
// ---------------------------------------------------------------------------

/**
 * Google News RSS — free, no auth. ONE request per keyword chunk, `hl` = the
 * query's language. Google answers a bare `hl=` with a 302 to the full locale
 * URL (`hl=en-US&gl=US&ceid=US:en`); fetch follows it. Every non-feed outcome
 * is LOGGED: before 2026-10-04 a non-200 was a silent `continue`, so "news
 * returns nothing" could not be told apart from "news was never asked".
 */
const fetchGoogleNews: Fetcher = async ({ keywords, language }) => {
  const mentions: RawMention[] = [];
  for (const group of chunkKeywords(keywords)) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(orQuery(group))}&hl=${encodeURIComponent(language || "en")}`;
      const response = await timedFetch(rssUrl, {
        redirect: "follow",
        headers: { Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" },
      });
      if (!response.ok) {
        console.warn(`[ListeningSync:GoogleNews] HTTP ${response.status} for ${JSON.stringify(group)} (${response.url || rssUrl})`);
        continue;
      }
      const xml = await response.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      if (items.length === 0) {
        // A consent/interstitial page or a block comes back as HTML with a 200.
        const head = xml.slice(0, 160).replace(/\s+/g, " ");
        console.warn(`[ListeningSync:GoogleNews] 0 items for ${JSON.stringify(group)} (${response.url || rssUrl}); body starts: ${head}`);
      }

      for (const item of items.slice(0, 10 * group.length)) {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
          || item.match(/<title>(.*?)<\/title>/)?.[1]
          || "";
        const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
        const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || null;
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1];
        const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News";
        if (!title) continue;

        mentions.push({
          source: "NEWS",
          platformPostId: guid,
          sourceUrl: link || null,
          authorName: source,
          authorHandle: null,
          authorAvatar: null,
          content: title,
          mentionedAt: pubDate ? new Date(pubDate) : new Date(),
          // Google News RSS carries no audience or interaction metrics.
          reach: 0,
          engagements: 0,
        });
      }
    } catch (err) {
      console.warn(`[ListeningSync:GoogleNews] Failed for ${JSON.stringify(group)}:`, err);
    }
  }
  return mentions;
};

/** Twitter/X recent search v2 — ONE request per keyword chunk (`a OR "b c"`), language from the query. */
const fetchTwitterMentions: Fetcher = async ({ keywords, language }) => {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) return [];

  const mentions: RawMention[] = [];
  for (const group of chunkKeywords(keywords, { maxPerChunk: 5, maxChars: 400 })) {
    try {
      const lang = /^[a-z]{2}$/i.test(language) ? language.toLowerCase() : "en";
      const query = encodeURIComponent(`(${orQuery(group)}) -is:retweet lang:${lang}`);
      const maxResults = Math.min(100, Math.max(10, 20 * group.length));
      const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=${maxResults}&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=name,username,profile_image_url`;
      const response = await timedFetch(url, { headers: { Authorization: `Bearer ${bearerToken}` } });

      if (!response.ok) {
        console.warn(`[ListeningSync:Twitter] Search failed: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json() as any;
      const users = new Map<string, any>();
      for (const u of data.includes?.users || []) users.set(u.id, u);

      for (const tweet of data.data || []) {
        const user = users.get(tweet.author_id);
        const metrics = tweet.public_metrics || {};
        mentions.push({
          source: "TWITTER",
          platformPostId: tweet.id,
          sourceUrl: `https://x.com/i/status/${tweet.id}`,
          authorName: user?.name || null,
          authorHandle: user?.username ? `@${user.username}` : null,
          authorAvatar: user?.profile_image_url || null,
          content: tweet.text,
          mentionedAt: new Date(tweet.created_at),
          reach: metrics.impression_count || 0,
          engagements: (metrics.like_count || 0) + (metrics.retweet_count || 0) + (metrics.reply_count || 0),
          metadata: { tweetId: tweet.id, metrics },
        });
      }
    } catch (err) {
      console.warn(`[ListeningSync:Twitter] Failed for ${JSON.stringify(group)}:`, err);
    }
  }
  return mentions;
};

/** Reddit — client-credentials token (cached) + ONE search per keyword chunk. */
const fetchRedditMentions: Fetcher = async ({ keywords }) => {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const mentions: RawMention[] = [];
  const threads: RedditPostRef[] = [];
  try {
    const token = await cachedToken("reddit", async () => {
      const tokenRes = await timedFetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "PostAutomation/1.0",
        },
        body: "grant_type=client_credentials",
      });
      if (!tokenRes.ok) return null;
      const body = await tokenRes.json() as { access_token?: string; expires_in?: number };
      return body.access_token ? { token: body.access_token, ttlSec: body.expires_in ?? 3600 } : null;
    });
    if (!token) return [];

    for (const group of chunkKeywords(keywords, { maxPerChunk: 5, maxChars: 400 })) {
      try {
        const limit = Math.min(100, 15 * group.length);
        const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(orQuery(group))}&sort=new&limit=${limit}&t=day`;
        const response = await timedFetch(url, {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "PostAutomation/1.0" },
        });
        if (response.status === 401) {
          tokenCache.delete("reddit"); // token revoked early — next run re-mints
          continue;
        }
        if (!response.ok) continue;

        const data = await response.json() as any;
        for (const child of data.data?.children || []) {
          const p = child.data;
          if (p.stickied) continue;
          if (p.id && p.permalink) {
            threads.push({
              id: String(p.id),
              title: String(p.title ?? ""),
              permalink: String(p.permalink),
              subreddit: String(p.subreddit ?? ""),
              numComments: Number(p.num_comments) || 0,
            });
          }
          mentions.push({
            source: "REDDIT",
            platformPostId: p.name || p.id || null,
            sourceUrl: p.permalink ? `https://reddit.com${p.permalink}` : null,
            authorName: `r/${p.subreddit}`,
            authorHandle: p.author ? `u/${p.author}` : null,
            authorAvatar: null,
            content: p.title + (p.selftext ? `\n${p.selftext.slice(0, 200)}` : ""),
            mentionedAt: new Date(p.created_utc * 1000),
            reach: p.ups || 0,
            engagements: (p.ups || 0) + (p.num_comments || 0),
            metadata: { subreddit: p.subreddit, score: p.score },
          });
        }
      } catch (err) {
        console.warn(`[ListeningSync:Reddit] Failed for ${JSON.stringify(group)}:`, err);
      }
    }

    // Comments (2026-10-05): open the most-discussed matching posts and keep
    // the comments that name a keyword (or sit under a post whose title does).
    // One request per post, REDDIT_COMMENT_THREADS posts per sweep.
    const seen = new Set<string>();
    const unique = threads.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    for (const post of pickRedditThreads(unique, REDDIT_COMMENT_THREADS)) {
      try {
        const url = `https://oauth.reddit.com/comments/${encodeURIComponent(post.id)}?limit=100&depth=2&sort=new&raw_json=1`;
        const response = await timedFetch(url, {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "PostAutomation/1.0" },
        });
        if (response.status === 401) {
          tokenCache.delete("reddit");
          break;
        }
        if (!response.ok) {
          console.warn(`[ListeningSync:Reddit] comments HTTP ${response.status} for post ${post.id}`);
          continue;
        }
        mentions.push(...redditCommentsFromListing(await response.json(), post, keywords));
      } catch (err) {
        console.warn(`[ListeningSync:Reddit] comments failed for post ${post.id}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[ListeningSync:Reddit] Failed:`, err);
  }
  return mentions;
};

/** Matching Reddit posts whose comments are read per sweep (one request each). */
const REDDIT_COMMENT_THREADS = 5;

// ---------------------------------------------------------------------------
// YouTube (2026-10-05) — videos matching the keywords, and their comments.
// See listening-comments.ts for the quota rules: a daily unit cap shared with
// nothing else in listening, a 6-hour cadence per query, fail-closed.
// ---------------------------------------------------------------------------

let ytRedis: ReturnType<typeof createRedisConnection> | null = null;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}
const ytUnitCounter: UnitCounter = {
  async incrBy(day, units) {
    ytRedis ??= createRedisConnection();
    const key = `listening:yt-units:${day}`;
    const total = await withTimeout(ytRedis.incrby(key, units), 2_000);
    void ytRedis.expire(key, 2 * 24 * 60 * 60).catch(() => {});
    return total;
  },
  async decrBy(day, units) {
    ytRedis ??= createRedisConnection();
    await withTimeout(ytRedis.decrby(`listening:yt-units:${day}`, units), 2_000);
  },
};
/** Set when Google answers quotaExceeded — no more YouTube calls that Pacific day. */
let ytQuotaExhaustedDay: string | null = null;

/** Test seam. */
export function __setYouTubeUnitCounter(counter: UnitCounter | null) {
  Object.assign(ytUnitCounterOverride, { counter });
  ytQuotaExhaustedDay = null;
}
const ytUnitCounterOverride: { counter: UnitCounter | null } = { counter: null };

type YtAuth = { kind: "key"; key: string } | { kind: "token"; token: string; channelId: string };

function ytUrl(path: string, params: Record<string, string>, auth: YtAuth): string {
  const qs = new URLSearchParams(params);
  if (auth.kind === "key") qs.set("key", auth.key);
  return `https://www.googleapis.com/youtube/v3/${path}?${qs.toString()}`;
}

function ytHeaders(auth: YtAuth): Record<string, string> {
  return auth.kind === "token" ? { Authorization: `Bearer ${auth.token}` } : {};
}

const fetchYouTubeMentions: Fetcher = async ({ keywords, language, queryId, interactive, channels }) => {
  const cfg = readYouTubeListeningConfig();
  const now = new Date();
  if (cfg.dailyUnits <= 0) return [];
  if (ytQuotaExhaustedDay === quotaDay(now)) return [];
  const bucket = Math.floor(Date.now() / LISTENING_SYNC_INTERVAL_MS);
  if (!isYouTubeTurn(queryId, bucket, cfg.everyRuns, interactive)) return [];

  // Auth: a configured API key, else the workspace's connected YouTube
  // channels' tokens (youtube.readonly), freshest first, falling over on 401.
  const auths: YtAuth[] = [];
  if (process.env.YOUTUBE_API_KEY) auths.push({ kind: "key", key: process.env.YOUTUBE_API_KEY });
  for (const ch of (await channels()).filter((c) => c.platform === "YOUTUBE").slice(0, 3)) {
    auths.push({ kind: "token", token: ch.accessToken, channelId: ch.id });
  }
  if (auths.length === 0) return [];

  const counter = ytUnitCounterOverride.counter ?? ytUnitCounter;
  const reserve = (units: number) => reserveYouTubeUnits(counter, units, cfg.dailyUnits, now);
  let authIndex = 0;

  /** One call with auth fall-over on 401; null = give up on YouTube for this sweep. */
  const call = async (path: string, params: Record<string, string>, units: number): Promise<{ ok: boolean; body: any } | null> => {
    if (!(await reserve(units))) {
      console.warn(`[ListeningSync:YouTube] daily unit cap (${cfg.dailyUnits}) reached or unavailable — skipping`);
      return null;
    }
    while (authIndex < auths.length) {
      const auth = auths[authIndex]!;
      const response = await timedFetch(ytUrl(path, params, auth), { headers: ytHeaders(auth) });
      const body: any = await response.json().catch(() => null);
      if (response.status === 401) {
        authIndex++;
        continue;
      }
      if (isQuotaError(body)) {
        ytQuotaExhaustedDay = quotaDay(now);
        console.warn(`[ListeningSync:YouTube] Google reports the project's YouTube quota is used up for today — stopping`);
        return null;
      }
      return { ok: response.ok, body };
    }
    console.warn(`[ListeningSync:YouTube] no working credential (API key or connected YouTube channel) — skipping`);
    return null;
  };

  const mentions: RawMention[] = [];
  const publishedAfter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const lang = /^[a-z]{2}$/i.test(language) ? language.toLowerCase() : "en";
  try {
    for (const group of chunkKeywords(keywords, { maxPerChunk: 5, maxChars: 400 })) {
      const search = await call(
        "search",
        {
          part: "snippet",
          type: "video",
          q: youtubeQuery(group),
          order: "date",
          publishedAfter,
          relevanceLanguage: lang,
          maxResults: String(cfg.videosPerSearch),
        },
        YT_UNITS.search
      );
      if (!search) break;
      if (!search.ok) {
        console.warn(`[ListeningSync:YouTube] search failed: ${JSON.stringify(search.body?.error?.errors?.[0] ?? search.body?.error ?? null)}`);
        continue;
      }
      const videos = youtubeVideosFromSearch(search.body);
      if (videos.length === 0) continue;

      const statsRes = await call("videos", { part: "statistics", id: videos.map((v) => v.id).join(",") }, YT_UNITS.videos);
      const stats = statsRes?.ok ? youtubeStatsById(statsRes.body) : new Map();
      for (const v of videos) mentions.push(youtubeVideoMention(v, stats.get(v.id)));
      if (!statsRes) break;

      const withComments = [...videos]
        .filter((v) => (stats.get(v.id)?.comments ?? 1) > 0)
        .sort((a, b) => (stats.get(b.id)?.comments ?? 0) - (stats.get(a.id)?.comments ?? 0))
        .slice(0, cfg.commentVideos);
      for (const v of withComments) {
        const threads = await call(
          "commentThreads",
          { part: "snippet", videoId: v.id, maxResults: "50", order: "time", textFormat: "plainText" },
          YT_UNITS.commentThreads
        );
        if (!threads) return mentions;
        if (!threads.ok) {
          if (!isPerVideoCommentError(threads.body)) {
            console.warn(`[ListeningSync:YouTube] comments failed for ${v.id}: ${JSON.stringify(threads.body?.error?.errors?.[0] ?? null)}`);
          }
          continue;
        }
        mentions.push(...youtubeCommentsFromThreads(threads.body, v, keywords));
      }
    }
  } catch (err) {
    console.warn(`[ListeningSync:YouTube] Failed:`, err);
  }
  return mentions;
};

/** How many Instagram accounts to try per hashtag before giving up (dead tokens). */
const IG_PROBE_CHANNELS = 3;

/**
 * Instagram hashtag search. A hashtag's recent media is GLOBAL — it does not
 * depend on which account asks — so the sweep runs on ONE account and only
 * falls over to the next when that account's token is refused. The old code
 * ran it on EVERY connected IG channel: an org with 110 channels spent 220
 * Graph calls per keyword per run against the Meta app quota the publish
 * worker shares (and Meta caps hashtag lookups at 30 per account per week).
 */
const fetchInstagramMentions: Fetcher = async ({ keywords, channels }) => {
  const mentions: RawMention[] = [];
  const igChannels = (await channels()).filter((c) => c.platform === "INSTAGRAM").slice(0, IG_PROBE_CHANNELS);
  if (igChannels.length === 0) return [];

  for (const keyword of cleanKeywords(keywords)) {
    const hashtagClean = keyword.replace(/^#/, "").replace(/\s+/g, "");
    if (!hashtagClean) continue;
    for (const channel of igChannels) {
      try {
        const searchUrl = `https://graph.facebook.com/v18.0/ig_hashtag_search?q=${encodeURIComponent(hashtagClean)}&user_id=${channel.platformId}&access_token=${channel.accessToken}`;
        const searchRes = await timedFetch(searchUrl);
        if (!searchRes.ok) continue; // token refused → try the next account
        const searchData = await searchRes.json() as any;
        const hashtagId = searchData.data?.[0]?.id;
        if (!hashtagId) break; // the hashtag does not exist; no account will find it

        const mediaUrl = `https://graph.facebook.com/v18.0/${hashtagId}/recent_media?user_id=${channel.platformId}&fields=id,caption,timestamp,permalink,like_count,comments_count,media_url&access_token=${channel.accessToken}&limit=15`;
        const mediaRes = await timedFetch(mediaUrl);
        if (!mediaRes.ok) continue;
        const mediaData = await mediaRes.json() as any;

        for (const post of mediaData.data || []) {
          if (!post.caption) continue;
          mentions.push({
            source: "INSTAGRAM",
            platformPostId: post.id,
            sourceUrl: post.permalink || null,
            authorName: null,
            authorHandle: null,
            authorAvatar: null,
            content: post.caption.slice(0, 500),
            mentionedAt: new Date(post.timestamp),
            // reach/impressions need the IG Insights endpoint (own media only).
            reach: 0,
            engagements: (post.like_count || 0) + (post.comments_count || 0),
            metadata: { platform: "instagram", mediaUrl: post.media_url, hashtag: hashtagClean },
          });
        }
        break; // one account answered; the result is the same on every other account
      } catch {
        // try the next account
      }
    }
  }
  return mentions;
};

/**
 * LinkedIn has no public search API; the only readable surface is the
 * connected Page's OWN posts. Read each Page ONCE per run (not once per
 * keyword), keep the posts that mention any keyword, and enrich those with
 * engagement counts. The post URN is the identity and yields a real permalink
 * — before this the mention had no URL and was re-inserted every run.
 */
const fetchLinkedInMentions: Fetcher = async ({ keywords, channels }) => {
  const mentions: RawMention[] = [];
  const liChannels = (await channels()).filter((c) => c.platform === "LINKEDIN");
  const kws = cleanKeywords(keywords);
  if (liChannels.length === 0 || kws.length === 0) return [];

  for (const channel of liChannels) {
    try {
      const headers = {
        Authorization: `Bearer ${channel.accessToken}`,
        "LinkedIn-Version": "202401",
        "X-Restli-Protocol-Version": "2.0.0",
      };
      const url = `https://api.linkedin.com/rest/posts?q=author&author=urn:li:organization:${channel.platformId}&count=20`;
      const response = await timedFetch(url, { headers });
      if (!response.ok) continue;

      const data = await response.json() as any;
      for (const post of data.elements || []) {
        const text = post.commentary || post.content?.article?.description || "";
        if (!matchesAnyKeyword(text, kws)) continue;

        // Engagement counts live on a separate socialActions node; best-effort.
        let engagements = 0;
        if (post.id) {
          try {
            const saRes = await timedFetch(`https://api.linkedin.com/rest/socialActions/${encodeURIComponent(post.id)}`, { headers });
            if (saRes.ok) {
              const sa = (await saRes.json()) as any;
              const likes = sa.likesSummary?.totalLikes ?? sa.likesSummary?.aggregatedTotalLikes ?? 0;
              const comments = sa.commentsSummary?.aggregatedTotalComments ?? sa.commentsSummary?.totalFirstLevelComments ?? 0;
              engagements = (likes || 0) + (comments || 0);
            }
          } catch {
            // socialActions unavailable — leave engagements at 0.
          }
        }

        mentions.push({
          source: "LINKEDIN",
          platformPostId: post.id || null,
          sourceUrl: linkedInPostUrl(post.id),
          authorName: channel.name,
          authorHandle: null,
          authorAvatar: null,
          content: text.slice(0, 500),
          mentionedAt: new Date(post.createdAt || Date.now()),
          // reach needs organizationalEntityShareStatistics + r_organization_social.
          reach: 0,
          engagements,
          metadata: { platform: "linkedin", postUrn: post.id },
        });
      }
    } catch (err) {
      console.warn(`[ListeningSync:LinkedIn] Failed for channel ${channel.id}:`, err);
    }
  }
  return mentions;
};

/** Facebook Pages whose /tagged edge is read per run; the rest rotate in on the following runs. */
const FB_LISTENING_PAGES_PER_RUN = (() => {
  const n = Number.parseInt(process.env.FB_LISTENING_PAGES_PER_RUN ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 20;
})();

const FB_TAGGED_FIELDS_FULL =
  "id,message,story,created_time,tagged_time,permalink_url,from{id,name,picture{url}},shares,reactions.summary(true),comments.summary(true)";
const FB_TAGGED_FIELDS_MINIMAL = "id,message,story,created_time,tagged_time,permalink_url";

/**
 * Facebook has NO keyword search for anyone — Graph's post search needs
 * Public Content Access, which Meta stopped granting. What a Page token CAN
 * read is the Page's own `/tagged` edge: "all public posts in which the page
 * has been tagged" (pages_read_user_content + pages_show_list — both approved
 * for the live app on 2026-08-06, so no App Review and no reconnect). That is
 * brand monitoring in the literal sense: other people's public posts that
 * name the Page.
 *
 * A post counts when a keyword matches its text OR the Page's own name (a
 * query about "Acme" on the Acme Page wants every post tagging it). ONE Graph
 * call per Page per run, Pages deduped by id (the same Page sits in several
 * channel rows), and only FB_LISTENING_PAGES_PER_RUN Pages per run in a
 * rotating window — these calls count against the Meta app quota the publish
 * worker shares, and this org alone has hundreds of Pages. A dead token or a
 * Page whose connecting user lacks the MODERATE task answers with an error and
 * contributes nothing. Two-rung field ladder: Graph only validates field names
 * on a NON-empty edge, so a renamed field surfaces late — on `#100 nonexisting
 * field` retry once with the minimal set.
 */
const fetchFacebookTagged: Fetcher = async ({ keywords, channels }) => {
  const mentions: RawMention[] = [];
  const kws = cleanKeywords(keywords);
  if (kws.length === 0) return [];
  const pages = uniqueByPlatformId((await channels()).filter((c) => c.platform === "FACEBOOK"));
  if (pages.length === 0) return [];
  const bucket = Math.floor(Date.now() / LISTENING_SYNC_INTERVAL_MS);

  for (const page of rotateWindow(pages, FB_LISTENING_PAGES_PER_RUN, bucket)) {
    try {
      let posts: any[] | null = null;
      for (const fields of [FB_TAGGED_FIELDS_FULL, FB_TAGGED_FIELDS_MINIMAL]) {
        const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(page.platformId)}/tagged?fields=${encodeURIComponent(fields)}&limit=25&access_token=${encodeURIComponent(page.accessToken)}`;
        const res = await timedFetch(url);
        const body = (await res.json().catch(() => ({}))) as any;
        if (res.ok) {
          posts = Array.isArray(body?.data) ? body.data : [];
          break;
        }
        const err = body?.error ?? {};
        const fieldError = err.code === 100 && /nonexisting field|tried accessing/i.test(String(err.message ?? ""));
        if (fieldError && fields === FB_TAGGED_FIELDS_FULL) {
          console.warn(`[ListeningSync:Facebook] field set rejected for Page ${page.platformId} — retrying minimal: ${err.message}`);
          continue;
        }
        console.warn(`[ListeningSync:Facebook] /tagged refused for Page ${page.platformId} (${page.name}): HTTP ${res.status} code=${err.code ?? "?"} sub=${err.error_subcode ?? "-"} ${String(err.message ?? "").slice(0, 160)}`);
        break;
      }
      if (!posts) continue;

      for (const post of posts) {
        const text = [post.message, post.story].filter((t) => typeof t === "string" && t.trim()).join(" ");
        if (!matchesAnyKeyword(`${text} ${page.name}`, kws)) continue;
        const reactions = post.reactions?.summary?.total_count ?? 0;
        const comments = post.comments?.summary?.total_count ?? 0;
        const shares = post.shares?.count ?? 0;
        mentions.push({
          source: "FACEBOOK",
          platformPostId: typeof post.id === "string" ? post.id : null,
          sourceUrl: typeof post.permalink_url === "string" ? post.permalink_url : null,
          // `from` is only returned for the requester's own posts; a stranger's post has no author here.
          authorName: post.from?.name ?? null,
          authorHandle: null,
          authorAvatar: post.from?.picture?.data?.url ?? null,
          content: (text || `Tagged ${page.name}`).slice(0, 500),
          mentionedAt: new Date(post.tagged_time || post.created_time || Date.now()),
          reach: 0,
          engagements: (reactions || 0) + (comments || 0) + (shares || 0),
          metadata: { platform: "facebook", taggedPageId: page.platformId, taggedPageName: page.name },
        });
      }
    } catch (err) {
      console.warn(`[ListeningSync:Facebook] Failed for Page ${page.platformId}:`, err);
    }
  }
  return mentions;
};

/** TikTok Research API — client token (cached) + ONE query carrying every keyword (`IN` takes a list). */
const fetchTikTokMentions: Fetcher = async ({ keywords }) => {
  const clientKey = process.env.TIKTOK_CLIENT_ID || process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret) return [];
  const kws = cleanKeywords(keywords);
  if (kws.length === 0) return [];

  const mentions: RawMention[] = [];
  try {
    const token = await cachedToken("tiktok", async () => {
      const tokenRes = await timedFetch("https://open.tiktokapis.com/v2/oauth/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `client_key=${encodeURIComponent(clientKey)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
      });
      if (!tokenRes.ok) return null;
      const body = await tokenRes.json() as { access_token?: string; expires_in?: number };
      return body.access_token ? { token: body.access_token, ttlSec: body.expires_in ?? 7200 } : null;
    });
    if (!token) return [];

    const searchRes = await timedFetch("https://open.tiktokapis.com/v2/research/video/query/", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: { and: [{ operation: "IN", field_name: "keyword", field_values: kws.slice(0, 20) }] },
        start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        end_date: new Date().toISOString().split("T")[0],
        max_count: Math.min(100, 15 * kws.length),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (searchRes.status === 401) tokenCache.delete("tiktok");
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json() as any;
    for (const video of searchData.data?.videos || []) {
      mentions.push({
        source: "TIKTOK",
        platformPostId: video.id != null ? String(video.id) : null,
        sourceUrl: video.share_url || null,
        authorName: video.username || null,
        authorHandle: video.username ? `@${video.username}` : null,
        authorAvatar: null,
        content: video.video_description || video.title || kws[0]!,
        mentionedAt: new Date(video.create_time * 1000),
        reach: video.view_count || 0,
        engagements: (video.like_count || 0) + (video.comment_count || 0) + (video.share_count || 0),
        metadata: { platform: "tiktok", videoId: video.id },
      });
    }
  } catch (err) {
    console.warn(`[ListeningSync:TikTok] Failed:`, err);
  }
  return mentions;
};

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

// Facebook is NOT a keyword search (graph.facebook.com/search?type=post needs
// Public Content Access, which Meta no longer grants) — it is the connected
// Pages' own /tagged edge; see fetchFacebookTagged.
const PLATFORM_FETCHERS: Record<string, Fetcher> = {
  twitter: fetchTwitterMentions,
  x: fetchTwitterMentions,
  reddit: fetchRedditMentions,
  instagram: fetchInstagramMentions,
  facebook: fetchFacebookTagged,
  linkedin: fetchLinkedInMentions,
  youtube: fetchYouTubeMentions,
  tiktok: fetchTikTokMentions,
  news: fetchGoogleNews,
};
const DEFAULT_PLATFORMS = ["twitter", "reddit", "instagram", "facebook", "linkedin", "tiktok", "news", "youtube"];

/** Test seam: the per-platform fetchers, callable with a hand-built context. */
export const __listeningFetchers = {
  news: fetchGoogleNews,
  facebook: fetchFacebookTagged,
  reddit: fetchRedditMentions,
  youtube: fetchYouTubeMentions,
};

/** Rows per createMany statement (keeps one statement's parameter list bounded). */
const INSERT_CHUNK = 500;

/**
 * Queries with a sweep in progress in THIS process. A second job for the same
 * query (a manual Sync Now landing during the cron sweep) is skipped rather
 * than run concurrently — the sweep it would duplicate finished seconds ago.
 */
const inFlightQueries = new Set<string>();

export function createListeningSyncWorker() {
  const worker = new Worker<ListeningSyncJobData>(
    QUEUE_NAMES.LISTENING_SYNC,
    async (job: Job<ListeningSyncJobData>) => {
      const { listeningQueryId, organizationId } = job.data;
      if (inFlightQueries.has(listeningQueryId)) {
        console.log(`[ListeningSync] query ${listeningQueryId} already syncing in this process — skipping job ${job.id}`);
        return { skipped: true, reason: "already_running" };
      }
      inFlightQueries.add(listeningQueryId);
      try {
        // A person asked (Sync Now / new query) — see listening-jobs.ts for the id shapes.
        const interactive = /:(manual-|create$)/.test(String(job.id ?? ""));
        return await syncListeningQuery(listeningQueryId, organizationId, interactive);
      } finally {
        inFlightQueries.delete(listeningQueryId);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[ListeningSync] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function syncListeningQuery(listeningQueryId: string, organizationId: string, interactive = false) {
      const startedAt = Date.now();
      const requestsBefore = requestCounter;

      const query = await prisma.listeningQuery.findUnique({ where: { id: listeningQueryId } });
      if (!query || !query.isActive) {
        return { skipped: true, reason: "inactive_or_not_found" };
      }

      const keywords = cleanKeywords(query.keywords);
      if (keywords.length === 0) {
        await prisma.listeningQuery.update({ where: { id: listeningQueryId }, data: { lastSyncAt: new Date() } });
        return { skipped: true, reason: "no_keywords" };
      }

      // Resolve each platform name ONCE (x ⇒ twitter) so a query listing both does not sweep Twitter twice.
      const platformsToSearch = [...new Set(
        (query.platforms.length > 0 ? query.platforms.map((p) => p.toLowerCase()) : DEFAULT_PLATFORMS)
          .filter((p) => PLATFORM_FETCHERS[p])
          .map((p) => (p === "x" ? "twitter" : p))
      )];

      // Channels are read once per job, lazily, and only by the platforms that need a token.
      // DIRECT channel.findMany is the decrypting shape (the $extends in @postautomation/db).
      let channelsPromise: Promise<ListeningChannel[]> | null = null;
      const channels = () => {
        channelsPromise ??= prisma.channel.findMany({
          where: {
            organizationId,
            isActive: true,
            disconnectedAt: null,
            platform: { in: ["INSTAGRAM", "FACEBOOK", "LINKEDIN", "YOUTUBE"] },
          },
          select: { id: true, platform: true, platformId: true, name: true, accessToken: true },
          // Most recently (re)connected first — the freshest token leads the IG probe order.
          orderBy: { updatedAt: "desc" },
        });
        return channelsPromise;
      };

      const ctx: FetchContext = {
        keywords,
        language: query.language || "en",
        organizationId,
        queryId: listeningQueryId,
        interactive,
        channels,
      };

      // 1. Fetch — all selected platforms in parallel, each as few requests as it allows.
      const perPlatform = await Promise.all(
        platformsToSearch.map(async (platform) => {
          const t0 = Date.now();
          try {
            const found = await PLATFORM_FETCHERS[platform]!(ctx);
            return { platform, found, ms: Date.now() - t0 };
          } catch (err) {
            console.warn(`[ListeningSync] ${platform} fetch failed for query ${listeningQueryId}:`, err);
            return { platform, found: [] as RawMention[], ms: Date.now() - t0 };
          }
        })
      );
      const raws = perPlatform.flatMap((p) => p.found);

      // 2. ONE read of what this query already holds among the candidates.
      const { keys, urls } = candidateIdentities(raws);
      const existing = raws.length === 0
        ? []
        : await prisma.mention.findMany({
            where: {
              listeningQueryId,
              OR: [
                { dedupKey: { in: keys } },
                ...(urls.length > 0 ? [{ sourceUrl: { in: urls } }] : []),
              ],
            },
            select: { dedupKey: true, sourceUrl: true },
          });
      const existingKeys = new Set(existing.map((e) => e.dedupKey).filter((k): k is string => !!k));
      const existingUrls = new Set(existing.map((e) => e.sourceUrl).filter((u): u is string => !!u));

      const plan = planMentionBatch(raws, { excludeWords: query.excludeWords, existingKeys, existingUrls });

      // 3. ONE insert per 500 rows. skipDuplicates is inert until the dedupKey
      //    index is made unique by hand (schema comment) — the in-process lock
      //    and the bucketed job ids are what keep concurrent sweeps apart today.
      const created: SentimentMentionInput[] = [];
      for (const rows of chunk(plan.rows, INSERT_CHUNK)) {
        const inserted = await prisma.mention.createManyAndReturn({
          data: rows.map((raw) => ({
            listeningQueryId,
            source: raw.source,
            sourceUrl: raw.sourceUrl,
            authorName: raw.authorName,
            authorHandle: raw.authorHandle,
            authorAvatar: raw.authorAvatar,
            content: raw.content.slice(0, 5000),
            mentionedAt: raw.mentionedAt,
            reach: raw.reach,
            engagements: raw.engagements,
            metadata: (raw.metadata as any) ?? undefined,
            dedupKey: raw.dedupKey,
          })),
          skipDuplicates: true,
          select: { id: true, content: true },
        });
        for (const m of inserted) created.push({ mentionId: m.id, content: m.content.slice(0, 500) });
      }

      // 4. Sentiment: SENTIMENT_BATCH_SIZE mentions per model call, all jobs in one Redis round trip.
      if (created.length > 0) {
        await sentimentAnalysisQueue.addBulk(
          chunk(created, SENTIMENT_BATCH_SIZE).map((mentions) => ({
            name: "sentiment-batch",
            data: { mentions },
            opts: { removeOnComplete: true, removeOnFail: 100 },
          }))
        );
      }

      await prisma.listeningQuery.update({ where: { id: listeningQueryId }, data: { lastSyncAt: new Date() } });

      // 5. Alerts — compared against a real baseline, at most once per type per 24h.
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
      let alertsCreated = 0;

      if (hasSurgeBaseline(query.createdAt, now)) {
        const [recentCount, previousCount, scoredBySentiment, recentAlerts] = await Promise.all([
          prisma.mention.count({ where: { listeningQueryId, mentionedAt: { gte: oneDayAgo } } }),
          prisma.mention.count({ where: { listeningQueryId, mentionedAt: { gte: twoDaysAgo, lt: oneDayAgo } } }),
          // Only SCORED mentions count toward the negative ratio: the rows this
          // run just inserted are still NEUTRAL placeholders until their
          // sentiment job lands, and counting them diluted every ratio.
          prisma.mention.groupBy({
            by: ["sentiment"],
            where: { listeningQueryId, mentionedAt: { gte: oneDayAgo }, sentimentScore: { not: null } },
            _count: { _all: true },
          }),
          prisma.sentimentAlert.findMany({
            where: {
              listeningQueryId,
              type: { in: ["volume_surge", "spike_negative"] },
              triggeredAt: { gte: new Date(now.getTime() - ALERT_COOLDOWN_MS) },
            },
            select: { type: true, triggeredAt: true },
            orderBy: { triggeredAt: "desc" },
          }),
        ]);
        const lastAlertOf = (type: string) => recentAlerts.find((a) => a.type === type)?.triggeredAt ?? null;

        if (previousCount > 0 && recentCount >= previousCount * 2 && !alertOnCooldown(lastAlertOf("volume_surge"), now)) {
          await prisma.sentimentAlert.create({
            data: {
              listeningQueryId,
              type: "volume_surge",
              title: `Mention volume surge for "${query.name}"`,
              description: `Mentions increased from ${previousCount} to ${recentCount} in the last 24 hours (${Math.round((recentCount / previousCount - 1) * 100)}% increase).`,
              severity: recentCount >= previousCount * 5 ? "critical" : "high",
            },
          });
          alertsCreated++;
        }

        const scoredTotal = scoredBySentiment.reduce((n, g) => n + g._count._all, 0);
        const recentNegative = scoredBySentiment.find((g) => g.sentiment === "NEGATIVE")?._count._all ?? 0;
        if (scoredTotal > 0 && recentNegative / scoredTotal > 0.5 && recentNegative >= 3 && !alertOnCooldown(lastAlertOf("spike_negative"), now)) {
          await prisma.sentimentAlert.create({
            data: {
              listeningQueryId,
              type: "spike_negative",
              title: `Negative sentiment spike for "${query.name}"`,
              description: `${recentNegative} out of ${scoredTotal} scored mentions in the last 24 hours are negative (${Math.round((recentNegative / scoredTotal) * 100)}%).`,
              severity: "high",
            },
          });
          alertsCreated++;
        }
      }

      const summary = perPlatform.map((p) => `${p.platform}=${p.found.length}/${p.ms}ms`).join(" ");
      console.log(
        `[ListeningSync] query=${listeningQueryId} keywords=${keywords.length} requests=${requestCounter - requestsBefore} ` +
        `raw=${raws.length} new=${created.length} skipped(excluded=${plan.skipped.excluded} dup=${plan.skipped.duplicateInBatch} stored=${plan.skipped.alreadyStored}) ` +
        `alerts=${alertsCreated} ${Date.now() - startedAt}ms [${summary}]`
      );
      return { mentionsCreated: created.length, alertsCreated };
}
