/**
 * Reddit comments and YouTube videos + comments for social listening
 * (2026-10-05) — the pure half: response parsers, the relevance rule, and the
 * YouTube quota/cadence decisions. The fetchers in listening-sync.worker.ts
 * make the calls.
 *
 * Relevance: a comment is kept when its own text contains a keyword, OR when
 * the post / video it sits under has a keyword in its TITLE. Search results
 * match on body text, tags and descriptions too, so a comment under a loosely
 * matched post must name the keyword itself to count.
 *
 * YouTube quota — the Data API's daily units are shared by the whole Google
 * Cloud project, which is the SAME project that publishes videos (one upload
 * costs 1,600 units). search.list costs 100 units, commentThreads.list and
 * videos.list cost 1. So YouTube listening:
 *   - runs for a query at most every YOUTUBE_LISTENING_EVERY_RUNS sweeps
 *     (default 12 × 30 min = every 6 hours), except when a person asks
 *     (Sync Now / a new query);
 *   - reserves its units from a DAILY cap (YOUTUBE_LISTENING_DAILY_UNITS,
 *     default 1,500) BEFORE each call, and stops when the cap is reached;
 *   - fails CLOSED: if the cap can't be checked, YouTube is skipped.
 */

import type { MentionSource } from "@postautomation/db";
import { matchesAnyKeyword, searchTerm } from "./listening-sync-plan";

export interface CommentMention {
  source: MentionSource;
  platformPostId: string | null;
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

export const COMMENT_TEXT_MAX = 1000;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function httpsOrNull(v: unknown): string | null {
  return typeof v === "string" && /^https:\/\//i.test(v) ? v : null;
}

/** Keep a comment whose text names a keyword, or that sits under a post/video whose TITLE does. */
export function isRelevantComment(text: string, parentTitle: string, keywords: string[]): boolean {
  return matchesAnyKeyword(text, keywords) || matchesAnyKeyword(parentTitle, keywords);
}

// ── Reddit ─────────────────────────────────────────────────────────────────

export interface RedditPostRef {
  id: string;
  title: string;
  permalink: string;
  subreddit: string;
  numComments: number;
}

/** The posts worth opening: those with comments, most-discussed first. */
export function pickRedditThreads(posts: RedditPostRef[], n: number): RedditPostRef[] {
  return posts
    .filter((p) => p.id && p.numComments > 0)
    .sort((a, b) => b.numComments - a.numComments)
    .slice(0, Math.max(0, n));
}

/**
 * Flatten the comment listing of `GET /comments/{id}` (top-level + one level
 * of replies), dropping deleted/removed comments, stickied/mod comments and
 * AutoModerator, then apply the relevance rule.
 */
export function redditCommentsFromListing(
  body: unknown,
  post: RedditPostRef,
  keywords: string[],
  max = 50
): CommentMention[] {
  const listing = Array.isArray(body) ? body[1] : null;
  const out: CommentMention[] = [];
  const visit = (children: unknown, depth: number) => {
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (out.length >= max) return;
      if (!child || (child as any).kind !== "t1") continue;
      const c = (child as any).data ?? {};
      const text = str(c.body).trim();
      const author = str(c.author);
      const skip =
        !text ||
        text === "[deleted]" ||
        text === "[removed]" ||
        author === "AutoModerator" ||
        c.stickied === true ||
        c.distinguished === "moderator";
      if (!skip && isRelevantComment(text, post.title, keywords)) {
        const created = Number(c.created_utc);
        out.push({
          source: "REDDIT",
          platformPostId: str(c.name) || (c.id ? `t1_${c.id}` : null),
          sourceUrl: c.permalink ? `https://reddit.com${c.permalink}` : null,
          authorName: `r/${post.subreddit}`,
          authorHandle: author && author !== "[deleted]" ? `u/${author}` : null,
          authorAvatar: null,
          content: text.slice(0, COMMENT_TEXT_MAX),
          mentionedAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000) : new Date(),
          reach: 0,
          engagements: num(c.ups ?? c.score),
          metadata: {
            kind: "comment",
            parentTitle: post.title.slice(0, 300),
            parentUrl: `https://reddit.com${post.permalink}`,
            subreddit: post.subreddit,
          },
        });
      }
      if (depth < 1 && c.replies && typeof c.replies === "object") visit(c.replies?.data?.children, depth + 1);
    }
  };
  visit((listing as any)?.data?.children, 0);
  return out;
}

