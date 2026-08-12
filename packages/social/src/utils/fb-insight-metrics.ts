/**
 * Facebook post-level insight metric names, row selection, and rung classification.
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * Meta RENAMED per-post impressions/reach; it did not delete them. Their own
 * deprecated-metrics page states the successors:
 *
 *   post_impressions_unique*  (Alternative: post_total_media_view_unique)
 *   page_impressions_unique*  (Alternative: page_total_media_view_unique)
 *
 * Live-probed on production 2026-08-11 (real Page tokens, one metric per call,
 * 5 mediaTypes + 25 reels). See docs/FB-MEDIA-VIEW-METRICS-PLAN-2026-08-11.md.
 *
 * Everything here is PURE so the traps below are locked by fast unit tests —
 * importing the provider drags in the scraper and the whole Graph client.
 */

/**
 * ⚠️ The naming is ASYMMETRIC and cannot be inferred. Measured DEAD (#100):
 * `post_total_media_view` (without `_unique`), `post_media_view_unique`,
 * `post_media_views`, `post_total_media_views`, `post_organic_media_view`,
 * `post_paid_media_view`, `post_media_view_organic`, `post_media_view_paid`,
 * `post_media_view_time`, `post_total_media_view_time`, `post_views`,
 * `post_views_unique`, and every `post_impressions*` / `post_reach` /
 * `post_engaged_users` / `post_clicks_unique` / `post_negative_feedback*`.
 *
 * Do NOT "tidy" these two strings. Verify any new name against a live token
 * before adding it — one invalid name 400s the WHOLE call.
 */
export const FB_METRIC_IMPRESSIONS = "post_media_view";
export const FB_METRIC_REACH = "post_total_media_view_unique";

/**
 * Rung 2 — byte-identical to the call shipped before this change. A descent to
 * this rung must reproduce today's behaviour exactly, so a Meta rename can only
 * cost the two new metrics, never clicks/reactions.
 */
export const FB_INSIGHT_METRICS_BASE = [
  "post_clicks",
  "post_video_views",
  "post_reactions_by_type_total",
] as const;

/**
 * Rung 1 — the base list with the two recovered names APPENDED.
 *
 * ⚠️ Order matters for the test locks, not for Graph. Appending keeps
 * `facebook-video.test.ts`'s `toContain(".../insights?metric=post_clicks,post_video_views,post_reactions_by_type_total")`
 * passing as a PREFIX, and keeps the strict mock's `/\/insights\?metric=post_clicks/`
 * route matching, so the frozen-network-shape lock stays green unedited.
 */
export const FB_INSIGHT_METRICS_PREFERRED = [
  ...FB_INSIGHT_METRICS_BASE,
  FB_METRIC_IMPRESSIONS,
  FB_METRIC_REACH,
] as const;

export const fbMetricParam = (metrics: readonly string[]): string => metrics.join(",");

/** A single row from `/{post}/insights`. */
export type FbInsightRow = {
  name?: string;
  period?: string;
  values?: Array<{ value?: unknown; end_time?: string }>;
};

/**
 * 🔴🔴 THE FAKE-ZERO TRAP — the single most important function here.
 *
 * Meta returns BOTH a `lifetime` AND a `day` row for some metrics. Measured on
 * production for `post_total_media_view_unique` (and `post_video_views`):
 *
 *   name=post_total_media_view_unique period=lifetime v0=106   <-- the real value
 *   name=post_total_media_view_unique period=day      v0=0     <-- stale bucket, LAST
 *
 * The `day` row carries 0 with a stale `end_time` and arrives AFTER the lifetime
 * row, so the previous last-wins parse (`metrics[name] = value` in a plain loop)
 * would have stored **reach = 0 while declaring it available** — a fabricated
 * zero, exactly the class of lie this subsystem exists to prevent.
 *
 * `post_media_view` happens to be lifetime-only TODAY. Do not rely on that:
 * Meta added a `day` variant to its sibling without notice.
 *
 * Always prefer `period === "lifetime"`; fall back to the first row only when no
 * lifetime row exists (so a future lifetime-less metric still yields a value).
 */
export function selectLifetimeRow(
  rows: readonly FbInsightRow[],
  name: string
): FbInsightRow | undefined {
  const matching = rows.filter((r) => r?.name === name);
  if (matching.length === 0) return undefined;
  return matching.find((r) => r.period === "lifetime") ?? matching[0];
}

