/**
 * The product floor for external-post ingestion: posts made directly on a
 * connected platform are collected from this instant onward, never earlier.
 *
 * ⚠️ ONE definition, because FOUR call sites must agree or the UI lies:
 *   - `scheduleExternalPostSync` (the periodic sweep),
 *   - `external-post-sync.worker`'s own HARD_FLOOR,
 *   - `analytics.triggerSync` ("Sync Now"),
 *   - the Insights partial-coverage notice, which tells the user where coverage
 *     begins.
 * If Sync Now used a different floor from the cron, a manual sync could pull in
 * posts the scheduled sweep never would, and the "included from …" copy would
 * stop being true.
 *
 * ── Why this is now configurable ──────────────────────────────────────────────
 * LIVE-PROBED 2026-08-18 against production Graph: BOTH listing edges return
 * history far older than the original hardcoded 2026-08-01 date.
 *   - IG `/{ig-user}/media`      → 6,000 posts back to 2025-11-21 (hit OUR page
 *                                   cap, not the end of history)
 *   - FB `/{page}/published_posts` → 4,000+ posts, still not exhausted at 40 pages
 * So the floor was never an API limit — it is a budget decision, and it belongs in
 * an env var that can be walked back deliberately.
 *
 * ⚠️ READ BEFORE LOWERING IT. Listing is the CHEAP half (~1 call per 100 posts).
 * METRICS are 2 Graph calls PER POST, so widening the window multiplies the
 * expensive half without bound: a single 4,000-post Page costs ~8,000 calls to
 * measure. Lower this in STEPS (a month at a time), watch the external-sync logs
 * and the box, and remember `EXTERNAL_METRICS_PER_RUN` is per ACCOUNT per run.
 *
 * ⚠️ Deep pagination has its own ceiling: measured, Meta starts returning
 * `code: 1 "Please reduce the amount of data you're asking for"` at roughly
 * 52-58 pages of 100. Reaching genuinely old history needs time-WINDOWED queries
 * (month by month), not one deep walk.
 *
 * ⚠️ `docker-compose.prod.yml` uses an explicit `environment:` allowlist — a key
 * present only in `.env.prod` arrives as an EMPTY STRING. EXTERNAL_POST_FLOOR is
 * plumbed there; keep it plumbed.
 */

/** The floor used when EXTERNAL_POST_FLOOR is unset or unparseable. */
export const DEFAULT_EXTERNAL_POST_FLOOR_ISO = "2026-08-01T00:00:00.000Z";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * Parse the configured floor.
 *
 * Fails CLOSED to the default on anything unparseable — including the empty
 * string, which is exactly what an unplumbed compose key produces. A silently
 * invalid floor must never widen the window.
 */
export function resolveExternalPostFloor(raw?: string | null): Date {
  const fallback = new Date(DEFAULT_EXTERNAL_POST_FLOOR_ISO);
  if (!raw || !raw.trim()) return fallback;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return fallback;
  // A floor in the future would collect nothing at all; treat it as a mistake.
  if (parsed.getTime() > Date.now()) return fallback;
  return parsed;
}

/** Human-readable form, DERIVED — never hardcoded, or the UI copy drifts. */
export function formatExternalPostFloor(floor: Date): string {
  return `${floor.getUTCDate()} ${MONTHS[floor.getUTCMonth()]} ${floor.getUTCFullYear()}`;
}

/**
 * Read at call time (not module load) so a container restart is enough to change
 * it and tests can vary it without module-cache games.
 */
export function externalPostFloor(): Date {
  return resolveExternalPostFloor(process.env.EXTERNAL_POST_FLOOR);
}

/** Human-readable form of the ACTIVE floor. */
export function externalPostFloorLabel(): string {
  return formatExternalPostFloor(externalPostFloor());
}
