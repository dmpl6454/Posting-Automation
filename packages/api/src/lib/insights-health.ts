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