/**
 * Reads one metric's numeric value, summing the object-valued metrics
 * (`post_reactions_by_type_total` is `{like:N,love:N,…}`).
 *
 * Returns `null` when the metric is ABSENT — distinct from a present 0. That
 * distinction is what lets `metricsAvailable` be derived per metric name instead
 * of one boolean for the whole call.
 */
export function readMetricValue(
  rows: readonly FbInsightRow[],
  name: string
): number | null {
  const row = selectLifetimeRow(rows, name);
  if (!row) return null;
  const v = row.values?.[0]?.value;
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>).reduce(
      (s: number, n) => s + (Number(n) || 0),
      0
    );
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Which metric names the response actually carried (per-name availability). */
export function presentMetricNames(rows: readonly FbInsightRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) if (r?.name) s.add(String(r.name));
  return s;
}

/**
 * 🔴 AVAILABILITY MUST BE DERIVED FROM THE SAME ROW THE VALUE CAME FROM.
 *
 * `presentMetricNames` answers "did any row carry this name?" — it iterates
 * EVERY row, so a lone stale `period=day` row marks the metric present. But the
 * VALUE comes from `selectLifetimeRow`, which prefers `lifetime` and falls back
 * to `matching[0]`. When Meta returns ONLY a day row, those two disagree: the
 * value resolves to the day bucket's 0 while availability resolves to `true`.
 * The result is a fabricated zero declared available — precisely the lie this
 * subsystem exists to prevent.
 *
 * MEASURED ON PROD 2026-08-12: 113 Facebook ExternalPost rows synced that day
 * carried `impressions > 0`, `reach = 0`, `metricsSource = "api"` AND
 * `metricsAvailable.reach = "true"`. One of them (596165523816494_1604121547940633)
 * stored reach 0 while Graph reported `post_total_media_view_unique` lifetime
 * 16,438. `post_media_view` is lifetime-only, which is exactly why impressions
 * survived on the same row — the asymmetry that fingerprints this bug.
 *
 * A `day` row is a real measurement OF ONE DAY; it is never the lifetime total,
 * so it must not be published as one. A row with NO period is still trusted, so
 * the deliberate `?? matching[0]` fallback for a hypothetical lifetime-less
 * metric keeps working.
 */
export function hasTrustedValue(rows: readonly FbInsightRow[], name: string): boolean {
  const row = selectLifetimeRow(rows, name);
  return !!row && row.period !== "day";
}

export type FbRungVerdict =
  /** Rows came back — use them. */
  | { kind: "ok" }
  /** HTTP 200 with zero rows — the MISSING-SCOPE sentinel. Never descend. */
  | { kind: "empty" }
  /** A metric NAME was rejected. Descending to a shorter list can help. */
  | { kind: "bad_metric" }
  /** Token/permission/rate/object error. A shorter list cannot fix it. */
  | { kind: "hard_error" };

/**
 * Matches Meta's invalid-metric-NAME messages.
 *
 * ⚠️ `#100` is NOT exclusively "bad metric name" — this codebase already sees it
 * for object-not-found (a deleted video 400s) and for nonexisting fields. So the
 * classifier requires the code AND a name-error message AND `subcode !== 33`
 * (33 = "object does not exist / no permission"). Treating every #100 as a bad
 * name would make every deleted post pay a pointless extra request forever.
 */
const FB_METRIC_NAME_ERROR = /valid insights metric|does not support the .* metric|nonexisting field/i;

export function classifyFbRung(
  ok: boolean,
  error: { code?: unknown; error_subcode?: unknown; message?: unknown } | undefined,
  rowCount: number
): FbRungVerdict {
  if (ok) return rowCount > 0 ? { kind: "ok" } : { kind: "empty" };
  const code = Number(error?.code);
  const subcode = Number(error?.error_subcode);
  const isNameError =
    code === 100 &&
    subcode !== 33 &&
    FB_METRIC_NAME_ERROR.test(String(error?.message ?? ""));
  return isNameError ? { kind: "bad_metric" } : { kind: "hard_error" };
}

/**
 * Kill switch. Default OFF — the safe side.
 *
 * ⚠️ `docker-compose.prod.yml` uses an explicit `environment:` allowlist, NOT
 * `env_file:`. A key written only into `.env.prod` arrives as an EMPTY STRING,
 * so a fail-OPEN check (`!== "false"`) would read "unset" as ENABLED. That trap
 * shipped the FB scraper live for ~1h on 2026-08-08 (PR #166). This check is
 * therefore fail-CLOSED: only the literal string "true" enables it, and the
 * variable must ALSO be named in the worker's compose `environment:` map.
 */
export function isFbMediaViewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FB_MEDIA_VIEW_METRICS_ENABLED === "true";
}
