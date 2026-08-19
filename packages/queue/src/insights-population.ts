/**
 * WHICH POPULATION Insights measures and reports on.
 *
 * Owner decision 2026-08-19: **Insights covers posts published THROUGH
 * PostAutomation, end to end — nothing else.** Posts made directly on a
 * connected Facebook Page or Instagram account are neither fetched from Meta nor
 * displayed. The `ExternalPost` ingestion pipeline (added 2026-08-07) is dormant
 * by default; the rows it already collected stay in the table but are excluded
 * from every read path.
 *
 * ── Why this is ONE definition, plumbed to BOTH containers ────────────────────
 * The worker decides what is INGESTED; the web container decides what is
 * DISPLAYED. If they disagree, the product either burns Graph quota collecting
 * rows nobody can see (worker on, web off) or renders a population it has
 * stopped refreshing (worker off, web on) — numbers frozen at whatever the last
 * sweep happened to catch. `EXTERNAL_POST_FLOOR` lives in this package for
 * exactly the same reason. Keep both plumbed in `docker-compose.prod.yml`.
 *
 * ── Why the check is fail-CLOSED (`=== "true"`) ───────────────────────────────
 * `docker-compose.prod.yml` uses an explicit `environment:` allowlist, so a key
 * present only in `.env.prod` and named by no compose line arrives as an EMPTY
 * STRING. A fail-open check (`!== "false"`) reads that as ENABLED — the PR #166
 * incident. Re-enabling an ingestion pipeline that costs 2 Graph calls per post
 * must be a deliberate, unambiguous act, so anything other than the exact string
 * `"true"` keeps the cheap, app-published-only behavior.
 *
 * ── What turning this ON restores ────────────────────────────────────────────
 * Setting `INSIGHTS_INCLUDE_EXTERNAL_POSTS=true` on BOTH web and worker restores
 * the pre-2026-08-19 behavior verbatim: the 2-hourly sharded listing sweep, the
 * per-post metrics passes, the `ext_rows` arm of the Channel Performance
 * aggregate, the "Direct" rows in Reports, and the partial-coverage notice.
 * Before doing so, re-read the cost notes on `EXTERNAL_POST_FLOOR` — listing is
 * cheap (~1 call per 100 posts) but METRICS are 2 Graph calls PER POST.
 *
 * ⚠️ `EXTERNAL_SYNC_ENABLED=false` remains an independent, ingestion-ONLY brake.
 * This switch is the master: it governs reads AND ingestion together, which is
 * what keeps the two containers honest with each other.
 */

/**
 * Parse the configured population setting.
 *
 * Fails CLOSED to app-published-only on anything that is not exactly `"true"`,
 * including the empty string an unplumbed compose key produces.
 */
export function resolveIncludeExternalPosts(raw?: string | null): boolean {
  return raw?.trim() === "true";
}

/**
 * Read at call time (not module load) so a container restart is enough to change
 * it and tests can vary it without module-cache games.
 */
export function insightsIncludeExternalPosts(): boolean {
  return resolveIncludeExternalPosts(process.env.INSIGHTS_INCLUDE_EXTERNAL_POSTS);
}