// ── YouTube ────────────────────────────────────────────────────────────────

/** YouTube search accepts `|` for OR. Phrases stay quoted. */
export function youtubeQuery(keywords: string[]): string {
  return keywords.map(searchTerm).filter(Boolean).join("|");
}

export interface YouTubeVideoRef {
  id: string;
  title: string;
  description: string;
  channelTitle: string;
  channelId: string;
  publishedAt: string;
  thumbnail: string | null;
}

export function youtubeVideosFromSearch(body: unknown): YouTubeVideoRef[] {
  const items: any[] = Array.isArray((body as any)?.items) ? (body as any).items : [];
  const out: YouTubeVideoRef[] = [];
  for (const it of items) {
    const id = str(it?.id?.videoId);
    if (!id) continue;
    const s = it.snippet ?? {};
    out.push({
      id,
      title: str(s.title),
      description: str(s.description),
      channelTitle: str(s.channelTitle),
      channelId: str(s.channelId),
      publishedAt: str(s.publishedAt),
      thumbnail: httpsOrNull(s.thumbnails?.medium?.url) ?? httpsOrNull(s.thumbnails?.default?.url),
    });
  }
  return out;
}

/** videos.list?part=statistics → id → counts. */
export function youtubeStatsById(body: unknown): Map<string, { views: number; likes: number; comments: number }> {
  const out = new Map<string, { views: number; likes: number; comments: number }>();
  const items: any[] = Array.isArray((body as any)?.items) ? (body as any).items : [];
  for (const it of items) {
    const id = str(it?.id);
    if (!id) continue;
    const s = it.statistics ?? {};
    out.set(id, { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount) });
  }
  return out;
}

/**
 * The mention for the video itself. Titles from the API are HTML-escaped
 * ("&amp;", "&#39;"), so the few common entities are decoded.
 */
export function youtubeVideoMention(
  v: YouTubeVideoRef,
  stats: { views: number; likes: number; comments: number } | undefined
): CommentMention {
  const title = decodeEntities(v.title);
  const desc = decodeEntities(v.description);
  return {
    source: "YOUTUBE",
    platformPostId: `video:${v.id}`,
    sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
    authorName: v.channelTitle || null,
    authorHandle: null,
    authorAvatar: null,
    content: desc ? `${title}\n${desc.slice(0, 200)}` : title,
    mentionedAt: Number.isFinite(Date.parse(v.publishedAt)) ? new Date(v.publishedAt) : new Date(),
    reach: stats?.views ?? 0,
    engagements: (stats?.likes ?? 0) + (stats?.comments ?? 0),
    metadata: { kind: "video", videoId: v.id, channelId: v.channelId, thumbnail: v.thumbnail },
  };
}

