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
} from "../lib/listening-sync-plan";

/**
 * Listening sync (2026-10-04 rewrite — read apps/worker/src/lib/listening-sync-plan.ts first).
 *
 * One job = one ListeningQuery = one sweep of every selected platform. The
 * shape of a run is now:
 *   1. keywords → as FEW requests as each platform allows (OR-combined chunks
 *      for Twitter / Reddit / Google News / TikTok; one posts read per
 *      LinkedIn Page; one hashtag lookup per keyword on ONE Instagram account)
 *   2. one DB read for what is already stored, one planning pass in memory
 *   3. one createMany(skipDuplicates) — the (listeningQueryId, dedupKey)
 *      unique index is the idempotency guarantee, not a per-row findFirst
 *   4. sentiment jobs added in BULK, SENTIMENT_BATCH_SIZE mentions per job
 *   5. alerts, with a 24h cooldown per type
 *
 * Fetchers never throw: a platform that fails logs and contributes nothing.
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

/** Google News RSS — free, no auth. ONE request per keyword chunk, `hl` = the query's language. */
const fetchGoogleNews: Fetcher = async ({ keywords, language }) => {
  const mentions: RawMention[] = [];
  for (const group of chunkKeywords(keywords)) {
    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(orQuery(group))}&hl=${encodeURIComponent(language || "en")}`;
      const response = await timedFetch(rssUrl);
      if (!response.ok) continue;
      const xml = await response.text();
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

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
  } catch (err) {
    console.warn(`[ListeningSync:Reddit] Failed:`, err);
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

// Facebook is deliberately absent: graph.facebook.com/search?type=post needs
// the `public_content` permission (not granted), and every call would count
// against the shared Meta app quota the publish worker depends on.
const PLATFORM_FETCHERS: Record<string, Fetcher> = {
  twitter: fetchTwitterMentions,
  x: fetchTwitterMentions,
  reddit: fetchRedditMentions,
  instagram: fetchInstagramMentions,
  linkedin: fetchLinkedInMentions,
  tiktok: fetchTikTokMentions,
  news: fetchGoogleNews,
};
const DEFAULT_PLATFORMS = ["twitter", "reddit", "instagram", "linkedin", "tiktok", "news"];

/** Rows per createMany statement (keeps one statement's parameter list bounded). */
const INSERT_CHUNK = 500;

export function createListeningSyncWorker() {
  const worker = new Worker<ListeningSyncJobData>(
    QUEUE_NAMES.LISTENING_SYNC,
    async (job: Job<ListeningSyncJobData>) => {
      const { listeningQueryId, organizationId } = job.data;
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
          .filter((p) => p !== "facebook" && PLATFORM_FETCHERS[p])
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
            platform: { in: ["INSTAGRAM", "LINKEDIN"] },
          },
          select: { id: true, platform: true, platformId: true, name: true, accessToken: true },
          // Most recently (re)connected first — the freshest token leads the IG probe order.
          orderBy: { updatedAt: "desc" },
        });
        return channelsPromise;
      };

      const ctx: FetchContext = { keywords, language: query.language || "en", organizationId, channels };

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

      // 3. ONE insert per 500 rows; the unique index drops a concurrent duplicate
      //    (two jobs for the same query racing) instead of a second row.
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
