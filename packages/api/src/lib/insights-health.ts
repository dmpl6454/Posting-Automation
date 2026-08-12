/**
 * Read side of the channel Insights-health verdict that the analytics-sync worker
 * writes into `Channel.metadata.insightsHealth`
 * (apps/worker/src/lib/channel-insights-health.ts).
 *
 * `Channel.metadata` is an untyped Json column, so everything here is defensive:
 * a malformed or hand-edited value must degrade to "no verdict", never crash a
 * query or leak arbitrary strings into the UI. `detail` is length-capped and
 * `missingScopes` is filtered to plausible Meta scope names for the same reason
 * the provider-side extractor is — platform text is untrusted input.
 *
 * Pure + testable (insights-health.test.ts).
 */

export interface InsightsHealth {
  status: "ok" | "needs_reconnect";
  reason?: string;
  missingScopes?: string[];
  detail?: string;
  checkedAt?: string;
}

const MAX_DETAIL = 200;
const SCOPE_RE = /^[a-z][a-z_]{3,60}$/;

/**
 * Extracts a validated health verdict, or null when the channel has none
 * (never synced, legacy row, or unparseable metadata).
 */
export function readInsightsHealth(metadata: unknown): InsightsHealth | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).insightsHealth;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;

  // Only the two known statuses are honored; anything else is treated as absent
  // so a future/garbled value can never render as a scary banner.
  const status = h.status === "needs_reconnect" ? "needs_reconnect" : h.status === "ok" ? "ok" : null;
  if (!status) return null;

  const missingScopes = Array.isArray(h.missingScopes)
    ? h.missingScopes.filter((s): s is string => typeof s === "string" && SCOPE_RE.test(s)).slice(0, 12)
    : undefined;

  return {
    status,
    ...(typeof h.reason === "string" && h.reason.length <= 40 ? { reason: h.reason } : {}),
    ...(missingScopes?.length ? { missingScopes } : {}),
    ...(typeof h.detail === "string" ? { detail: h.detail.slice(0, MAX_DETAIL) } : {}),
    ...(typeof h.checkedAt === "string" ? { checkedAt: h.checkedAt } : {}),
  };
}

/** True when this channel needs the owner to reconnect it to restore Insights. */
export function needsReconnect(metadata: unknown): boolean {
  return readInsightsHealth(metadata)?.status === "needs_reconnect";
}

/**
 * Warn this many days before Meta's data-access window closes. 14 days gives the
 * owner a comfortable runway to reconnect without the banner nagging for months.
 */
export const DATA_ACCESS_WARN_DAYS = 14;

export interface ChannelInsightsStatus {
  /** "expiring_soon" is a WARNING; both other states are actionable now. */
  status: "ok" | "expiring_soon" | "needs_reconnect";
  reason?: string;
  missingScopes?: string[];
  detail?: string;
  /** ISO date Meta stops honoring data reads for this token. */
  dataAccessExpiresAt?: string;
  /** Negative ⇒ already lapsed. */
  daysUntilDataAccessExpiry?: number;
}

/**
 * The effective "can this channel report Insights?" verdict, combining:
 *   1. the capability verdict the sync worker derived from real Graph errors, and
 *   2. Meta's 90-day DATA-ACCESS window recorded at connect time.
 *
 * ⚠️ (2) is the one that silently kills Meta insights every ~3 months and had no
 * monitoring at all. Meta reports `expires_at = never` for both FB Page and IG
 * user tokens, so `Channel.tokenExpiresAt` is legitimately NULL — which means
 * `scheduleTokenRefreshes` (filtering `tokenExpiresAt <= soon`, unsatisfiable by
 * NULL) has never selected a single Meta channel. Separately, and verified
 * empirically, a server-side `fb_exchange_token` refresh does NOT extend data
 * access (the new token carries an identical `data_access_expires_at`), so no
 * amount of background refreshing can help. Warning the owner in time is the
 * only real remedy, which is what this powers.
 *
 * Pure — `now` is injected so it is deterministic under test.
 */
export function evaluateChannelInsightsStatus(
  metadata: unknown,
  now: Date = new Date()
): ChannelInsightsStatus {
  const stored = readInsightsHealth(metadata);

  // Data-access cliff, read defensively out of untyped JSON.
  let dataAccessExpiresAt: string | undefined;
  let daysUntil: number | undefined;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const raw = (metadata as Record<string, unknown>).dataAccessExpiresAt;
    if (typeof raw === "string") {
      const when = new Date(raw);
      if (!Number.isNaN(when.getTime())) {
        dataAccessExpiresAt = when.toISOString();
        daysUntil = Math.floor((when.getTime() - now.getTime()) / 86_400_000);
      }
    }
  }

  const cliff =
    dataAccessExpiresAt != null && daysUntil != null
      ? { dataAccessExpiresAt, daysUntilDataAccessExpiry: daysUntil }
      : {};

  // A live capability failure outranks a future deadline — it is broken NOW.
  if (stored?.status === "needs_reconnect") {
    return {
      status: "needs_reconnect",
      ...(stored.reason ? { reason: stored.reason } : {}),
      ...(stored.missingScopes?.length ? { missingScopes: stored.missingScopes } : {}),
      ...(stored.detail ? { detail: stored.detail } : {}),
      ...cliff,
    };
  }

  if (daysUntil != null) {
    if (daysUntil <= 0) {
      return {
        status: "needs_reconnect",
        reason: "data_access_expired",
        detail:
          "This platform's 90-day data-access window has closed, so it will no longer return metrics. Reconnect to reopen it.",
        ...cliff,
      };
    }
    if (daysUntil <= DATA_ACCESS_WARN_DAYS) {
      return {
        status: "expiring_soon",
        reason: "data_access_expiring",
        detail: `Metrics stop in ${daysUntil} day${daysUntil === 1 ? "" : "s"} unless this channel is reconnected — the platform closes its 90-day data-access window then. Posting is unaffected.`,
        ...cliff,
      };
    }
  }

  return { status: "ok", ...cliff };
}

