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
}

export const DEFAULT_FEED_FILTERS: FeedFilters = { sort: "recent", minReach: 0, days: null, sentiment: null };

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
  return { sort, minReach, days, sentiment: parseSentiment(params.get("sentiment")) };
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
  return out;
}

export function isFiltered(f: FeedFilters): boolean {
  return f.sort !== "recent" || f.minReach > 0 || f.days !== null || f.sentiment !== null;
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
