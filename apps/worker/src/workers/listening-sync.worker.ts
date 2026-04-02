import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import type { MentionSource } from "@postautomation/db";
import {
  QUEUE_NAMES,
  sentimentAnalysisQueue,
  type ListeningSyncJobData,
  createRedisConnection,
} from "@postautomation/queue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface RawMention {
  source: MentionSource;
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

// ---------------------------------------------------------------------------
// Platform fetchers
// ---------------------------------------------------------------------------

/** Google News RSS — free, no auth */
async function fetchGoogleNews(keyword: string, lang: string): Promise<RawMention[]> {
  const mentions: RawMention[] = [];
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=${lang}`;
    const response = await fetch(rssUrl, { signal: AbortSignal.timeout(10_000) });
    const xml = await response.text();
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    for (const item of items.slice(0, 10)) {
      const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
        || item.match(/<title>(.*?)<\/title>/)?.[1]
        || "";
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1];
      const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News";
      if (!title) continue;

      mentions.push({
        source: "NEWS",
        sourceUrl: link,
        authorName: source,
        authorHandle: null,
        authorAvatar: null,
        content: title,
        mentionedAt: pubDate ? new Date(pubDate) : new Date(),
        reach: 0,
        engagements: 0,
      });
    }
  } catch (err) {
    console.warn(`[ListeningSync:GoogleNews] Failed for "${keyword}":`, err);
  }
  return mentions;
}

/** Twitter/X — uses Bearer Token for recent search API v2 */
async function fetchTwitterMentions(keyword: string): Promise<RawMention[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) return [];

  const mentions: RawMention[] = [];
  try {
    const query = encodeURIComponent(`${keyword} -is:retweet lang:en`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=name,username,profile_image_url`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[ListeningSync:Twitter] Search failed: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    const users = new Map<string, any>();
    for (const u of data.includes?.users || []) {
      users.set(u.id, u);
    }

    for (const tweet of data.data || []) {
      const user = users.get(tweet.author_id);
      const metrics = tweet.public_metrics || {};
      mentions.push({
        source: "TWITTER",
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
    console.warn(`[ListeningSync:Twitter] Failed for "${keyword}":`, err);
  }
  return mentions;
}

/** Reddit — uses client credentials search */
async function fetchRedditMentions(keyword: string): Promise<RawMention[]> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];

  const mentions: RawMention[] = [];
  try {
    // Get access token
    const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "PostAutomation/1.0",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return [];
    const { access_token } = await tokenRes.json() as { access_token: string };

    // Search
    const url = `https://oauth.reddit.com/search?q=${encodeURIComponent(keyword)}&sort=new&limit=15&t=day`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        "User-Agent": "PostAutomation/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];

    const data = await response.json() as any;
    for (const child of data.data?.children || []) {
      const p = child.data;
      if (p.stickied) continue;
      mentions.push({
        source: "REDDIT",
        sourceUrl: `https://reddit.com${p.permalink}`,
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
    console.warn(`[ListeningSync:Reddit] Failed for "${keyword}":`, err);
  }
  return mentions;
}

/** Facebook — search public pages mentioning keyword (requires page token) */
async function fetchFacebookMentions(keyword: string, organizationId: string): Promise<RawMention[]> {
  const mentions: RawMention[] = [];
  try {
    // Get connected Facebook channels with valid tokens
    const channels = await prisma.channel.findMany({
      where: { organizationId, platform: "FACEBOOK", isActive: true },
      select: { accessToken: true, name: true },
    });

    for (const channel of channels) {
      try {
        // Search public posts mentioning the keyword via Graph API
        const url = `https://graph.facebook.com/v18.0/search?q=${encodeURIComponent(keyword)}&type=post&fields=message,created_time,from,permalink_url,shares,reactions.summary(true),comments.summary(true)&limit=10&access_token=${channel.accessToken}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) continue;

        const data = await response.json() as any;
        for (const post of data.data || []) {
          if (!post.message) continue;
          mentions.push({
            source: "FACEBOOK",
            sourceUrl: post.permalink_url || null,
            authorName: post.from?.name || null,
            authorHandle: null,
            authorAvatar: null,
            content: post.message.slice(0, 500),
            mentionedAt: new Date(post.created_time),
            reach: 0,
            engagements: (post.reactions?.summary?.total_count || 0) + (post.comments?.summary?.total_count || 0) + (post.shares?.count || 0),
            metadata: { platform: "facebook" },
          });
        }
      } catch {
        // Token might not have search permissions, skip
      }
    }
  } catch (err) {
    console.warn(`[ListeningSync:Facebook] Failed for "${keyword}":`, err);
  }
  return mentions;
}

/** Instagram — search hashtag mentions via Graph API */
async function fetchInstagramMentions(keyword: string, organizationId: string): Promise<RawMention[]> {
  const mentions: RawMention[] = [];
  try {
    const channels = await prisma.channel.findMany({
      where: { organizationId, platform: "INSTAGRAM", isActive: true },
      select: { accessToken: true, platformId: true, name: true },
    });

    for (const channel of channels) {
      try {
        // Step 1: Search for hashtag ID
        const hashtagClean = keyword.replace(/^#/, "").replace(/\s+/g, "");
        const searchUrl = `https://graph.facebook.com/v18.0/ig_hashtag_search?q=${encodeURIComponent(hashtagClean)}&user_id=${channel.platformId}&access_token=${channel.accessToken}`;
        const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
        if (!searchRes.ok) continue;
        const searchData = await searchRes.json() as any;
        const hashtagId = searchData.data?.[0]?.id;
        if (!hashtagId) continue;

        // Step 2: Get recent media for this hashtag
        const mediaUrl = `https://graph.facebook.com/v18.0/${hashtagId}/recent_media?user_id=${channel.platformId}&fields=id,caption,timestamp,permalink,like_count,comments_count,media_url&access_token=${channel.accessToken}&limit=15`;
        const mediaRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(10_000) });
        if (!mediaRes.ok) continue;
        const mediaData = await mediaRes.json() as any;

        for (const post of mediaData.data || []) {
          if (!post.caption) continue;
          mentions.push({
            source: "INSTAGRAM",
            sourceUrl: post.permalink || null,
            authorName: null,
            authorHandle: null,
            authorAvatar: null,
            content: post.caption.slice(0, 500),
            mentionedAt: new Date(post.timestamp),
            reach: 0,
            engagements: (post.like_count || 0) + (post.comments_count || 0),
            metadata: { platform: "instagram", mediaUrl: post.media_url },
          });
        }
      } catch {
        // Hashtag search might not be available, skip
      }
    }
  } catch (err) {
    console.warn(`[ListeningSync:Instagram] Failed for "${keyword}":`, err);
  }
  return mentions;
}

/** LinkedIn — search for posts mentioning keyword via organization API */
async function fetchLinkedInMentions(keyword: string, organizationId: string): Promise<RawMention[]> {
  const mentions: RawMention[] = [];
  try {
    const channels = await prisma.channel.findMany({
      where: { organizationId, platform: "LINKEDIN", isActive: true },
      select: { accessToken: true, platformId: true, name: true },
    });

    for (const channel of channels) {
      try {
        // LinkedIn Content Search API (organization posts mentioning keyword)
        const url = `https://api.linkedin.com/rest/posts?q=author&author=urn:li:organization:${channel.platformId}&count=20`;
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${channel.accessToken}`,
            "LinkedIn-Version": "202401",
            "X-Restli-Protocol-Version": "2.0.0",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) continue;

        const data = await response.json() as any;
        for (const post of data.elements || []) {
          const text = post.commentary || post.content?.article?.description || "";
          if (!text.toLowerCase().includes(keyword.toLowerCase())) continue;

          mentions.push({
            source: "LINKEDIN",
            sourceUrl: null,
            authorName: channel.name,
            authorHandle: null,
            authorAvatar: null,
            content: text.slice(0, 500),
            mentionedAt: new Date(post.createdAt || Date.now()),
            reach: 0,
            engagements: 0,
            metadata: { platform: "linkedin", postUrn: post.id },
          });
        }
      } catch {
        // Skip on failure
      }
    }
  } catch (err) {
    console.warn(`[ListeningSync:LinkedIn] Failed for "${keyword}":`, err);
  }
  return mentions;
}

/** TikTok — search via public web endpoint (no auth required) */
async function fetchTikTokMentions(keyword: string): Promise<RawMention[]> {
  const mentions: RawMention[] = [];
  try {
    // TikTok Research API for keyword search (if available)
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientKey || !clientSecret) return [];

    // Get client access token
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_key=${clientKey}&client_secret=${clientSecret}&grant_type=client_credentials`,
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return [];
    const { access_token } = await tokenRes.json() as { access_token: string };

    // Query video search (Research API)
    const searchRes = await fetch("https://open.tiktokapis.com/v2/research/video/query/", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: { and: [{ operation: "IN", field_name: "keyword", field_values: [keyword] }] },
        start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        end_date: new Date().toISOString().split("T")[0],
        max_count: 15,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json() as any;
    for (const video of searchData.data?.videos || []) {
      mentions.push({
        source: "TIKTOK",
        sourceUrl: video.share_url || null,
        authorName: video.username || null,
        authorHandle: video.username ? `@${video.username}` : null,
        authorAvatar: null,
        content: video.video_description || video.title || keyword,
        mentionedAt: new Date(video.create_time * 1000),
        reach: video.view_count || 0,
        engagements: (video.like_count || 0) + (video.comment_count || 0) + (video.share_count || 0),
        metadata: { platform: "tiktok", videoId: video.id },
      });
    }
  } catch (err) {
    console.warn(`[ListeningSync:TikTok] Failed for "${keyword}":`, err);
  }
  return mentions;
}

// ---------------------------------------------------------------------------
// Main worker
// ---------------------------------------------------------------------------

// Map platform filter strings to fetcher functions
const PLATFORM_FETCHERS: Record<string, (keyword: string, orgId: string) => Promise<RawMention[]>> = {
  twitter: (kw) => fetchTwitterMentions(kw),
  x: (kw) => fetchTwitterMentions(kw),
  reddit: (kw) => fetchRedditMentions(kw),
  facebook: (kw, orgId) => fetchFacebookMentions(kw, orgId),
  instagram: (kw, orgId) => fetchInstagramMentions(kw, orgId),
  linkedin: (kw, orgId) => fetchLinkedInMentions(kw, orgId),
  tiktok: (kw) => fetchTikTokMentions(kw),
  news: (kw) => fetchGoogleNews(kw, "en"),
};

export function createListeningSyncWorker() {
  const worker = new Worker<ListeningSyncJobData>(
    QUEUE_NAMES.LISTENING_SYNC,
    async (job: Job<ListeningSyncJobData>) => {
      const { listeningQueryId, organizationId } = job.data;
      console.log(`[ListeningSync] Processing query ${listeningQueryId}`);

      const query = await prisma.listeningQuery.findUnique({
        where: { id: listeningQueryId },
      });

      if (!query || !query.isActive) {
        return { skipped: true, reason: "inactive_or_not_found" };
      }

      let mentionsCreated = 0;

      // Determine which platforms to search
      // If user specified platforms, use those; otherwise search all available
      const platformsToSearch = query.platforms.length > 0
        ? query.platforms.map((p) => p.toLowerCase())
        : ["twitter", "reddit", "facebook", "instagram", "linkedin", "tiktok", "news"];

      for (const keyword of query.keywords) {
        // Fetch from all platforms in parallel
        const fetchPromises = platformsToSearch.map((platform) => {
          const fetcher = PLATFORM_FETCHERS[platform];
          if (!fetcher) return Promise.resolve([] as RawMention[]);
          return fetcher(keyword, organizationId).catch((err) => {
            console.warn(`[ListeningSync] ${platform} fetch failed for "${keyword}":`, err);
            return [] as RawMention[];
          });
        });

        const results = await Promise.all(fetchPromises);
        const allMentions = results.flat();

        console.log(`[ListeningSync] Found ${allMentions.length} raw mentions for "${keyword}" across ${platformsToSearch.join(", ")}`);

        for (const raw of allMentions) {
          // Skip if excluded words are present
          const lower = raw.content.toLowerCase();
          if (query.excludeWords.some((w) => lower.includes(w.toLowerCase()))) continue;

          // Check for duplicates by sourceUrl or content hash
          if (raw.sourceUrl) {
            const existing = await prisma.mention.findFirst({
              where: { listeningQueryId: query.id, sourceUrl: raw.sourceUrl },
            });
            if (existing) continue;
          }

          const mention = await prisma.mention.create({
            data: {
              listeningQueryId: query.id,
              source: raw.source,
              sourceUrl: raw.sourceUrl,
              authorName: raw.authorName,
              authorHandle: raw.authorHandle,
              authorAvatar: raw.authorAvatar,
              content: raw.content.slice(0, 5000),
              mentionedAt: raw.mentionedAt,
              reach: raw.reach,
              engagements: raw.engagements,
              metadata: raw.metadata ?? undefined,
            },
          });

          // Queue sentiment analysis
          await sentimentAnalysisQueue.add(
            `sentiment-${mention.id}`,
            { mentionId: mention.id, content: raw.content.slice(0, 500) },
            { removeOnComplete: true, removeOnFail: 100 }
          );

          mentionsCreated++;
        }
      }

      // Update last sync time
      await prisma.listeningQuery.update({
        where: { id: listeningQueryId },
        data: { lastSyncAt: new Date() },
      });

      // Check for volume spikes and create alerts
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      const [recentCount, previousCount] = await Promise.all([
        prisma.mention.count({
          where: { listeningQueryId, mentionedAt: { gte: oneDayAgo } },
        }),
        prisma.mention.count({
          where: { listeningQueryId, mentionedAt: { gte: twoDaysAgo, lt: oneDayAgo } },
        }),
      ]);

      // Volume surge alert: 2x increase
      if (previousCount > 0 && recentCount >= previousCount * 2) {
        await prisma.sentimentAlert.create({
          data: {
            listeningQueryId,
            type: "volume_surge",
            title: `Mention volume surge for "${query.name}"`,
            description: `Mentions increased from ${previousCount} to ${recentCount} in the last 24 hours (${Math.round((recentCount / previousCount - 1) * 100)}% increase).`,
            severity: recentCount >= previousCount * 5 ? "critical" : "high",
          },
        });
      }

      // Negative sentiment spike alert
      const recentNegative = await prisma.mention.count({
        where: {
          listeningQueryId,
          mentionedAt: { gte: oneDayAgo },
          sentiment: "NEGATIVE",
        },
      });

      if (recentCount > 0 && recentNegative / recentCount > 0.5 && recentNegative >= 3) {
        await prisma.sentimentAlert.create({
          data: {
            listeningQueryId,
            type: "spike_negative",
            title: `Negative sentiment spike for "${query.name}"`,
            description: `${recentNegative} out of ${recentCount} mentions in the last 24 hours are negative (${Math.round((recentNegative / recentCount) * 100)}%).`,
            severity: "high",
          },
        });
      }

      console.log(`[ListeningSync] Done. Created ${mentionsCreated} new mentions for query ${listeningQueryId}`);
      return { mentionsCreated };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[ListeningSync] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[ListeningSync] Job ${job.id} completed`);
  });

  return worker;
}