/** commentThreads.list?part=snippet&textFormat=plainText → top-level comments, relevance-filtered. */
export function youtubeCommentsFromThreads(body: unknown, video: YouTubeVideoRef, keywords: string[]): CommentMention[] {
  const items: any[] = Array.isArray((body as any)?.items) ? (body as any).items : [];
  const title = decodeEntities(video.title);
  const out: CommentMention[] = [];
  for (const it of items) {
    const top = it?.snippet?.topLevelComment;
    const s = top?.snippet ?? {};
    const text = decodeEntities(str(s.textOriginal) || str(s.textDisplay)).trim();
    const id = str(top?.id) || str(it?.id);
    if (!text || !id) continue;
    if (!isRelevantComment(text, title, keywords)) continue;
    out.push({
      source: "YOUTUBE",
      platformPostId: `comment:${id}`,
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}&lc=${encodeURIComponent(id)}`,
      authorName: str(s.authorDisplayName) || null,
      authorHandle: null,
      authorAvatar: httpsOrNull(s.authorProfileImageUrl),
      content: text.slice(0, COMMENT_TEXT_MAX),
      mentionedAt: Number.isFinite(Date.parse(str(s.publishedAt))) ? new Date(str(s.publishedAt)) : new Date(),
      reach: 0,
      engagements: num(s.likeCount) + num(it?.snippet?.totalReplyCount),
      metadata: {
        kind: "comment",
        parentTitle: title.slice(0, 300),
        parentUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
        videoId: video.id,
      },
    });
  }
  return out;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
export function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|#39|lt|gt);/g, (m) => ENTITIES[m] ?? m);
}

/** "commentsDisabled" / "videoNotFound" etc. are per-video, not a reason to stop. */
export function isPerVideoCommentError(body: unknown): boolean {
  const reason = (body as any)?.error?.errors?.[0]?.reason;
  return reason === "commentsDisabled" || reason === "videoNotFound" || reason === "forbidden";
}

/** quotaExceeded / dailyLimitExceeded — stop YouTube for the rest of the day. */
export function isQuotaError(body: unknown): boolean {
  const reason = (body as any)?.error?.errors?.[0]?.reason;
  return reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded";
}

// ── Cadence + budget ───────────────────────────────────────────────────────

export interface YouTubeListeningConfig {
  dailyUnits: number;
  everyRuns: number;
  videosPerSearch: number;
  commentVideos: number;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readYouTubeListeningConfig(env: Record<string, string | undefined> = process.env): YouTubeListeningConfig {
  return {
    dailyUnits: intEnv(env, "YOUTUBE_LISTENING_DAILY_UNITS", 1500, 0, 100000),
    everyRuns: intEnv(env, "YOUTUBE_LISTENING_EVERY_RUNS", 12, 1, 48),
    videosPerSearch: 10,
    commentVideos: 5,
  };
}

export const YT_UNITS = { search: 100, videos: 1, commentThreads: 1 } as const;

/** Stable 32-bit hash of a string. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Is it this query's turn for YouTube? Every query gets one slot out of
 * `everyRuns` sweeps, spread by a hash of its id so they don't all land on
 * the same sweep. A person asking (Sync Now / creating the query) always runs.
 */
export function isYouTubeTurn(queryId: string, bucket: number, everyRuns: number, interactive: boolean): boolean {
  if (interactive) return true;
  if (everyRuns <= 1) return true;
  return ((Math.floor(bucket) % everyRuns) + everyRuns) % everyRuns === hash(queryId) % everyRuns;
}

/** Google resets the YouTube quota at midnight Pacific time; budget by that day. */
export function quotaDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export interface UnitCounter {
  /** Add `units` to today's counter and return the new total; throws when the store is unreachable. */
  incrBy(day: string, units: number): Promise<number>;
  decrBy(day: string, units: number): Promise<void>;
}

/**
 * Reserve `units` from today's cap. false when the cap would be exceeded or
 * the counter can't be reached (fail CLOSED — publishing shares this quota).
 */
export async function reserveYouTubeUnits(counter: UnitCounter, units: number, cap: number, now: Date = new Date()): Promise<boolean> {
  if (cap <= 0) return false;
  const day = quotaDay(now);
  let total: number;
  try {
    total = await counter.incrBy(day, units);
  } catch {
    return false;
  }
  if (total > cap) {
    try {
      await counter.decrBy(day, units);
    } catch {
      /* the over-count only makes the cap stricter */
    }
    return false;
  }
  return true;
}
