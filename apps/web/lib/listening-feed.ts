/**
 * Social Listening mention feed — sort / minimum reach / period (2026-10-06).
 *
 * "Reach" is what each source reports for a mention: views (YouTube, TikTok),
 * impressions (X), upvotes (Reddit posts). Every other source reports none and
 * stores 0 — so a minimum reach hides them, and a reach sort puts them last.
 * The choices live in the URL (?sort=reach&minReach=10000&period=7) so a
 * filtered feed can be shared and survives a reload.
 *
 * Sentiment (2026-10-06): ?sentiment=positive|neutral|negative|mixed narrows
 * the feed to one overall sentiment.
 *
 * Source (2026-10-06): ?source=youtube narrows it to one source.
 */

export type FeedSort = "recent" | "reach";
export type FeedSentiment = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED";

export interface FeedFilters {
  sort: FeedSort;
  minReach: number;
  /** Last N days; null = all stored mentions. */
  days: number | null;
  /** One overall sentiment; null = all. */
  sentiment: FeedSentiment | null;
  /** One source; null = all. */
  source: FeedSource | null;
}

export const DEFAULT_FEED_FILTERS: FeedFilters = { sort: "recent", minReach: 0, days: null, sentiment: null, source: null };

/**
 * Every MentionSource value (packages/db schema; a contract test keeps the two
 * in step). The API refuses anything else.
 */
export const MENTION_SOURCES = [
  "TWITTER",
  "INSTAGRAM",
  "FACEBOOK",
  "LINKEDIN",
  "REDDIT",
  "NEWS",
  "BLOG",
  "FORUM",
  "YOUTUBE",
  "TIKTOK",
  "OTHER",
  "HACKERNEWS",
  "BLUESKY",
  "MASTODON",
  "LEMMY",
] as const;
export type FeedSource = (typeof MENTION_SOURCES)[number];

/** Friendly names for sources (the Sources card and the source filter). */
export const SOURCE_LABEL: Record<string, string> = {
  TWITTER: "X / Twitter",
  // Google News + Bing News + GDELT since 2026-10-05.
  NEWS: "News",
  REDDIT: "Reddit",
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TIKTOK: "TikTok",
  YOUTUBE: "YouTube",
  BLOG: "Blog",
  FORUM: "Forum",
  OTHER: "Other",
  HACKERNEWS: "Hacker News",
  BLUESKY: "Bluesky",
  MASTODON: "Mastodon",
  LEMMY: "Lemmy",
};

/**
 * The source filter's options: the sources listening actually collects
 * (BLOG / FORUM / OTHER exist in the schema but nothing writes them — still
 * accepted from a URL), in the order of the "Platforms" picker.
 */
export const SOURCE_FILTER_OPTIONS: ReadonlyArray<{ value: FeedSource | null; label: string }> = [
  { value: null, label: "All sources" },
  ...(["TWITTER", "INSTAGRAM", "FACEBOOK", "LINKEDIN", "REDDIT", "YOUTUBE", "TIKTOK", "NEWS", "HACKERNEWS", "BLUESKY", "MASTODON", "LEMMY"] as const).map(
    (v) => ({ value: v, label: SOURCE_LABEL[v]! })
  ),
];

/** "youtube" → "YOUTUBE"; anything that isn't a MentionSource → null. */
export function parseSource(value: string | null | undefined): FeedSource | null {
  const v = String(value ?? "").toUpperCase();
  return (MENTION_SOURCES as readonly string[]).includes(v) ? (v as FeedSource) : null;
}

/** The sentiment chips, in the order the Sentiment Distribution bar shows them (Mixed last: it is the rarest). */
export const SENTIMENT_FILTER_OPTIONS: ReadonlyArray<{ value: FeedSentiment | null; label: string }> = [
  { value: null, label: "All" },
  { value: "POSITIVE", label: "Positive" },
  { value: "NEUTRAL", label: "Neutral" },
  { value: "NEGATIVE", label: "Negative" },
  { value: "MIXED", label: "Mixed" },
];

/** "positive" → "POSITIVE"; anything else → null. */
export function parseSentiment(value: string | null | undefined): FeedSentiment | null {
  const v = String(value ?? "").toUpperCase();
  return v === "POSITIVE" || v === "NEUTRAL" || v === "NEGATIVE" || v === "MIXED" ? v : null;
}

export const MIN_REACH_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "Any reach" },
  { value: 1_000, label: "1K+ reach" },
  { value: 10_000, label: "10K+ reach" },
  { value: 100_000, label: "100K+ reach" },
  { value: 1_000_000, label: "1M+ reach" },
];

export const PERIOD_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: null, label: "All time" },
  { value: 1, label: "Last 24 hours" },
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
];

/** Read the feed filters from the URL; anything not on offer falls back to the default. */
export function parseFeedFilters(params: { get(name: string): string | null }): FeedFilters {
  const sort: FeedSort = params.get("sort") === "reach" ? "reach" : "recent";
  const min = Number(params.get("minReach"));
  const minReach = MIN_REACH_OPTIONS.some((o) => o.value === min) ? min : 0;
  const period = Number(params.get("period"));
  const days = PERIOD_OPTIONS.some((o) => o.value !== null && o.value === period) ? period : null;
  return { sort, minReach, days, sentiment: parseSentiment(params.get("sentiment")), source: parseSource(params.get("source")) };
}

/** Write the filters into URL params, dropping the defaults so a plain feed keeps a clean URL. */
export function applyFeedFilters(params: URLSearchParams, f: FeedFilters): URLSearchParams {
  const out = new URLSearchParams(params.toString());
  if (f.sort === "reach") out.set("sort", "reach");
  else out.delete("sort");
  if (f.minReach > 0) out.set("minReach", String(f.minReach));
  else out.delete("minReach");
  if (f.days !== null) out.set("period", String(f.days));
  else out.delete("period");
  if (f.sentiment) out.set("sentiment", f.sentiment.toLowerCase());
  else out.delete("sentiment");
  if (f.source) out.set("source", f.source.toLowerCase());
  else out.delete("source");
  return out;
}

export function isFiltered(f: FeedFilters): boolean {
  return f.sort !== "recent" || f.minReach > 0 || f.days !== null || f.sentiment !== null || f.source !== null;
}

/** "482K", "1.2M" — the page's compact count. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * The reach a mention card shows, named for what the source actually counts —
 * or null when the source reported none (0 is "not reported", not "nobody").
 */
export function reachLabel(source: string, reach: number | null | undefined): string | null {
  if (!reach || reach <= 0) return null;
  const n = compactCount(reach);
  if (source === "YOUTUBE" || source === "TIKTOK") return `${n} views`;
  if (source === "TWITTER") return `${n} impressions`;
  if (source === "REDDIT") return `${n} ${reach === 1 ? "upvote" : "upvotes"}`;
  return `${n} reach`;
}
