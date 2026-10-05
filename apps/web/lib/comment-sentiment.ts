/**
 * Comment sentiment (2026-10-05) — shared display rules for the Social
 * Listening "Comments on your posts" view and the tag on each comment in the
 * comment thread. Colours match the listening page's sentiment bar (literal
 * hex: this project's Tailwind config flattens the named green/red/amber
 * scales, see listening/page.tsx).
 */

export type SentimentKey = "positive" | "neutral" | "mixed" | "negative";

export const SENTIMENT_META: Record<SentimentKey, { label: string; color: string; tint: string }> = {
  positive: { label: "Positive", color: "#5cb85c", tint: "rgba(92,184,92,0.15)" },
  neutral: { label: "Neutral", color: "#8a8578", tint: "rgba(138,133,120,0.15)" },
  mixed: { label: "Mixed", color: "#e0b84a", tint: "rgba(224,184,74,0.15)" },
  negative: { label: "Negative", color: "#d9695f", tint: "rgba(217,105,95,0.15)" },
};

export const SENTIMENT_ORDER: SentimentKey[] = ["positive", "neutral", "mixed", "negative"];

/** "NEGATIVE" → "negative"; anything else (or null = not scored yet) → null. */
export function sentimentKey(value: string | null | undefined): SentimentKey | null {
  const k = String(value ?? "").toLowerCase();
  return k === "positive" || k === "neutral" || k === "mixed" || k === "negative" ? k : null;
}

export interface SentimentTotals {
  positive: number;
  neutral: number;
  mixed: number;
  negative: number;
  pending: number;
}

/**
 * Whole-number percentages of the SCORED comments (pending is not part of the
 * split — it isn't a verdict). They add up to exactly 100 when anything was
 * scored (largest-remainder rounding), and are all 0 when nothing was.
 */
export function sentimentPercents(t: SentimentTotals): Record<SentimentKey, number> {
  const scored = t.positive + t.neutral + t.mixed + t.negative;
  const out: Record<SentimentKey, number> = { positive: 0, neutral: 0, mixed: 0, negative: 0 };
  if (scored === 0) return out;
  const raw = SENTIMENT_ORDER.map((k) => ({ k, exact: (t[k] / scored) * 100 }));
  let used = 0;
  for (const r of raw) {
    out[r.k] = Math.floor(r.exact);
    used += out[r.k];
  }
  const byRemainder = [...raw].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)));
  for (let i = 0; used < 100 && i < byRemainder.length; i++, used++) out[byRemainder[i]!.k]++;
  return out;
}

/** -1..1 average → "+0.42" / "-0.10" / "—". */
export function formatAvgScore(avg: number | null | undefined): string {
  if (avg === null || avg === undefined || !Number.isFinite(avg)) return "—";
  const v = Math.round(avg * 100) / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

/** Deep link to a post's comment thread in the Comments inbox. */
export function commentThreadHref(channelId: string, postTargetId: string): string {
  return `/dashboard/comments?channel=${encodeURIComponent(channelId)}&post=${encodeURIComponent(postTargetId)}`;
}

export interface DailySentiment extends SentimentTotals {
  day: string;
}

/**
 * Every day of the range, oldest first, with zeros for days nobody commented —
 * so bars sit at their real position in time. Days are UTC calendar days
 * ("YYYY-MM-DD"), matching the server's date_trunc buckets.
 */
export function fillDailySeries(daily: readonly DailySentiment[], days: number, now: number = Date.now()): DailySentiment[] {
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: DailySentiment[] = [];
  const end = new Date(now);
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(endUtc - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, positive: 0, neutral: 0, mixed: 0, negative: 0, pending: 0 });
  }
  return out;
}
