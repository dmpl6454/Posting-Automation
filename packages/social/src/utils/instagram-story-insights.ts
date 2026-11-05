/**
 * Story-only insight extras (2026-11-05).
 *
 * Meta's Instagram Media Insights reference lists, for media_product_type STORY:
 * `navigation` (with the `story_navigation_action_type` breakdown: TAP_FORWARD,
 * TAP_BACK, TAP_EXIT, SWIPE_FORWARD — summing the four gives `navigation`),
 * plus `profile_visits`, `follows` and `link_clicks`.
 *
 * ⚠️ Both reads are SEPARATE calls from the main STORY metric set, on purpose:
 *   - /insights is all-or-nothing, so a name Meta rejects would zero the
 *     verified-live set (reach, views, shares, replies, navigation);
 *   - Meta warns that requesting a breakdown together with a metric that does
 *     not support it returns "An unknown error has occurred".
 * Each extra is best-effort: a failure costs only that extra, never the story's
 * core numbers, and never throws.
 *
 * A story under 5 viewers answers `#10 "Not enough viewers for the media to
 * show insights"` — a normal small account, not a broken channel.
 */

export interface StoryMetrics {
  /** Replies to the story (Meta returns 0 for stories created in Europe/Japan). */
  replies?: number;
  /** Total navigation actions (sum of the four breakdown values). */
  navigation?: number;
  totalInteractions?: number;
  tapsForward?: number;
  tapsBack?: number;
  exits?: number;
  /** "Next story" swipes. */
  swipeForward?: number;
  profileVisits?: number;
  follows?: number;
  linkClicks?: number;
  /** Meta withheld insights because fewer than 5 people viewed the story. */
  notEnoughViewers?: boolean;
}

/** Extra STORY metrics read in their own call (see the header). */
export const STORY_PROFILE_METRICS = "profile_visits,follows,link_clicks";

export const STORY_NAVIGATION_BREAKDOWN = "story_navigation_action_type";

export function isNotEnoughViewersError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  return Number(e?.code) === 10 && /not enough viewers/i.test(String(e?.message ?? ""));
}

const NAV_KEYS: Record<string, keyof StoryMetrics> = {
  tap_forward: "tapsForward",
  tap_back: "tapsBack",
  tap_exit: "exits",
  swipe_forward: "swipeForward",
};

function finite(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Reads the navigation breakdown out of an /insights response. Meta returns it
 * under `total_value.breakdowns[].results[]`, each result carrying
 * `dimension_values: ["tap_forward"]` (documented in upper case, returned in
 * lower case — both accepted). Unknown action types are ignored rather than
 * guessed. Returns {} when nothing usable is present.
 */
export function parseStoryNavigationBreakdown(body: unknown): Partial<StoryMetrics> {
  const out: Partial<StoryMetrics> = {};
  const rows: any[] = Array.isArray((body as any)?.data) ? (body as any).data : [];
  for (const row of rows) {
    if (row?.name !== "navigation") continue;
    const breakdowns: any[] = Array.isArray(row?.total_value?.breakdowns) ? row.total_value.breakdowns : [];
    for (const b of breakdowns) {
      const results: any[] = Array.isArray(b?.results) ? b.results : [];
      for (const r of results) {
        const key = String(Array.isArray(r?.dimension_values) ? r.dimension_values[0] ?? "" : "").toLowerCase();
        const field = NAV_KEYS[key];
        const value = finite(r?.value);
        if (field && value !== undefined) (out as Record<string, number>)[field] = value;
      }
    }
  }
  return out;
}

/** Reads profile_visits / follows / link_clicks from a plain /insights response. */
export function parseStoryProfileMetrics(body: unknown): Partial<StoryMetrics> {
  const out: Partial<StoryMetrics> = {};
  const rows: any[] = Array.isArray((body as any)?.data) ? (body as any).data : [];
  const map: Record<string, keyof StoryMetrics> = {
    profile_visits: "profileVisits",
    follows: "follows",
    link_clicks: "linkClicks",
  };
  for (const row of rows) {
    const field = map[String(row?.name ?? "")];
    if (!field) continue;
    const value = finite(row?.values?.[0]?.value ?? row?.total_value?.value ?? row?.value);
    if (value !== undefined) (out as Record<string, number>)[field] = value;
  }
  return out;
}

/** True when the object carries at least one measured number or the low-viewer flag. */
export function hasStoryMetrics(m: StoryMetrics | undefined): m is StoryMetrics {
  return !!m && Object.values(m).some((v) => v !== undefined);
}
