/**
 * More public sources for social listening (2026-10-05) — the pure half:
 * request builders and response parsers. Every source here is free and needs
 * no account; the fetchers in listening-sync.worker.ts make the calls.
 *
 *   Hacker News  hn.algolia.com search_by_date — stories and comments
 *   Bluesky      api.bsky.app app.bsky.feed.searchPosts (public AppView;
 *                public.api.bsky.app refuses unauthenticated search)
 *   Mastodon     /api/v1/timelines/tag/{tag} on the configured instances
 *                (keywords become hashtags — Mastodon has no public full-text search)
 *   Lemmy        /api/v3/search on the configured instance — posts and comments
 *   Bing News    news RSS (adds to Google News under the "news" source)
 *   GDELT        DOC 2.0 article list — worldwide, multilingual news;
 *                limited to ONE request every 5 seconds per IP
 *
 * Shapes were captured from live responses on 2026-10-05 (see the tests).
 */

import type { MentionSource } from "@postautomation/db";
import { matchesAnyKeyword, searchTerm } from "./listening-sync-plan";

export interface PublicMention {
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

export const TEXT_MAX = 2000;
const DAY = 24 * 60 * 60 * 1000;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function https(v: unknown): string | null {
  return typeof v === "string" && /^https:\/\//i.test(v) ? v : null;
}
function date(v: unknown, fallback = new Date()): Date {
  const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(t) ? new Date(t) : fallback;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** HTML (Mastodon, HN comments, Bing descriptions) → plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    // Hacker News opens paragraphs with a bare <p> and never closes them.
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+|#39);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Searches older than this are not worth asking for (and dedup keeps repeats out). */
export const PUBLIC_LOOKBACK_MS = 2 * DAY;

// ── Hacker News ────────────────────────────────────────────────────────────

export function hackerNewsUrl(keyword: string, now: number): string {
  const since = Math.floor((now - PUBLIC_LOOKBACK_MS) / 1000);
  const qs = new URLSearchParams({
    query: keyword,
    tags: "(story,comment)",
    numericFilters: `created_at_i>${since}`,
    hitsPerPage: "30",
  });
  return `https://hn.algolia.com/api/v1/search_by_date?${qs.toString()}`;
}

export function hackerNewsMentions(body: unknown): PublicMention[] {
  const hits: any[] = Array.isArray((body as any)?.hits) ? (body as any).hits : [];
  const out: PublicMention[] = [];
  for (const h of hits) {
    const id = str(h?.objectID);
    if (!id) continue;
    const tags: string[] = Array.isArray(h._tags) ? h._tags : [];
    const isComment = tags.includes("comment");
    const at = num(h.created_at_i) ? new Date(num(h.created_at_i) * 1000) : date(h.created_at);
    const author = str(h.author);
    if (isComment) {
      const text = htmlToText(str(h.comment_text));
      if (!text) continue;
      out.push({
        source: "HACKERNEWS",
        platformPostId: `hn:${id}`,
        sourceUrl: `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`,
        authorName: "Hacker News",
        authorHandle: author || null,
        authorAvatar: null,
        content: text.slice(0, TEXT_MAX),
        mentionedAt: at,
        reach: 0,
        engagements: 0,
        metadata: {
          kind: "comment",
          parentTitle: str(h.story_title).slice(0, 300),
          parentUrl: h.story_id ? `https://news.ycombinator.com/item?id=${encodeURIComponent(String(h.story_id))}` : null,
        },
      });
    } else {
      const title = str(h.title);
      if (!title) continue;
      const body = htmlToText(str(h.story_text));
      out.push({
        source: "HACKERNEWS",
        platformPostId: `hn:${id}`,
        sourceUrl: `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`,
        authorName: "Hacker News",
        authorHandle: author || null,
        authorAvatar: null,
        content: (body ? `${title}\n${body.slice(0, 300)}` : title).slice(0, TEXT_MAX),
        mentionedAt: at,
        reach: 0,
        engagements: num(h.points) + num(h.num_comments),
        metadata: { kind: "story", link: https(h.url), points: num(h.points), comments: num(h.num_comments) },
      });
    }
  }
  return out;
}

// ── Bluesky ────────────────────────────────────────────────────────────────

export function blueskySearchUrl(keyword: string, language: string, now: number): string {
  const qs = new URLSearchParams({
    q: keyword,
    sort: "latest",
    limit: "25",
    since: new Date(now - PUBLIC_LOOKBACK_MS).toISOString(),
  });
  if (/^[a-z]{2}$/i.test(language)) qs.set("lang", language.toLowerCase());
  return `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${qs.toString()}`;
}

/** at://did/app.bsky.feed.post/rkey → https://bsky.app/profile/{handle}/post/{rkey} */
export function blueskyPostUrl(uri: string, handle: string): string | null {
  const m = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/.exec(uri);
  if (!m) return null;
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${m[1]}`;
}

export function blueskyMentions(body: unknown): PublicMention[] {
  const posts: any[] = Array.isArray((body as any)?.posts) ? (body as any).posts : [];
  const out: PublicMention[] = [];
  for (const p of posts) {
    const uri = str(p?.uri);
    const text = str(p?.record?.text).trim();
    if (!uri || !text) continue;
    const handle = str(p.author?.handle);
    out.push({
      source: "BLUESKY",
      platformPostId: uri,
      sourceUrl: handle ? blueskyPostUrl(uri, handle) : null,
      authorName: str(p.author?.displayName) || handle || null,
      authorHandle: handle ? `@${handle}` : null,
      authorAvatar: https(p.author?.avatar),
      content: text.slice(0, TEXT_MAX),
      mentionedAt: date(p.record?.createdAt ?? p.indexedAt),
      reach: 0,
      engagements: num(p.likeCount) + num(p.repostCount) + num(p.replyCount) + num(p.quoteCount),
      metadata: { likes: num(p.likeCount), reposts: num(p.repostCount), replies: num(p.replyCount) },
    });
  }
  return out;
}

// ── Mastodon ───────────────────────────────────────────────────────────────

/** A keyword as a hashtag: letters and digits only ("Acme Phone" → "acmephone"). */
export function keywordToHashtag(keyword: string): string | null {
  const tag = keyword.normalize("NFKC").replace(/^#/, "").replace(/[^\p{L}\p{M}\p{N}_]/gu, "").toLowerCase();
  return tag.length >= 2 && tag.length <= 100 ? tag : null;
}

/** Hosts from LISTENING_MASTODON_INSTANCES (comma separated), validated. */
export function mastodonInstances(env: Record<string, string | undefined> = process.env): string[] {
  // `||`, not `??`: compose delivers an unset key as "" — that means "default", not "none".
  const raw = env.LISTENING_MASTODON_INSTANCES?.trim() || "mastodon.social";
  return [...new Set(raw.split(",").map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))].slice(0, 5);
}

export function mastodonTagUrl(instance: string, tag: string): string {
  return `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=40`;
}

export function mastodonMentions(body: unknown, instance: string, now: number): PublicMention[] {
  const statuses: any[] = Array.isArray(body) ? body : [];
  const out: PublicMention[] = [];
  for (const s of statuses) {
    if (!s || s.reblog) continue;
    if (s.visibility && s.visibility !== "public") continue;
    const at = date(s.created_at, new Date(0));
    if (now - at.getTime() > PUBLIC_LOOKBACK_MS) continue;
    const text = htmlToText(str(s.content));
    const uri = str(s.uri);
    if (!text || !uri) continue;
    const acct = str(s.account?.acct);
    out.push({
      source: "MASTODON",
      // The global URI, so the same post seen via two instances is one mention.
      platformPostId: uri,
      sourceUrl: https(s.url) ?? https(uri),
      authorName: str(s.account?.display_name) || acct || null,
      authorHandle: acct ? `@${acct}` : null,
      authorAvatar: https(s.account?.avatar),
      content: text.slice(0, TEXT_MAX),
      mentionedAt: at,
      // Followers are potential audience, not reach — kept apart so the Reach
      // total stays comparable across sources.
      reach: 0,
      engagements: num(s.favourites_count) + num(s.reblogs_count) + num(s.replies_count),
      metadata: { instance, language: str(s.language) || null, followers: num(s.account?.followers_count) },
    });
  }
  return out;
}

// ── Lemmy ──────────────────────────────────────────────────────────────────

export function lemmyInstance(env: Record<string, string | undefined> = process.env): string | null {
  const h = (env.LISTENING_LEMMY_INSTANCE?.trim() || "lemmy.world").toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null;
}

export function lemmySearchUrl(instance: string, keyword: string): string {
  const qs = new URLSearchParams({ q: keyword, type_: "All", sort: "New", limit: "20" });
  return `https://${instance}/api/v3/search?${qs.toString()}`;
}

/** Posts whose title/body name a keyword, comments that do (or whose post title does). */
export function lemmyMentions(body: unknown, keywords: string[], now: number): PublicMention[] {
  const out: PublicMention[] = [];
  const recent = (iso: string) => now - date(iso, new Date(0)).getTime() <= PUBLIC_LOOKBACK_MS;
  for (const p of Array.isArray((body as any)?.posts) ? (body as any).posts : []) {
    const post = p?.post ?? {};
    const title = str(post.name);
    const text = str(post.body);
    const apId = https(post.ap_id);
    if (!title || !apId || !recent(str(post.published))) continue;
    if (!matchesAnyKeyword(`${title}\n${text}`, keywords)) continue;
    out.push({
      source: "LEMMY",
      platformPostId: apId,
      sourceUrl: apId,
      authorName: str(p.community?.name) ? `!${str(p.community.name)}` : null,
      authorHandle: str(p.creator?.name) || null,
      authorAvatar: https(p.creator?.avatar),
      content: (text ? `${title}\n${text.slice(0, 300)}` : title).slice(0, TEXT_MAX),
      mentionedAt: date(post.published),
      reach: 0,
      engagements: num(p.counts?.score) + num(p.counts?.comments),
      metadata: { kind: "post", link: https(post.url), community: str(p.community?.actor_id) || null },
    });
  }
  for (const c of Array.isArray((body as any)?.comments) ? (body as any).comments : []) {
    const comment = c?.comment ?? {};
    const text = str(comment.content).trim();
    const apId = https(comment.ap_id);
    const postTitle = str(c.post?.name);
    if (!text || !apId || !recent(str(comment.published))) continue;
    if (!matchesAnyKeyword(text, keywords) && !matchesAnyKeyword(postTitle, keywords)) continue;
    out.push({
      source: "LEMMY",
      platformPostId: apId,
      sourceUrl: apId,
      authorName: str(c.community?.name) ? `!${str(c.community.name)}` : null,
      authorHandle: str(c.creator?.name) || null,
      authorAvatar: https(c.creator?.avatar),
      content: text.slice(0, TEXT_MAX),
      mentionedAt: date(comment.published),
      reach: 0,
      engagements: num(c.counts?.score),
      metadata: { kind: "comment", parentTitle: postTitle.slice(0, 300), parentUrl: https(c.post?.ap_id) },
    });
  }
  return out;
}

// ── Bing News RSS ──────────────────────────────────────────────────────────

/**
 * One keyword per request: Bing's news RSS returns an EMPTY feed for an OR
 * query (verified live 2026-10-05). `count=30` raises the default 2–10 items.
 */
export function bingNewsUrl(keyword: string, language: string): string {
  const qs = new URLSearchParams({ q: searchTerm(keyword), format: "rss", count: "30" });
  if (/^[a-z]{2}$/i.test(language)) qs.set("setlang", language.toLowerCase());
  return `https://www.bing.com/news/search?${qs.toString()}`;
}

/** Bing wraps every link in an apiclick redirect — use the article's own URL. */
export function bingArticleUrl(link: string): string | null {
  const decoded = link.replace(/&amp;/g, "&");
  try {
    const u = new URL(decoded);
    const inner = u.searchParams.get("url");
    if (inner && /^https?:\/\//i.test(inner)) return inner;
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function bingNewsMentions(xml: string): PublicMention[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  const out: PublicMention[] = [];
  for (const item of items) {
    const pick = (tag: string) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(item);
      return m ? htmlToText(m[1]!.replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
    };
    const title = pick("title");
    const url = bingArticleUrl(pick("link"));
    if (!title || !url) continue;
    const description = pick("description");
    out.push({
      source: "NEWS",
      platformPostId: url,
      sourceUrl: url,
      authorName: pick("News:Source") || "Bing News",
      authorHandle: null,
      authorAvatar: null,
      content: description ? `${title}\n${description.slice(0, 300)}` : title,
      mentionedAt: date(pick("pubDate")),
      reach: 0,
      engagements: 0,
      metadata: { feed: "bing" },
    });
  }
  return out;
}

// ── GDELT ──────────────────────────────────────────────────────────────────

/** GDELT rejects keywords shorter than 3 characters; OR needs parentheses. */
export function gdeltQuery(keywords: string[]): string | null {
  const terms = keywords.filter((k) => k.replace(/"/g, "").trim().length >= 3).map(searchTerm).filter(Boolean);
  if (terms.length === 0) return null;
  return terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
}

export function gdeltUrl(query: string): string {
  const qs = new URLSearchParams({ query, mode: "artlist", format: "json", maxrecords: "50", timespan: "1d", sort: "datedesc" });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${qs.toString()}`;
}

/** "20261005T171500Z" → Date */
export function gdeltDate(v: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)) : new Date();
}

export function gdeltMentions(body: unknown): PublicMention[] {
  const arts: any[] = Array.isArray((body as any)?.articles) ? (body as any).articles : [];
  const out: PublicMention[] = [];
  for (const a of arts) {
    const url = str(a?.url);
    const title = str(a?.title).trim();
    if (!/^https?:\/\//i.test(url) || !title) continue;
    out.push({
      source: "NEWS",
      platformPostId: url,
      sourceUrl: url,
      authorName: str(a.domain) || "GDELT",
      authorHandle: null,
      authorAvatar: null,
      content: title,
      mentionedAt: gdeltDate(str(a.seendate)),
      reach: 0,
      engagements: 0,
      metadata: { feed: "gdelt", domain: str(a.domain) || null, language: str(a.language) || null, country: str(a.sourcecountry) || null },
    });
  }
  return out;
}

/** Process-wide spacing for GDELT (one request per 5 s per IP; we keep 6). */
export const GDELT_MIN_GAP_MS = 6_000;
export function gdeltWaitMs(nextAllowedAt: number, now: number): number {
  return Math.max(0, nextAllowedAt - now);
}
