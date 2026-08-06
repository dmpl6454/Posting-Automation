/**
 * Derives, and decides whether to persist, a channel's "can this channel serve
 * Insights?" verdict — computed from the Graph calls the analytics-sync pipeline
 * ALREADY makes, so it costs no extra external API quota.
 *
 * Why this exists
 * ───────────────
 * A Meta App Review approval does NOT retro-add scopes to already-issued tokens:
 * scopes are granted only at consent time. So when the three insight permissions
 * were approved (2026-08-06), every channel connected beforehand kept a token
 * WITHOUT them — and Meta had additionally invalidated many sessions when the app
 * config changed. Audited live: of 966 active FB + 362 active IG channels, only
 * ONE FB and ONE IG channel were simultaneously token-valid, holding the new
 * scopes, and had published posts.
 *
 * Before this, none of that was visible in-product: an under-scoped or dead token
 * produced `0` / "—" in Insights, identical to a post with genuinely zero
 * engagement. Users had no way to learn that a single reconnect would fix it.
 *
 * Design notes
 * ────────────
 * - Health is derived from existing calls, NOT from a fresh `debug_token` sweep.
 *   A per-request sweep would be an N+1 over ~1300 channels, and a batch sweep
 *   exhausts Meta's app-level quota (verified: a 1328-channel audit tripped
 *   `#4 Application request limit reached` partway through).
 * - Coverage is therefore exactly the channels that HAVE published posts — which
 *   is precisely where Insights has anything to show.
 * - Writes only when the verdict CHANGES, so a healthy channel synced four times
 *   a day does not generate four redundant UPDATEs.
 *
 * Pure + testable (channel-insights-health.test.ts).
 */

export type InsightsHealthStatus = "ok" | "needs_reconnect";

export interface ChannelInsightsHealth {
  status: InsightsHealthStatus;
  /** Machine reason, mirrors AnalyticsDegradation.reason. Absent when ok. */
  reason?: string;
  /** Scopes the platform explicitly named as missing. */
  missingScopes?: string[];
  /** Short human diagnosis for the UI. Never contains a token. */
  detail?: string;
  /** ISO timestamp of the capture this verdict came from. */
  checkedAt: string;
}

export interface DegradationLike {
  reason: string;
  missingScopes?: string[];
  detail?: string;
}

/**
 * Maps a capture's degradation (or its absence) to a channel health verdict.
 * `token_invalid` and `missing_scope` are both fixed by the same user action —
 * reconnecting the channel — so they collapse to one actionable status while
 * keeping the distinct `reason` for the copy.
 */
export function deriveInsightsHealth(
  degraded: DegradationLike | undefined | null,
  now: Date
): ChannelInsightsHealth {
  const checkedAt = now.toISOString();
  if (!degraded) return { status: "ok", checkedAt };
  if (degraded.reason === "token_invalid" || degraded.reason === "missing_scope") {
    return {
      status: "needs_reconnect",
      reason: degraded.reason,
      ...(degraded.missingScopes?.length ? { missingScopes: degraded.missingScopes } : {}),
      ...(degraded.detail ? { detail: degraded.detail } : {}),
      checkedAt,
    };
  }
  // "no_data" and anything unrecognized are NOT user-actionable — don't nag.
  return { status: "ok", checkedAt };
}

/**
 * True when the new verdict differs from what is already stored in a meaningful
 * way. `checkedAt` alone changing is NOT meaningful — otherwise every sync would
 * write. Compares status, reason, and the missing-scope set.
 */
export function healthVerdictChanged(
  prev: unknown,
  next: ChannelInsightsHealth
): boolean {
  if (!prev || typeof prev !== "object") return true;
  const p = prev as Partial<ChannelInsightsHealth>;
  if (p.status !== next.status) return true;
  if ((p.reason ?? null) !== (next.reason ?? null)) return true;
  const a = [...(p.missingScopes ?? [])].sort().join(",");
  const b = [...(next.missingScopes ?? [])].sort().join(",");
  return a !== b;
}

/**
 * How long a `needs_reconnect` verdict stands before a clean capture may clear
 * it. Comfortably longer than the sync cadence (6-hourly cron + at-age
 * checkpoints), so a channel that has genuinely been reconnected recovers within
 * a day, while post-to-post noise cannot clear it.
 */
export const RECONNECT_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * ⚠️ A scope is a property of the TOKEN, not of the post that happened to sync
 * last — so a clean capture must not automatically clear a `needs_reconnect`
 * verdict.
 *
 * The bug this prevents (measured on prod 2026-08-06): Facebook's
 * `getPostAnalytics` takes two different paths. A FEED post hits the fields edge
 * and reports `missing_scope` when `pages_read_user_content` is absent; a VIDEO
 * post routes to `getVideoAnalytics`, which never touches that scope and so
 * reports NO degradation. Both write the channel's verdict, so on a channel with
 * both post types the two paths overwrite each other every sync cycle and the
 * stored verdict is decided by whichever post synced last.
 *
 * Prod evidence — the verdict tracked the LAST capture exactly:
 *   Bollywood             17 captures (6 degraded, 11 clean) · last = clean         → "ok"            ✗
 *   Contents of bollywood 25 captures (4 degraded, 21 clean) · last = clean         → "ok"            ✗
 *   Asthetic               2 captures (2 degraded,  0 clean) · last = missing_scope → needs_reconnect ✓
 *
 * The first two are the most-used FB channels in the deployment: users saw "—"
 * for comments with no banner, no pill, and no way to learn a reconnect fixes it.
 *
 * Rule: a clean capture only clears an actionable verdict once the verdict has
 * gone stale (TTL). A NEW actionable verdict always writes immediately — being
 * fast to warn and slow to reassure is the right asymmetry when the cost of a
 * false "ok" is silent data loss.
 */
export function shouldApplyHealthVerdict(
  prev: unknown,
  next: ChannelInsightsHealth,
  now: Date
): boolean {
  if (!healthVerdictChanged(prev, next)) return false;
  // Anything becoming actionable, or staying actionable with new detail, writes.
  if (next.status !== "ok") return true;

  const p =
    prev && typeof prev === "object" && !Array.isArray(prev)
      ? (prev as Partial<ChannelInsightsHealth>)
      : null;
  if (p?.status !== "needs_reconnect") return true;

  // Stored verdict is actionable and this capture is clean: only clear it once
  // the verdict is older than the TTL. An unparseable/absent checkedAt is
  // treated as stale so a malformed value can never pin a channel as broken.
  const checkedAt = typeof p.checkedAt === "string" ? Date.parse(p.checkedAt) : NaN;
  if (Number.isNaN(checkedAt)) return true;
  return now.getTime() - checkedAt >= RECONNECT_VERDICT_TTL_MS;
}

/**
 * Merges the verdict into a channel's existing `metadata` JSON without clobbering
 * unrelated keys (IG stores `igUserId`, Mastodon `instance`, Bluesky `service`,
 * LinkedIn `orgId` — losing any of those would break posting or analytics).
 * Returns null when nothing needs writing.
 */
export function mergeInsightsHealth(
  existingMetadata: unknown,
  next: ChannelInsightsHealth,
  /**
   * Injected for determinism under test. Gates the "clean capture clears an
   * actionable verdict" transition — see shouldApplyHealthVerdict for why a
   * single clean capture must NOT silently mark a broken channel healthy.
   */
  now: Date = new Date()
): Record<string, unknown> | null {
  const base =
    existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? (existingMetadata as Record<string, unknown>)
      : {};
  if (!shouldApplyHealthVerdict(base.insightsHealth, next, now)) return null;
  return { ...base, insightsHealth: next };
}