/**
 * Org rollup for the Insights banner, now covering BOTH failure modes: channels
 * broken right now, and channels about to lapse.
 */
export function summarizeChannelStatuses(
  channels: Array<{ id: string; name: string; platform: string; metadata: unknown }>,
  now: Date = new Date()
): {
  needsReconnectCount: number;
  expiringSoonCount: number;
  missingScopes: string[];
  /** Soonest data-access deadline among the expiring channels, ISO. */
  soonestExpiry?: string;
  channels: Array<{
    id: string;
    name: string;
    platform: string;
    status: "expiring_soon" | "needs_reconnect";
    /**
     * Machine reason, forwarded so the banner can stop asserting a cause it does
     * not know. "your token was rejected" is wrong for a channel simply left out
     * of the last consent, and that wrong sentence is what kept the owner
     * reconnecting a channel the reconnect could never reach.
     */
    reason?: string;
    missingScopes: string[];
    daysUntilDataAccessExpiry?: number;
  }>;
} {
  const affected: Array<{
    id: string;
    name: string;
    platform: string;
    status: "expiring_soon" | "needs_reconnect";
    reason?: string;
    missingScopes: string[];
    daysUntilDataAccessExpiry?: number;
  }> = [];
  const scopes = new Set<string>();
  let needsReconnectCount = 0;
  let expiringSoonCount = 0;
  let soonest: number | undefined;

  for (const c of channels) {
    const s = evaluateChannelInsightsStatus(c.metadata, now);
    if (s.status === "ok") continue;
    if (s.status === "needs_reconnect") needsReconnectCount++;
    else expiringSoonCount++;
    for (const sc of s.missingScopes ?? []) scopes.add(sc);
    if (s.daysUntilDataAccessExpiry != null && (soonest == null || s.daysUntilDataAccessExpiry < soonest)) {
      soonest = s.daysUntilDataAccessExpiry;
      // keep the ISO alongside for the copy
    }
    affected.push({
      id: c.id,
      name: c.name,
      platform: c.platform,
      status: s.status,
      ...(s.reason ? { reason: s.reason } : {}),
      missingScopes: s.missingScopes ?? [],
      ...(s.daysUntilDataAccessExpiry != null
        ? { daysUntilDataAccessExpiry: s.daysUntilDataAccessExpiry }
        : {}),
    });
  }

  // Broken-now first, then soonest deadline — the order the owner should act in.
  affected.sort((a, b) => {
    if (a.status !== b.status) return a.status === "needs_reconnect" ? -1 : 1;
    return (a.daysUntilDataAccessExpiry ?? 1e9) - (b.daysUntilDataAccessExpiry ?? 1e9);
  });

  const soonestChannel = affected.find((a) => a.daysUntilDataAccessExpiry != null);
  return {
    needsReconnectCount,
    expiringSoonCount,
    missingScopes: [...scopes].sort(),
    ...(soonestChannel
      ? {
          soonestExpiry: new Date(
            Date.now() + soonestChannel.daysUntilDataAccessExpiry! * 86_400_000
          ).toISOString(),
        }
      : {}),
    channels: affected,
  };
}

/**
 * Org-level rollup for the Insights banner. Counts only channels that actually
 * carry a `needs_reconnect` verdict — never guesses from zero metrics, so a
 * channel with genuinely no engagement is never reported as broken.
 */
export function summarizeInsightsHealth(
  channels: Array<{ id: string; name: string; platform: string; metadata: unknown }>
): {
  needsReconnectCount: number;
  channels: Array<{ id: string; name: string; platform: string; missingScopes: string[] }>;
  missingScopes: string[];
} {
  const affected: Array<{ id: string; name: string; platform: string; missingScopes: string[] }> = [];
  const scopes = new Set<string>();
  for (const c of channels) {
    const h = readInsightsHealth(c.metadata);
    if (h?.status !== "needs_reconnect") continue;
    for (const s of h.missingScopes ?? []) scopes.add(s);
    affected.push({
      id: c.id,
      name: c.name,
      platform: c.platform,
      missingScopes: h.missingScopes ?? [],
    });
  }
  return {
    needsReconnectCount: affected.length,
    channels: affected,
    missingScopes: [...scopes].sort(),
  };
}
